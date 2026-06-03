import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PGLITE_DIR = 'memory://';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

const { getDb, closeDb } = await import('../db/client.ts');
const { initDb } = await import('../db/init.ts');
const { postChat, listChat } = await import('./chat.ts');
const { onMessage } = await import('./bus.ts');

await initDb();
const db = await getDb();

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO users(id, solana_pubkey) VALUES($1, $2)`, [id, 'pk-' + id.slice(0, 8)]);
  return id;
}

test('chat: posts persist, list is oldest-first with a handle, and each post broadcasts', async () => {
  const u = await newUser();
  const events: unknown[] = [];
  const off = onMessage((m) => { if (m.channel === 'chat') events.push(m); });

  await postChat(db, u, '  hello world  '); // trimmed
  await postChat(db, u, 'second message');
  off();

  const msgs = await listChat(db, 50);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].body, 'hello world'); // oldest first, trimmed
  assert.equal(msgs[1].body, 'second message');
  assert.ok(msgs[0].handle.includes('…'), 'handle is a truncated pubkey');
  assert.equal(events.length, 2, 'each post broadcast on the chat channel');
});

test('chat: empty and over-length messages are rejected', async () => {
  const u = await newUser();
  await assert.rejects(postChat(db, u, '    '), /empty/);
  await assert.rejects(postChat(db, u, 'x'.repeat(281)), /too long/);
});

after(async () => {
  await closeDb();
});
