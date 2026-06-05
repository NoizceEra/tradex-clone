import { test } from 'node:test';
import assert from 'node:assert/strict';

// Production + a managed DATABASE_URL: reset() must refuse BEFORE touching the DB. The guard runs
// before getDb(), so no connection to the (fake) Postgres URL is ever attempted. Env is read by
// config at import time, so it's set before the dynamic import.
process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = 'postgres://user:pass@managed-db.example.com:5432/prod';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
delete process.env.ALLOW_DB_RESET;

const { reset } = await import('./reset.ts');

test('reset refuses to DROP SCHEMA on a production / managed database without ALLOW_DB_RESET', async () => {
  await assert.rejects(reset(), /refusing to DROP SCHEMA/);
});
