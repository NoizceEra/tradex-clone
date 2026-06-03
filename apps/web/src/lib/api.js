// Typed-ish REST client for the PokeX API. Access token lives in memory; the refresh
// token in localStorage. On a 401 we transparently refresh once and retry.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

let accessToken = null;
let refreshing = null; // in-flight refresh promise (single-flight)
const REFRESH_KEY = 'pokeX_refresh';

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}
function setTokens({ accessToken: at, refreshToken: rt }) {
  accessToken = at ?? accessToken;
  if (rt) localStorage.setItem(REFRESH_KEY, rt);
}
export function clearTokens() {
  accessToken = null;
  localStorage.removeItem(REFRESH_KEY);
}
export function hasSession() {
  return Boolean(accessToken || getRefreshToken());
}
export function getAccessToken() {
  return accessToken;
}

async function raw(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function req(path, opts = {}) {
  let res = await raw(path, opts);
  if (res.status === 401 && opts.auth && getRefreshToken()) {
    // try a single refresh + retry
    const ok = await refreshSession();
    if (ok) res = await raw(path, opts);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `request failed (${res.status})`);
  }
  return res.json();
}

// Single-flight: concurrent 401s share ONE rotation, so the rotating refresh token isn't
// presented twice (which the server would treat as reuse and revoke the whole session family).
export function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    const res = await raw('/auth/refresh', { method: 'POST', body: { refreshToken } });
    if (!res.ok) {
      clearTokens();
      return false;
    }
    setTokens(await res.json());
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// --- auth ---
export const authNonce = (pubkey) => req('/auth/nonce', { method: 'POST', body: { pubkey } });
export async function authVerify(payload) {
  const data = await req('/auth/verify', { method: 'POST', body: payload });
  setTokens(data);
  return data;
}
export const authMe = () => req('/auth/me', { auth: true });
export async function authLogout() {
  try {
    await req('/auth/logout', { method: 'POST', auth: true, body: { refreshToken: getRefreshToken() } });
  } finally {
    clearTokens();
  }
}

// --- markets ---
export const getMarkets = () => req('/markets');
export const getCandles = (id, tf) => req(`/markets/${id}/candles?tf=${encodeURIComponent(tf)}`);
export const getMarketDetails = (id) => req(`/markets/${id}/details`);

// --- account / trading ---
export const getBalance = () => req('/account/balance', { auth: true });
export const faucet = (amountUsd) => req('/faucet', { method: 'POST', auth: true, body: { amountUsd } });
export const getPositions = () => req('/positions', { auth: true });

// --- account history (trade-panel tabs) ---
export const getOrderHistory = () => req('/history/orders', { auth: true });
export const getTradeHistory = () => req('/history/trades', { auth: true });
export const getTransactionHistory = () => req('/history/transactions', { auth: true });
export const getPositionHistory = () => req('/history/positions', { auth: true });
export const openOrder = (body) => req('/orders', { method: 'POST', auth: true, body });
export const closePosition = (positionId, body) =>
  req(`/positions/${positionId}/close`, { method: 'POST', auth: true, body });

// --- social (leaderboard + referrals) ---
// Leaderboard is public; the optional Bearer (added when signed in) pins the caller's own row.
export const getLeaderboard = (limit = 100) => req(`/leaderboard?limit=${limit}`, { auth: true });
export const getReferral = () => req('/referral/me', { auth: true });
export const redeemReferral = (code) => req('/referral/redeem', { method: 'POST', auth: true, body: { code } });
export const setReferralCode = (code) => req('/referral/code', { method: 'POST', auth: true, body: { code } });

// A ?ref=CODE link is captured on first load and held until the user signs in and redeems it.
const REF_KEY = 'pokeX_ref';
export function capturePendingReferral() {
  const code = new URLSearchParams(window.location.search).get('ref');
  if (code) localStorage.setItem(REF_KEY, code.trim().toUpperCase());
}
export const getPendingReferral = () => localStorage.getItem(REF_KEY);
export const clearPendingReferral = () => localStorage.removeItem(REF_KEY);

// --- LP ---
export const getPool = () => req('/lp/pool');
export const getLpPosition = () => req('/lp/position', { auth: true });
export const lpDeposit = (amountUsd) => req('/lp/deposit', { method: 'POST', auth: true, body: { amountUsd } });
export const lpWithdraw = (shares) => req('/lp/withdraw', { method: 'POST', auth: true, body: { shares } });

export const apiConfig = { API_URL };
