import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// In-memory DB + plain logger (no pino-pretty worker) before importing app modules.
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { Keypair } = await import('@solana/web3.js');
const { buildServer } = await import('../server.ts');
const { initDb } = await import('../db/init.ts');
const { getDb, closeDb } = await import('../db/client.ts');
const { reconcile } = await import('./reconcile.ts');
const { usdc } = await import('../money.ts');
const { sign, bearer, login: loginAs } = await import('../test-helpers.ts');

await initDb();
const app = await buildServer();

const login = (kp: InstanceType<typeof Keypair>) => loginAs(app, kp);

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

test('real-funds wallet endpoints are 403 in play-money mode', async () => {
  const kp = Keypair.generate();
  const { accessToken } = await login(kp);
  for (const [method, url] of [
    ['GET', '/wallet/deposit-address'],
    ['POST', '/wallet/withdraw/nonce'],
    ['POST', '/wallet/withdraw'],
    ['GET', '/wallet/transactions'],
  ] as const) {
    const res = await app.inject({ method, url, headers: bearer(accessToken), payload: method === 'POST' ? {} : undefined });
    assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
  }
});

test('the /admin routes do not exist without an operator key', async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/withdrawals' });
  assert.equal(res.statusCode, 404); // unregistered, not just unauthorized
});

test('ledger still reconciles after auth + faucet activity', async () => {
  const report = await reconcile(await getDb());
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

after(async () => {
  await app.close();
  await closeDb();
});
