/** Money helpers — micro-USDC (1 USDC = 1_000_000) as BigInt. Never floats. */

export const USDC_SCALE = 1_000_000n;

/** float USD -> micro-USDC BigInt (rounded). For inputs/tests/faucet only. */
export function usdc(n: number): bigint {
  return BigInt(Math.round(n * 1_000_000));
}

/** micro-USDC -> display string. */
export function fmtUusdc(u: bigint): string {
  return (Number(u) / 1_000_000).toFixed(2);
}

/** BigInt -> decimal string for JSON (the wire encodes micro-units as strings). */
export function s(b: bigint): string {
  return b.toString();
}
