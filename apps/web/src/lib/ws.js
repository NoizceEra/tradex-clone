// Native WebSocket hub with auto-reconnect + heartbeat. Subscriptions are restored on
// reconnect. Messages are fanned out to registered listeners.
import { getAccessToken } from './api.js';

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/^http/, 'ws') + '/ws';

let socket = null;
const desired = new Set();
const listeners = new Set();
let reconnectDelay = 500;
let pingTimer = null;

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    return;
  }
  socket.onopen = () => {
    reconnectDelay = 500;
    const token = getAccessToken();
    if (token) send({ op: 'auth', token }); // authenticate before (re)subscribing private channels
    if (desired.size) send({ op: 'sub', channels: [...desired] });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ op: 'ping' }), 15000);
  };
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'pong') return;
    listeners.forEach((l) => l(msg));
  };
  socket.onclose = () => {
    clearInterval(pingTimer);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* noop */
    }
  };
}

export function ensureConnected() {
  connect();
}
export function subscribe(channels) {
  channels.forEach((c) => desired.add(c));
  connect();
  send({ op: 'sub', channels });
}
export function unsubscribe(channels) {
  channels.forEach((c) => desired.delete(c));
  send({ op: 'unsub', channels });
}
export function onMessage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Send an auth frame using the current access token (e.g. after login on an open socket). */
export function authenticate() {
  const token = getAccessToken();
  if (token) send({ op: 'auth', token });
}
