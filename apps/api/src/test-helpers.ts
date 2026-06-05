import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { Db } from './db/client.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, postTxn } from './services/ledger.ts';

/** SIWS + custody test plumbing shared by the test suites (auth, withdrawals, treasury).
 *  Transitively reads config (via ledger -> db/client) — import it AFTER setting process.env,
 *  like every other app module in a test file. */

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

export function sign(message: string, kp: Keypair): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
}

export async function login(app: FastifyInstance, kp: Keypair) {
  const pubkey = kp.publicKey.toBase58();
  const nonceRes = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { pubkey } });
  assert.equal(nonceRes.statusCode, 200, nonceRes.body);
  const { message } = nonceRes.json();
  const verifyRes = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { pubkey, message, signature: sign(message, kp) },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  return verifyRes.json() as { accessToken: string; refreshToken: string; user: { id: string; pubkey: string } };
}

/** Credit a user as if a real deposit had landed (the ledger legs only — the deposit pipeline
 *  itself is covered by custody.test.ts). */
export async function fund(db: Db, userId: string, amount: bigint): Promise<void> {
  await db.tx(async (q) => {
    const coll = await getOrCreateUserAccount(q, userId, 'USER_COLLATERAL');
    const treasury = await getOrCreateSystemAccount(q, 'TREASURY_USDC');
    await postTxn(q, {
      reason: 'DEPOSIT',
      refType: 'deposit',
      refId: `test-fund-${userId.slice(0, 8)}`,
      entries: [
        { accountId: coll, amount },
        { accountId: treasury, amount: -amount },
      ],
    });
  });
}

/** In-memory WithdrawChain: deterministic sigs, togglable broadcast failure, markable dead sigs.
 *  The sig counter is global — chain signatures are globally unique (withdrawals.onchain_sig is
 *  UNIQUE), so fakes across tests must not collide. */
let sigSeq = 0;
export function fakeWithdrawChain() {
  const chain = {
    signed: [] as { dest: string; amountE6: bigint; sig: string }[],
    broadcasts: [] as string[],
    deadSigs: new Set<string>(),
    failBroadcast: false,
    async signUsdcTransfer(dest: string, amountE6: bigint) {
      const sig = `wsig-${++sigSeq}`;
      chain.signed.push({ dest, amountE6, sig });
      return { signedTxB64: Buffer.from(JSON.stringify({ sig })).toString('base64'), sig };
    },
    async broadcast(signedTxB64: string) {
      if (chain.failBroadcast) throw new Error('simulated RPC outage');
      chain.broadcasts.push(JSON.parse(Buffer.from(signedTxB64, 'base64').toString()).sig);
    },
    async sigStatus(sig: string): Promise<'confirmed' | 'pending' | 'dead'> {
      if (chain.broadcasts.includes(sig)) return 'confirmed';
      return chain.deadSigs.has(sig) ? 'dead' : 'pending';
    },
  };
  return chain;
}
