import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Build the server with a tiny per-IP cap and assert the limiter actually engages (429 past the cap).
process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.RATE_LIMIT_MAX = '3';
delete process.env.RATE_LIMIT_DISABLED;

const { buildServer } = await import('../server.ts');
const app = await buildServer();

test('the global per-IP rate limit returns 429 once the cap is exceeded', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 4; i++) {
    codes.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
  }
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]); // within the cap
  assert.equal(codes[3], 429); // limited
});

after(async () => {
  await app.close();
});
