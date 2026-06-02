import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.ts';
import { HttpError } from './errors.ts';
import { authRoutes } from './routes/auth.ts';
import { accountRoutes } from './routes/account.ts';
import { marketRoutes } from './routes/markets.ts';
import { orderRoutes } from './routes/orders.ts';
import { lpRoutes } from './routes/lp.ts';
import { socialRoutes } from './routes/social.ts';
import { registerWs } from './plugins/ws.ts';

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

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    // zod ValidationError (may be a different zod instance than ours, so check structurally)
    if (err && (err as { name?: string }).name === 'ZodError') {
      return reply.code(400).send({ error: 'validation failed', issues: (err as { issues?: unknown }).issues });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'pokex-api',
    env: config.env,
    realFunds: config.realFunds,
    time: new Date().toISOString(),
  }));

  await registerWs(app);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(marketRoutes);
  await app.register(orderRoutes);
  await app.register(lpRoutes);
  await app.register(socialRoutes);

  return app;
}
