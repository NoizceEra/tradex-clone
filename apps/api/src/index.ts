import { buildServer } from './server.ts';
import { initDb } from './db/init.ts';
import { config } from './config.ts';

async function main() {
  await initDb();
  const app = await buildServer();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`PokeX api listening on :${config.port} (REAL_FUNDS=${config.realFunds})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
