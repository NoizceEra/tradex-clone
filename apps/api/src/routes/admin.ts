import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { getDb } from '../db/client.ts';
import { rl } from './_ratelimit.ts';
import { lim } from './history.ts';
import {
  listWithdrawals,
  processWithdrawal,
  reverseWithdrawal,
  type WithdrawChain,
} from '../services/custody/withdrawals.ts';
import {
  treasuryState,
  freezeWithdrawals,
  unfreezeWithdrawals,
  withdrawalsFrozen,
  type TreasuryChain,
} from '../services/custody/treasury.ts';

/**
 * Operator endpoints (custody P2/P3 — see docs/ops-runbook.md). Registered ONLY when REAL_FUNDS
 * is on AND ADMIN_API_KEY is set; authenticated by a timing-safe key compare. The approve path
 * is the manual counterpart to the auto loop — it deliberately ignores the auto-approve cap
 * (explicit operator judgment IS the approval). Payout signing stays server-side: the operator
 * holds a key to these routes, never the hot-wallet secret.
 *
 * Chains are injected so tests run against fakes; production defaults are wired in server.ts.
 */
export interface AdminChains {
  withdrawChain: WithdrawChain;
  treasuryChain: TreasuryChain;
}

// async on purpose: Fastify resolves arity-2 hooks by their returned promise — a plain function
// returning undefined on the success path would leave the request hanging forever.
async function requireAdminKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const given = req.headers['x-admin-key'];
  const expected = Buffer.from(config.adminApiKey);
  const got = Buffer.from(typeof given === 'string' ? given : '');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}

export function adminRoutes(chains: AdminChains) {
  return async function routes(app: FastifyInstance): Promise<void> {
    // every /admin route: operator key + a tight per-IP cap (brute-force defense on the key)
    app.addHook('onRequest', requireAdminKey);

    // The withdrawal queue, newest first. ?status= filters (default: the actionable 'requested').
    app.get('/admin/withdrawals', rl(config.routeRateLimits.admin), async (req) => {
      const status = (req.query as { status?: string } | undefined)?.status ?? 'requested';
      const db = await getDb();
      return {
        withdrawals: await listWithdrawals(db, status, lim(req)),
        frozen: await withdrawalsFrozen(db),
      };
    });

    // Sign + broadcast one accepted withdrawal (manual approval — the cap-exempt path).
    app.post('/admin/withdrawals/:id/approve', rl(config.routeRateLimits.admin), async (req) => {
      const { id } = req.params as { id: string };
      const r = await processWithdrawal(await getDb(), chains.withdrawChain, id);
      return { id, ...r };
    });

    // Re-credit a withdrawal that provably never paid out.
    app.post('/admin/withdrawals/:id/reverse', rl(config.routeRateLimits.admin), async (req) => {
      const { id } = req.params as { id: string };
      const reason = (req.body as { reason?: string } | null)?.reason?.trim();
      if (!reason) throw new HttpError(400, 'a reason is required');
      await reverseWithdrawal(await getDb(), chains.withdrawChain, id, `operator: ${reason}`);
      return { id, status: 'reversed' };
    });

    // Manual freeze (incident response) / unfreeze (the ONLY way a freeze ever clears).
    app.post('/admin/freeze', rl(config.routeRateLimits.admin), async (req) => {
      const reason = (req.body as { reason?: string } | null)?.reason?.trim();
      if (!reason) throw new HttpError(400, 'a reason is required');
      await freezeWithdrawals(await getDb(), `operator: ${reason}`);
      return { frozen: reason };
    });
    app.post('/admin/unfreeze', rl(config.routeRateLimits.admin), async () => {
      await unfreezeWithdrawals(await getDb());
      return { frozen: null };
    });

    // Read-only treasury / proof-of-reserves state (no sweep, no freeze — GET is safe).
    app.get('/admin/treasury', rl(config.routeRateLimits.admin), async () => {
      const s = await treasuryState(await getDb(), chains.treasuryChain);
      return {
        liabilityE6: s.liabilityE6.toString(),
        hotE6: s.hotE6.toString(),
        coldE6: s.coldE6.toString(),
        unsweptE6: s.unsweptE6.toString(),
        onchainE6: s.onchainE6.toString(),
        pendingE6: s.pendingE6.toString(),
        shortfallE6: s.shortfallE6.toString(),
        breached: s.breached,
        frozen: s.frozen,
      };
    });
  };
}
