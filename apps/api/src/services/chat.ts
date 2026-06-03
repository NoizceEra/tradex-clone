import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';
import { publish } from './bus.ts';

const MAX_BODY = 280;

export interface ChatMessage {
  id: string;
  handle: string;
  body: string;
  createdAt: string;
}

// A short, stable display name derived from the wallet pubkey (matches the leaderboard's truncation).
const handleFor = (pubkey: string) => (pubkey && pubkey.length > 9 ? `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}` : pubkey || 'anon');

/** Recent messages, oldest-first for rendering. */
export async function listChat(db: Db, limit = 50): Promise<ChatMessage[]> {
  const n = Math.min(Math.max(limit, 1), 200);
  const r = await db.query<{ id: string; body: string; created_at: string; pubkey: string }>(
    `SELECT c.id, c.body, c.created_at, u.solana_pubkey AS pubkey
     FROM chat_messages c JOIN users u ON u.id = c.user_id
     ORDER BY c.created_at DESC LIMIT $1`,
    [n],
  );
  return r.rows.reverse().map((m) => ({ id: m.id, handle: handleFor(m.pubkey), body: m.body, createdAt: m.created_at }));
}

/** Post a message; persists it and broadcasts on the public `chat` channel. */
export async function postChat(db: Db, userId: string, rawBody: string): Promise<ChatMessage> {
  const body = rawBody.trim();
  if (!body) throw new HttpError(400, 'message is empty');
  if (body.length > MAX_BODY) throw new HttpError(400, `message too long (max ${MAX_BODY} characters)`);

  const id = randomUUID();
  const ins = await db.query<{ created_at: string }>(
    `INSERT INTO chat_messages(id, user_id, body) VALUES($1, $2, $3) RETURNING created_at`,
    [id, userId, body],
  );
  const u = await db.query<{ pubkey: string }>(`SELECT solana_pubkey AS pubkey FROM users WHERE id = $1`, [userId]);

  const msg: ChatMessage = { id, handle: handleFor(u.rows[0]?.pubkey ?? ''), body, createdAt: ins.rows[0].created_at };
  publish('chat', 'message', msg);
  return msg;
}
