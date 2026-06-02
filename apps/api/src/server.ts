import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.ts';

/**
 * Build the Fastify instance. Routes for auth/markets/orders/account/lp and the
 * WebSocket hub are registered here in later tasks; for now it boots with health.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.env === 'production' ? 'info' : 'debug',
      transport:
        config.env === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'pokex-api',
    env: config.env,
    realFunds: config.realFunds,
    time: new Date().toISOString(),
  }));

  return app;
}
