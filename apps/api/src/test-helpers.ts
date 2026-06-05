import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/** SIWS test plumbing shared by the HTTP test suites (auth.test.ts, withdrawals.test.ts).
 *  Pure of config — safe to import before a test file sets its process.env. */

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
