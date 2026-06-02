import { buildServer } from './server.ts';
import { initDb } from './db/init.ts';
import { ingest } from './services/oracle.ts';
import { accrueFunding } from './services/funding.ts';
import type { Db } from './db/client.ts';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.ts';

function startOracleLoop(db: Db, log: FastifyBaseLogger) {
  const run = () =>
    ingest(db)
      .then((r) => log.info(r, 'oracle ingest complete'))
      .catch((e) => log.error(e, 'oracle ingest failed (will retry)'));
  // initial run shortly after boot, then on the configured interval
  setTimeout(run, 1500);
  setInterval(run, config.oracleRefreshMs);
}

function startFundingLoop(db: Db, log: FastifyBaseLogger) {
  const run = async () => {
    try {
      const r = await db.query<{ id: string }>(`SELECT id FROM markets WHERE tradeable AND status='active'`);
      for (const m of r.rows) await accrueFunding(db, m.id);
    } catch (e) {
      log.error(e, 'funding accrual failed');
    }
  };
  setInterval(() => void run(), config.fundingIntervalMs);
}

async function main() {
  const db = await initDb();
  const app = await buildServer();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`PokeX api listening on :${config.port} (REAL_FUNDS=${config.realFunds})`);
    startOracleLoop(db, app.log);
    startFundingLoop(db, app.log);
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
