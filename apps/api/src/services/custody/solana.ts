import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type ConfirmedSignatureInfo,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { config } from '../../config.ts';
import { swapSolToUsdcViaJupiter } from './jupiter.ts';
import type { DepositChain, InboundSol, InboundUsdc } from './deposits.ts';
import type { WithdrawChain } from './withdrawals.ts';

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

/**
 * Full signature history of `address` since the `until` signature (exclusive), newest first, by
 * paging getSignaturesForAddress backwards — plus the new `highWater` cursor for the caller to
 * persist. RPC eviction can't strand anything: the cursor only ever advances over history that
 * was actually fetched, so a backlog — or adversarial dust-spam — larger than one page is picked
 * up by pagination, and a backlog larger than MAX_PAGES (pathological) is retried from the same
 * cursor next pass.
 */
const SIG_PAGE_LIMIT = 1000; // the RPC maximum
const SIG_MAX_PAGES = 10;
async function signaturesSince(
  conn: Connection,
  addr: PublicKey,
  until: string | null,
): Promise<{ sigs: ConfirmedSignatureInfo[]; highWater: string | null }> {
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < SIG_MAX_PAGES; page++) {
    const batch = await conn.getSignaturesForAddress(
      addr,
      { limit: SIG_PAGE_LIMIT, before, until: until ?? undefined },
      'finalized',
    );
    sigs.push(...batch);
    // pagination complete: the cursor may advance to the newest sig seen (or stay when none)
    if (batch.length < SIG_PAGE_LIMIT) return { sigs, highWater: sigs[0]?.signature ?? until };
    before = batch[batch.length - 1].signature;
  }
  return { sigs, highWater: until }; // capped: never advance past unfetched history
}

export function solanaDepositChain(): DepositChain {
  const conn = new Connection(config.solanaRpcUrl, 'finalized');
  const usdcMint = new PublicKey(config.usdcMint);
  const treasury = new PublicKey(config.treasuryPubkey);

  return {
    supportsSolSwaps: config.solSwapsEnabled,

    async inboundUsdc(address: string, knownSigs: Set<string>, until: string | null) {
      const ata = getAssociatedTokenAddressSync(usdcMint, new PublicKey(address));
      const { sigs, highWater } = await signaturesSince(conn, ata, until);
      const transfers: InboundUsdc[] = [];
      for (const s of [...sigs].reverse()) {
        // oldest first; skip failures and anything already recorded
        if (s.err || knownSigs.has(s.signature)) continue;
        const tx = await conn.getParsedTransaction(s.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        // A finalized sig must be fetchable; a transient RPC miss aborts the pass (cursor doesn't
        // advance, next pass retries) rather than silently skipping — a skip would strand it.
        if (!tx?.meta) throw new Error(`finalized tx ${s.signature} not fetchable (will retry)`);
        // inbound amount = the owner's USDC balance delta in this tx (owner-matched, mint-matched)
        const post = tx.meta.postTokenBalances?.find((b) => b.mint === config.usdcMint && b.owner === address);
        const pre = tx.meta.preTokenBalances?.find((b) => b.mint === config.usdcMint && b.owner === address);
        const delta = BigInt(post?.uiTokenAmount.amount ?? '0') - BigInt(pre?.uiTokenAmount.amount ?? '0');
        if (delta > 0n) transfers.push({ sig: s.signature, amountE6: delta });
      }
      return { transfers, highWater };
    },

    async inboundSol(address: string, knownSigs: Set<string>, until: string | null) {
      const pk = new PublicKey(address);
      const { sigs, highWater } = await signaturesSince(conn, pk, until);
      const transfers: InboundSol[] = [];
      for (const s of [...sigs].reverse()) {
        // oldest first; skip failures + known sigs. The wallet's own swaps/sweeps show up here
        // too but with a non-positive lamport delta, so the > 0 filter drops them.
        if (s.err || knownSigs.has(s.signature)) continue;
        const tx = await conn.getParsedTransaction(s.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        // same retry-not-skip rule as inboundUsdc — a skip under an advancing cursor would strand
        if (!tx?.meta) throw new Error(`finalized tx ${s.signature} not fetchable (will retry)`);
        const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === address);
        if (idx < 0) continue;
        const delta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);
        if (delta > 0n) transfers.push({ sig: s.signature, lamports: delta });
      }
      return { transfers, highWater };
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

/**
 * Live Solana implementation of the WithdrawChain surface (custody P2). Payouts go from the
 * hot wallet's USDC ATA to the destination (hot float topped up from the treasury — custody P3);
 * the hot wallet pays the network fee and the destination ATA's rent if it doesn't exist yet.
 */
export function solanaWithdrawChain(): WithdrawChain {
  const conn = new Connection(config.solanaRpcUrl, 'finalized');
  const usdcMint = new PublicKey(config.usdcMint);

  return {
    async signUsdcTransfer(dest: string, amountE6: bigint) {
      const hot = hotWallet();
      const destOwner = new PublicKey(dest);
      const fromAta = getAssociatedTokenAddressSync(usdcMint, hot.publicKey);
      // allowOwnerOffCurve: the user may withdraw to a program-owned address (e.g. a multisig
      // vault) — the step-up signature binds the exact destination either way.
      const toAta = getAssociatedTokenAddressSync(usdcMint, destOwner, true);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(hot.publicKey, toAta, destOwner, usdcMint),
        createTransferInstruction(fromAta, toAta, hot.publicKey, amountE6),
      );
      tx.feePayer = hot.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash('finalized')).blockhash;
      tx.sign(hot); // local signing only; the tx signature is now fixed
      return { signedTxB64: tx.serialize().toString('base64'), sig: bs58.encode(tx.signature!) };
    },

    async broadcast(signedTxB64: string) {
      const raw = Buffer.from(signedTxB64, 'base64');
      const sig = await conn.sendRawTransaction(raw);
      const bh = await conn.getLatestBlockhash('finalized');
      await conn.confirmTransaction(
        { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
        'finalized',
      );
    },

    async sigStatus(sig: string, signedTxB64: string) {
      const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (st?.confirmationStatus === 'finalized') return 'confirmed';
      // Not finalized: the tx can still land only while its blockhash is valid.
      const tx = Transaction.from(Buffer.from(signedTxB64, 'base64'));
      const valid = (await conn.isBlockhashValid(tx.recentBlockhash!, { commitment: 'finalized' })).value;
      return st || valid ? 'pending' : 'dead';
    },
  };
}
