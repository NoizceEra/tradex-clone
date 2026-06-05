import { randomUUID } from 'node:crypto';
import { shortenPubkey } from '@pokex/pricing';
import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';
import { publish } from './bus.ts';

const MAX_BODY = 280;

export interface ReplyContext {
  id: string;
  handle: string;
  body: string;
}
export interface ChatMessage {
  id: string;
  userId: string;
  handle: string;
  body: string;
  createdAt: string;
  replyTo: ReplyContext | null;
}

// Display name = the user's chosen chat username; falls back to a truncated pubkey (like the leaderboard).
const handleFor = (displayName: string | null, pubkey: string) => displayName || shortenPubkey(pubkey) || 'anon';

/** Recent messages, oldest-first, each with its reply context resolved. */
export async function listChat(db: Db, limit = 50): Promise<ChatMessage[]> {
  const n = Math.min(Math.max(limit, 1), 200);
  const r = await db.query<{
    id: string; user_id: string; body: string; created_at: string; dn: string | null; pk: string;
    reply_to: string | null; p_body: string | null; p_dn: string | null; p_pk: string | null;
  }>(
    `SELECT c.id, c.user_id, c.body, c.created_at, u.display_name AS dn, u.solana_pubkey AS pk,
            c.reply_to, p.body AS p_body, pu.display_name AS p_dn, pu.solana_pubkey AS p_pk
     FROM chat_messages c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN chat_messages p ON p.id = c.reply_to
     LEFT JOIN users pu ON pu.id = p.user_id
     ORDER BY c.created_at DESC, c.id DESC LIMIT $1`,
    [n],
  );
  return r.rows.reverse().map((m) => ({
    id: m.id,
    userId: m.user_id,
    handle: handleFor(m.dn, m.pk),
    body: m.body,
    createdAt: m.created_at,
    replyTo: m.reply_to ? { id: m.reply_to, handle: handleFor(m.p_dn, m.p_pk ?? ''), body: m.p_body ?? '' } : null,
  }));
}

/** Post a message (optionally a reply); persists it and broadcasts on the public `chat` channel. */
export async function postChat(db: Db, userId: string, rawBody: string, replyToId?: string | null): Promise<ChatMessage> {
  const body = rawBody.trim();
  if (!body) throw new HttpError(400, 'message is empty');
  if (body.length > MAX_BODY) throw new HttpError(400, `message too long (max ${MAX_BODY} characters)`);

  let replyTo: ReplyContext | null = null;
  if (replyToId) {
    const p = await db.query<{ id: string; body: string; dn: string | null; pk: string }>(
      `SELECT c.id, c.body, u.display_name AS dn, u.solana_pubkey AS pk
       FROM chat_messages c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [replyToId],
    );
    if (!p.rows[0]) throw new HttpError(400, 'the message you are replying to no longer exists');
    replyTo = { id: p.rows[0].id, handle: handleFor(p.rows[0].dn, p.rows[0].pk), body: p.rows[0].body };
  }

  const id = randomUUID();
  let ins;
  try {
    // Insert and fetch the poster's display name/pubkey in one round-trip (RETURNING joined to users).
    ins = await db.query<{ created_at: string; dn: string | null; pk: string }>(
      `WITH new_msg AS (
         INSERT INTO chat_messages(id, user_id, body, reply_to) VALUES($1, $2, $3, $4)
         RETURNING created_at, user_id
       )
       SELECT m.created_at, u.display_name AS dn, u.solana_pubkey AS pk
       FROM new_msg m JOIN users u ON u.id = m.user_id`,
      [id, userId, body, replyToId ?? null],
    );
  } catch (e) {
    // parent vanished between the check and the insert -> clean 400, not a 500 (defensive: no delete path today)
    if ((e as { code?: string })?.code === '23503') throw new HttpError(400, 'the message you are replying to no longer exists');
    throw e;
  }

  const msg: ChatMessage = {
    id,
    userId,
    handle: handleFor(ins.rows[0].dn, ins.rows[0].pk),
    body,
    createdAt: ins.rows[0].created_at,
    replyTo,
  };
  publish('chat', 'message', msg);
  return msg;
}

export interface Profile {
  userId: string;
  username: string | null; // the chosen display name (null if unset)
  handle: string; // what shows in chat (username or truncated pubkey)
}

export async function getProfile(db: Db, userId: string): Promise<Profile> {
  const r = await db.query<{ dn: string | null; pk: string }>(
    `SELECT display_name AS dn, solana_pubkey AS pk FROM users WHERE id = $1`,
    [userId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'user not found');
  return { userId, username: r.rows[0].dn, handle: handleFor(r.rows[0].dn, r.rows[0].pk) };
}

/**
 * Set (rename) the caller's chat username. Validated + unique case-insensitively. Renaming RESERVES
 * the freed handle (display_name_aliases) so nobody else can claim it and impersonate the original
 * owner in chat — the same anti-hijack pattern as referral codes. Uniqueness spans live names AND
 * reserved aliases; the unique index (a caught 23505) closes the race against a concurrent claim.
 */
export async function setUsername(db: Db, userId: string, rawName: string): Promise<{ username: string }> {
  const name = rawName.trim();
  if (name.length < 3 || name.length > 20 || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new HttpError(400, 'username must be 3-20 characters: letters, numbers, _ and -');
  }
  const lower = name.toLowerCase();

  return db.tx(async (q) => {
    const cur = await q.query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [userId]);
    const current = cur.rows[0]?.display_name ?? null;
    if (current === name) return { username: name }; // no-op (matches setReferralCode)

    // uniqueness spans live names AND reserved (renamed-away) aliases, excluding this user's own
    const taken = await q.query(
      `SELECT 1 FROM users WHERE lower(display_name) = $1 AND id <> $2
       UNION ALL SELECT 1 FROM display_name_aliases WHERE name_lower = $1 AND user_id <> $2`,
      [lower, userId],
    );
    if (taken.rows[0]) throw new HttpError(409, 'that username is already taken');

    // reserve the prior handle permanently so it can't be hijacked to impersonate this user
    if (current) {
      await q.query(
        `INSERT INTO display_name_aliases(name_lower, user_id) VALUES(lower($1), $2) ON CONFLICT(name_lower) DO NOTHING`,
        [current, userId],
      );
    }
    try {
      await q.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [name, userId]);
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') throw new HttpError(409, 'that username is already taken');
      throw e;
    }
    // if the new name was previously this user's reserved alias, it's now their live name again
    await q.query(`DELETE FROM display_name_aliases WHERE name_lower = $1 AND user_id = $2`, [lower, userId]);
    return { username: name };
  });
}
