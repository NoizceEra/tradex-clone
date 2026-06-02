import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Db, Queryer } from '../db/client.ts';
import { getOrCreateUserAccount, getOrCreateSystemAccount, getBalance, postTxn } from './ledger.ts';
import { MAX_AVAILABLE_UUSDC } from './faucet.ts';
import { usdc } from '../money.ts';

// Codes are short and human-shareable. The alphabet omits 0/O/1/I to avoid transcription errors.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;

function randomCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `POKE-${s}`;
}

/**
 * Assign a unique referral code to a user that doesn't have one yet. The UPDATE only fires when the
 * user has no code AND the candidate is free, so it's race-safe; on a collision we retry, and if the
 * user already had a code we return it. Called at signup and lazily for pre-feature accounts.
 */
export async function assignReferralCode(q: Queryer, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    let set;
    try {
      set = await q.query<{ referral_code: string }>(
        `UPDATE users SET referral_code=$1
         WHERE id=$2 AND referral_code IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE referral_code=$1)
         RETURNING referral_code`,
        [code, userId],
      );
    } catch (e) {
      // A concurrent signup can win the same candidate between our NOT EXISTS check and commit,
      // tripping uq_users_referral_code (the only unique index on this UPDATE) — just retry.
      if ((e as { code?: string })?.code === '23505') continue;
      throw e;
    }
    if (set.rows[0]) return set.rows[0].referral_code;
    // Either the user already had a code, or the candidate collided — if it's the former, return it.
    const cur = await q.query<{ referral_code: string | null }>(`SELECT referral_code FROM users WHERE id=$1`, [userId]);
    if (cur.rows[0]?.referral_code) return cur.rows[0].referral_code;
  }
  throw new HttpError(500, 'could not allocate a referral code');
}

export async function ensureReferralCode(db: Db, userId: string): Promise<string> {
  const r = await db.query<{ referral_code: string | null }>(`SELECT referral_code FROM users WHERE id=$1`, [userId]);
  if (!r.rows[0]) throw new HttpError(404, 'user not found');
  return r.rows[0].referral_code ?? assignReferralCode(db, userId);
}

export interface ReferralInfo {
  code: string;
  referralsCount: number; // how many users this account has referred
  redeemed: boolean; // has this account redeemed someone else's code
  referredByCode: string | null;
  bonusUsd: number;
  rewardsEnabled: boolean;
}

export async function getReferralInfo(db: Db, userId: string): Promise<ReferralInfo> {
  const code = await ensureReferralCode(db, userId);
  const [cnt, me] = await Promise.all([
    db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE referred_by=$1`, [userId]),
    db.query<{ referred_by: string | null }>(`SELECT referred_by FROM users WHERE id=$1`, [userId]),
  ]);
  let referredByCode: string | null = null;
  if (me.rows[0]?.referred_by) {
    const ref = await db.query<{ referral_code: string | null }>(`SELECT referral_code FROM users WHERE id=$1`, [me.rows[0].referred_by]);
    referredByCode = ref.rows[0]?.referral_code ?? null;
  }
  return {
    code,
    referralsCount: Number(cnt.rows[0].n),
    redeemed: Boolean(me.rows[0]?.referred_by),
    referredByCode,
    bonusUsd: config.referralBonusUsd,
    rewardsEnabled: !config.realFunds && config.referralBonusUsd > 0,
  };
}

/**
 * Redeem a referral code: attribute this account to the referrer (once) and, in play-money mode,
 * credit both parties the configured bonus from FAUCET_SOURCE. The attribution UPDATE is guarded
 * by `referred_by IS NULL`, so two racing redemptions can't both win.
 */
export async function redeemReferral(db: Db, userId: string, rawCode: string): Promise<{ ok: true; bonusUsd: number; credited: boolean }> {
  const code = rawCode.trim().toUpperCase();
  const ref = await db.query<{ id: string }>(`SELECT id FROM users WHERE referral_code=$1`, [code]);
  const referrerId = ref.rows[0]?.id;
  if (!referrerId) throw new HttpError(404, 'invalid referral code');
  if (referrerId === userId) throw new HttpError(400, 'you cannot redeem your own code');

  const bonus = usdc(config.referralBonusUsd);
  const credited = !config.realFunds && bonus > 0n;

  let creditedToRedeemer = 0n;

  await db.tx(async (q) => {
    // Attribution is recorded once regardless of whether a bonus is paid (race-safe via IS NULL).
    const set = await q.query<{ id: string }>(
      `UPDATE users SET referred_by=$1, referred_at=now() WHERE id=$2 AND referred_by IS NULL RETURNING id`,
      [referrerId, userId],
    );
    if (set.rows.length === 0) throw new HttpError(400, 'you have already redeemed a referral code');

    if (!credited) return;

    // The referrer is only paid for their first N referrals (anti-farming); the redeemer is always
    // a candidate. Each leg is clamped to the per-account play-money cap, mirroring the faucet.
    const priorReferrals = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE referred_by=$1 AND id<>$2`, [referrerId, userId]);
    const payReferrer = Number(priorReferrals.rows[0].n) < config.maxReferralsPaid;
    const beneficiaries = payReferrer ? [userId, referrerId] : [userId];

    const faucet = await getOrCreateSystemAccount(q, 'FAUCET_SOURCE');
    for (const beneficiary of beneficiaries) {
      const coll = await getOrCreateUserAccount(q, beneficiary, 'USER_COLLATERAL');
      const headroom = MAX_AVAILABLE_UUSDC - (await getBalance(q, coll));
      if (headroom <= 0n) continue; // already at the play-money cap; skip this leg
      const credit = bonus < headroom ? bonus : headroom; // clamp so balance can't exceed the cap
      if (beneficiary === userId) creditedToRedeemer = credit;
      await postTxn(q, {
        reason: 'REFERRAL_BONUS',
        refType: 'user',
        refId: beneficiary,
        entries: [
          { accountId: coll, amount: credit },
          { accountId: faucet, amount: -credit },
        ],
      });
    }
  });

  return { ok: true, bonusUsd: config.referralBonusUsd, credited: creditedToRedeemer > 0n };
}
