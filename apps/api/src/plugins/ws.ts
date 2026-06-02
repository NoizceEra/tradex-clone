import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { onMessage } from '../services/bus.ts';

/** Minimal shape of the ws WebSocket we use (avoids an @types/ws dependency). */
interface Sock {
  send: (data: string) => void;
  on: (event: string, cb: (...args: any[]) => void) => void;
  readyState: number;
}

/**
 * WebSocket hub at /ws. Clients send {op:'sub'|'unsub', channels:[...]} and {op:'ping'}.
 * Server pushes {ch, type, seq, data}. Public channels (mark/stats/oi/funding) are open;
 * private channels are auth-scoped in a later task.
 */
export async function registerWs(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket: Sock) => {
    const channels = new Set<string>();
    const seq = new Map<string, number>();

    const unsub = onMessage((m) => {
      if (!channels.has(m.channel)) return;
      const n = (seq.get(m.channel) ?? 0) + 1;
      seq.set(m.channel, n);
      try {
        socket.send(JSON.stringify({ ch: m.channel, type: m.type, seq: n, data: m.data }));
      } catch {
        /* client gone */
      }
    });

    socket.on('message', (buf: Buffer) => {
      let msg: { op?: string; channels?: string[] };
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg.op === 'sub' && Array.isArray(msg.channels)) {
        for (const c of msg.channels) channels.add(c);
      } else if (msg.op === 'unsub' && Array.isArray(msg.channels)) {
        for (const c of msg.channels) channels.delete(c);
      } else if (msg.op === 'ping') {
        try {
          socket.send(JSON.stringify({ ch: '_', type: 'pong', seq: 0, data: { ts: Date.now() } }));
        } catch {
          /* noop */
        }
      }
    });

    socket.on('close', () => unsub());
    socket.on('error', () => unsub());
  });
}
