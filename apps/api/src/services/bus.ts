import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub. The engine/oracle publish channel messages; the WebSocket hub
 * forwards them to subscribed clients. Single-process MVP — swap for Redis pub/sub
 * when the backend scales to multiple instances.
 *
 * Channel naming: public  -> "mark:{marketId}", "stats:{marketId}", "oi:{marketId}",
 *                            "funding:{marketId}"
 *                 private -> "positions:{userId}", "orders:{userId}", "balance:{userId}"
 */
export interface BusMessage {
  channel: string;
  type: string;
  data: unknown;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publish(channel: string, type: string, data: unknown): void {
  emitter.emit('msg', { channel, type, data } satisfies BusMessage);
}

export function onMessage(handler: (m: BusMessage) => void): () => void {
  emitter.on('msg', handler);
  return () => emitter.off('msg', handler);
}
