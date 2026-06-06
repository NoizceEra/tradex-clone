import bs58 from 'bs58';
import * as api from './api.js';

/**
 * The withdrawal step-up ceremony (parallel to AuthContext.login's SIWS flow): fetch the
 * server-rendered message binding the exact (amount, dest, nonce), have the wallet sign it,
 * submit both. Keeps bs58/TextEncoder/idempotency plumbing out of components.
 */
export async function signAndSubmitWithdrawal({ amountE6, dest, signMessage }) {
  const { message } = await api.withdrawNonce(amountE6, dest);
  const sig = await signMessage(new TextEncoder().encode(message));
  return api.withdraw({
    amountE6,
    dest,
    idempotencyKey: crypto.randomUUID(),
    message,
    signature: bs58.encode(sig),
  });
}
