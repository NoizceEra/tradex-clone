import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// In-memory DB + plain logger (no pino-pretty worker) before importing app modules.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { Keypair } = await import('@solana/web3.js');
const nacl = (await import('tweetnacl')).default;
const bs58 = (await import('bs58')).default;
const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');

await initDb();
const app = await buildServer();

function sign(message: string, kp: InstanceType<typeof Keypair>): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
}

async function login(kp: InstanceType<typeof Keypair>) {
  const pubkey = kp.publicKey.toBase58();
  const nonceRes = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { pubkey } });
  assert.equal(nonceRes.statusCode, 200);
  const { message } = nonceRes.json();
  const verifyRes = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { pubkey, message, signature: sign(message, kp) },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  return verifyRes.json() as { accessToken: string; refreshToken: string; user: { id: string; pubkey: string } };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

before(() => {});

test('SIWS login issues tokens and /auth/me resolves the wallet', async () => {
  const kp = Keypair.generate();
  const { accessToken, user } = await login(kp);
  assert.equal(user.pubkey, kp.publicKey.toBase58());
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(accessToken) });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().pubkey, kp.publicKey.toBase58());
});

test('a bad signature is rejected', async () => {
  const kp = Keypair.generate();
  const pubkey = kp.publicKey.toBase58();
  const { message } = (await app.inject({ method: 'POST', url: '/auth/nonce', payload: { pubkey } })).json();
  const other = Keypair.generate();
  const res = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { pubkey, message, signature: sign(message, other) }, // signed by the wrong key
  });
  assert.equal(res.statusCode, 401);
});

test('faucet credits play USDC into the ledger and balance reflects it', async () => {
  const kp = Keypair.generate();
  const { accessToken } = await login(kp);

  const faucet = await app.inject({ method: 'POST', url: '/faucet', headers: bearer(accessToken), payload: {} });
  assert.equal(faucet.statusCode, 200, faucet.body);
  assert.equal(faucet.json().availableUusdc, usdc(10_000).toString());

  const bal = await app.inject({ method: 'GET', url: '/account/balance', headers: bearer(accessToken) });
  assert.equal(bal.json().availableUusdc, usdc(10_000).toString());
  assert.equal(bal.json().lockedMarginUusdc, '0');
});

test('requests without a token are 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/account/balance' });
  assert.equal(res.statusCode, 401);
});

test('refresh rotates, and reusing the old refresh token revokes the family', async () => {
  const kp = Keypair.generate();
  const { refreshToken } = await login(kp);

  const r1 = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
  assert.equal(r1.statusCode, 200, r1.body);
  const rotated = r1.json().refreshToken as string;
  assert.notEqual(rotated, refreshToken);

  // reuse the ORIGINAL (now-rotated) token -> reuse detection
  const reuse = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
  assert.equal(reuse.statusCode, 401);

  // the rotated token is now also revoked (family-wide)
  const after = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: rotated } });
  assert.equal(after.statusCode, 401);
});

test('ledger still reconciles after auth + faucet activity', async () => {
  const report = await reconcile(await getDb());
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await app.close();
  await closeDb();
});
