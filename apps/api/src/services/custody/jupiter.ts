import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { config } from '../../config.ts';

/**
 * Thin Jupiter v6 client (custody P1.5): swap a deposit wallet's SOL into USDC, in place.
 * The output lands on the wallet's own USDC ATA, where the regular USDC deposit path
 * detects and credits the ACTUAL proceeds — this module never touches the ledger.
 *
 * The deposit wallet pays its own swap fee from the SOL being swapped (it has SOL by
 * definition); `wrapAndUnwrapSol` lets Jupiter handle wSOL wrapping + ATA creation.
 *
 * Note: Jupiter aggregates MAINNET liquidity only — on devnet there is no route, so SOL
 * deposits stay parked (USDC deposits are unaffected). The logic is exercised by the
 * injectable-chain tests; live swaps are a mainnet dark-launch concern (P4).
 */

const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface QuoteResponse {
  error?: string;
  outAmount?: string;
}

export async function swapSolToUsdcViaJupiter(conn: Connection, from: Keypair, lamports: bigint): Promise<string> {
  const quoteUrl =
    `${config.jupiterBase}/v6/quote?inputMint=${SOL_MINT}&outputMint=${config.usdcMint}` +
    `&amount=${lamports.toString()}&slippageBps=${config.swapSlippageBps}`;
  const quote = (await (await fetch(quoteUrl)).json()) as QuoteResponse;
  if (!quote || quote.error || !quote.outAmount) {
    throw new Error(`jupiter quote failed: ${quote?.error ?? 'no route'}`);
  }

  const swapRes = (await (
    await fetch(`${config.jupiterBase}/v6/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: from.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    })
  ).json()) as { swapTransaction?: string; error?: string };
  if (!swapRes.swapTransaction) {
    throw new Error(`jupiter swap build failed: ${swapRes.error ?? 'no transaction returned'}`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
  tx.sign([from]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  const bh = await conn.getLatestBlockhash('finalized');
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'finalized');
  return sig;
}
