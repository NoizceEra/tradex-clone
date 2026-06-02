import { SCALE, toE6, fromE6 } from '@pokex/pricing';

/** Money helpers — micro-USDC (1 USDC = 1_000_000) as BigInt. Reuses @pokex/pricing so the
 *  e6 conversion lives in exactly one place. */

export const USDC_SCALE = SCALE;

/** float USD -> micro-USDC BigInt (rounded). For inputs/tests/faucet only. */
export const usdc = toE6;

/** micro-USDC -> display string. */
export function fmtUusdc(u: bigint): string {
  return fromE6(u).toFixed(2);
}
