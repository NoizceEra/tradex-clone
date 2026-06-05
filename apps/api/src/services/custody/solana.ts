import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { config } from '../../config.ts';
import { swapSolToUsdcViaJupiter } from './jupiter.ts';
import type { DepositChain, InboundSol, InboundUsdc } from './deposits.ts';

/**
 * Live Solana implementation of the DepositChain surface (custody P1).
 * Everything reads/settles at `finalized` commitment — deposits are only credited once
 * they can no longer be rolled back.
 *
 * The hot wallet is the fee payer for sweeps: fresh deposit addresses hold no SOL, so the
 * sweep transaction (and the treasury ATA's rent, if it doesn't exist yet) is paid by the
 * hot wallet. Its secret comes from the environment (dev/devnet) — never the config object.
 */

function hotWallet(): Keypair {
  const raw = process.env.HOT_WALLET_SECRET ?? '';
  if (!raw) throw new Error('HOT_WALLET_SECRET is not set (base58 secret key or JSON byte array)');
  try {
    if (raw.trim().startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    return Keypair.fromSecretKey(bs58.decode(raw.trim()));
  } catch {
    throw new Error('HOT_WALLET_SECRET is not a valid base58 secret key or JSON byte array');
  }
}

export function solanaDepositChain(): DepositChain {
  const conn = new Connection(config.solanaRpcUrl, 'finalized');
  const usdcMint = new PublicKey(config.usdcMint);
  const treasury = new PublicKey(config.treasuryPubkey);

  return {
    async inboundUsdc(address: string, knownSigs: Set<string>): Promise<InboundUsdc[]> {
      const ata = getAssociatedTokenAddressSync(usdcMint, new PublicKey(address));
      const sigs = await conn.getSignaturesForAddress(ata, { limit: 20 }, 'finalized');
      const out: InboundUsdc[] = [];
      for (const s of sigs.reverse()) {
        // oldest first; skip failures and anything already recorded
        if (s.err || knownSigs.has(s.signature)) continue;
        const tx = await conn.getParsedTransaction(s.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta) continue;
        // inbound amount = the owner's USDC balance delta in this tx (owner-matched, mint-matched)
        const post = tx.meta.postTokenBalances?.find((b) => b.mint === config.usdcMint && b.owner === address);
        const pre = tx.meta.preTokenBalances?.find((b) => b.mint === config.usdcMint && b.owner === address);
        const delta = BigInt(post?.uiTokenAmount.amount ?? '0') - BigInt(pre?.uiTokenAmount.amount ?? '0');
        if (delta > 0n) out.push({ sig: s.signature, amountE6: delta });
      }
      return out;
    },

    async inboundSol(address: string, knownSigs: Set<string>): Promise<InboundSol[]> {
      const pk = new PublicKey(address);
      const sigs = await conn.getSignaturesForAddress(pk, { limit: 20 }, 'finalized');
      const out: InboundSol[] = [];
      for (const s of sigs.reverse()) {
        // oldest first; skip failures + known sigs. The wallet's own swaps/sweeps show up here
        // too but with a non-positive lamport delta, so the > 0 filter drops them.
        if (s.err || knownSigs.has(s.signature)) continue;
        const tx = await conn.getParsedTransaction(s.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta) continue;
        const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === address);
        if (idx < 0) continue;
        const delta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);
        if (delta > 0n) out.push({ sig: s.signature, lamports: delta });
      }
      return out;
    },

    async solBalance(address: string): Promise<bigint> {
      return BigInt(await conn.getBalance(new PublicKey(address), 'finalized'));
    },

    async swapSolToUsdc(from: Keypair, lamports: bigint): Promise<string> {
      return swapSolToUsdcViaJupiter(conn, from, lamports);
    },

    async sweepAll(from: Keypair) {
      const fromAta = getAssociatedTokenAddressSync(usdcMint, from.publicKey);
      let balance: bigint;
      try {
        balance = BigInt((await conn.getTokenAccountBalance(fromAta, 'finalized')).value.amount);
      } catch {
        return null; // ATA doesn't exist yet — nothing has ever been deposited here
      }
      if (balance <= 0n) return null;

      const payer = hotWallet();
      // allowOwnerOffCurve: the treasury may be a Squads multisig PDA
      const toAta = getAssociatedTokenAddressSync(usdcMint, treasury, true);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, toAta, treasury, usdcMint),
        createTransferInstruction(fromAta, toAta, from.publicKey, balance),
      );
      tx.feePayer = payer.publicKey;
      const sig = await sendAndConfirmTransaction(conn, tx, [payer, from], { commitment: 'finalized' });
      return { sig, amountE6: balance };
    },
  };
}
