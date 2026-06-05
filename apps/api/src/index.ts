import { buildServer } from './server.ts';
import { initDb } from './db/init.ts';
import { ingest } from './services/oracle.ts';
import { accrueFunding } from './services/funding.ts';
import { liquidateEligible, haltStaleMarkets } from './services/engine.ts';
import { scanDeposits } from './services/custody/deposits.ts';
import { solanaDepositChain } from './services/custody/solana.ts';
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

/** Real-funds only (custody P1): poll deposit addresses, sweep + credit new USDC. */
function startDepositScanner(db: Db, log: FastifyBaseLogger) {
  const chain = solanaDepositChain();
  const run = () =>
    scanDeposits(db, chain, log)
      .then((r) => {
        if (r.credited > 0) log.info(r, 'deposits credited');
      })
      .catch((e) => log.error(e, 'deposit scan failed (will retry)'));
  setTimeout(run, 3000);
  setInterval(run, config.depositScanMs);
}

function startLiquidationLoop(db: Db, log: FastifyBaseLogger) {
  const run = async () => {
    try {
      const r = await db.query<{ id: string }>(`SELECT id FROM markets WHERE tradeable AND status IN ('active','reduce_only')`);
      for (const m of r.rows) await liquidateEligible(db, m.id);
      await haltStaleMarkets(db, config.oracleStaleMs);
    } catch (e) {
      log.error(e, 'liquidation sweep failed');
    }
  };
  setInterval(() => void run(), config.liquidationSweepMs);
}

async function main() {
  const db = await initDb();
  const app = await buildServer();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`PokeX api listening on :${config.port} (REAL_FUNDS=${config.realFunds})`);
    startOracleLoop(db, app.log);
    startFundingLoop(db, app.log);
    startLiquidationLoop(db, app.log);
    if (config.realFunds) startDepositScanner(db, app.log);
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
