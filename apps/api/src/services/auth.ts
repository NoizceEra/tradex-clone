import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Db } from '../db/client.ts';

/**
 * Sign-In-With-Solana. The wallet signs a server-issued, single-use challenge; we
 * verify ed25519 server-side, then issue a short access JWT + a rotating refresh token
 * (reuse-detected by family). The signed message is deterministic from (pubkey, nonce)
 * and re-rendered server-side at verify time, so a tampered client message can't change
 * what was actually checked.
 */

const jwtKey = new TextEncoder().encode(config.jwtSecret);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function buildLoginMessage(pubkey: string, nonce: string): string {
  return [
    'PokeX wants you to sign in with your Solana account:',
    pubkey,
    '',
    'Statement: Authenticate to PokeX. This signature does not authorize any transaction or transfer of funds.',
    `Domain: ${config.authDomain}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

export function isValidPubkey(pubkey: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(pubkey);
    return true;
  } catch {
    return false;
  }
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; pubkey: string };
}

export async function createNonce(db: Db, pubkey: string): Promise<{ nonce: string; message: string }> {
  if (!isValidPubkey(pubkey)) throw new HttpError(400, 'invalid pubkey');
  const nonce = bs58.encode(randomBytes(24));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.query(`INSERT INTO auth_nonces(nonce, pubkey, expires_at) VALUES($1, $2, $3)`, [
    nonce,
    pubkey,
    expiresAt.toISOString(),
  ]);
  return { nonce, message: buildLoginMessage(pubkey, nonce) };
}

async function mintAccessToken(userId: string, pubkey: string, sid: string): Promise<string> {
  return new SignJWT({ pubkey, sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSec}s`)
    .sign(jwtKey);
}

async function createSession(db: Db, userId: string, family?: string): Promise<{ sid: string; refreshToken: string }> {
  const sid = randomUUID();
  const fam = family ?? randomUUID();
  const secret = bs58.encode(randomBytes(32));
  const expiresAt = new Date(Date.now() + config.refreshTtlSec * 1000);
  await db.query(
    `INSERT INTO sessions(id, user_id, refresh_hash, family, expires_at) VALUES($1, $2, $3, $4, $5)`,
    [sid, userId, sha256(secret), fam, expiresAt.toISOString()],
  );
  return { sid, refreshToken: `${sid}.${secret}` };
}

async function upsertUser(db: Db, pubkey: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users(id, solana_pubkey) VALUES($1, $2) ON CONFLICT(solana_pubkey) DO NOTHING`,
    [id, pubkey],
  );
  const r = await db.query<{ id: string }>(`SELECT id FROM users WHERE solana_pubkey = $1`, [pubkey]);
  return r.rows[0].id;
}

export async function verifyAndLogin(
  db: Db,
  input: { pubkey: string; message: string; signature: string },
): Promise<LoginResult> {
  const { pubkey, message, signature } = input;
  if (!isValidPubkey(pubkey)) throw new HttpError(400, 'invalid pubkey');

  const nonce = message.match(/^Nonce: (.+)$/m)?.[1];
  if (!nonce) throw new HttpError(400, 'message missing nonce');

  const row = await db.query<{ pubkey: string; used: boolean; expired: boolean }>(
    `SELECT pubkey, used, (expires_at < now()) AS expired FROM auth_nonces WHERE nonce = $1`,
    [nonce],
  );
  const n = row.rows[0];
  if (!n || n.pubkey !== pubkey || n.used || n.expired) throw new HttpError(401, 'invalid or expired nonce');

  // Verify the signature against the SERVER-rendered message (not the client's text).
  const expected = buildLoginMessage(pubkey, nonce);
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      new TextEncoder().encode(expected),
      bs58.decode(signature),
      new PublicKey(pubkey).toBytes(),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, 'signature verification failed');

  // Atomically claim the nonce (defends against replay/races).
  const claim = await db.query<{ nonce: string }>(
    `UPDATE auth_nonces SET used = true WHERE nonce = $1 AND used = false RETURNING nonce`,
    [nonce],
  );
  if (claim.rows.length === 0) throw new HttpError(401, 'nonce already used');

  const userId = await upsertUser(db, pubkey);
  const { sid, refreshToken } = await createSession(db, userId);
  const accessToken = await mintAccessToken(userId, pubkey, sid);
  return { accessToken, refreshToken, expiresIn: config.accessTtlSec, user: { id: userId, pubkey } };
}

export async function refresh(db: Db, refreshToken: string): Promise<LoginResult> {
  const [sid, secret] = refreshToken.split('.');
  if (!sid || !secret) throw new HttpError(401, 'malformed refresh token');

  const r = await db.query<{ user_id: string; refresh_hash: string; family: string; revoked: boolean; expired: boolean }>(
    `SELECT user_id, refresh_hash, family, revoked, (expires_at < now()) AS expired FROM sessions WHERE id = $1`,
    [sid],
  );
  const s = r.rows[0];
  if (!s) throw new HttpError(401, 'unknown session');

  // Reuse of a revoked session, or a wrong secret = theft signal -> revoke the whole family.
  if (s.revoked || sha256(secret) !== s.refresh_hash) {
    await db.query(`UPDATE sessions SET revoked = true WHERE family = $1`, [s.family]);
    throw new HttpError(401, 'refresh token reuse detected');
  }
  if (s.expired) throw new HttpError(401, 'refresh token expired');

  // Rotate: revoke this session, mint a new one in the same family.
  await db.query(`UPDATE sessions SET revoked = true WHERE id = $1`, [sid]);
  const u = await db.query<{ solana_pubkey: string }>(`SELECT solana_pubkey FROM users WHERE id = $1`, [s.user_id]);
  const pubkey = u.rows[0]?.solana_pubkey;
  if (!pubkey) throw new HttpError(401, 'user not found');
  const next = await createSession(db, s.user_id, s.family);
  const accessToken = await mintAccessToken(s.user_id, pubkey, next.sid);
  return { accessToken, refreshToken: next.refreshToken, expiresIn: config.accessTtlSec, user: { id: s.user_id, pubkey } };
}

export async function logout(db: Db, refreshToken: string | undefined, userId: string): Promise<void> {
  if (refreshToken) {
    const [sid] = refreshToken.split('.');
    if (sid) await db.query(`UPDATE sessions SET revoked = true WHERE id = $1 AND user_id = $2`, [sid, userId]);
  } else {
    await db.query(`UPDATE sessions SET revoked = true WHERE user_id = $1`, [userId]);
  }
}

export async function verifyAccessToken(token: string): Promise<{ userId: string; pubkey: string; sid: string }> {
  const { payload } = await jwtVerify(token, jwtKey);
  return { userId: String(payload.sub), pubkey: String(payload.pubkey), sid: String(payload.sid) };
}
