-- PokeX schema. Money is BIGINT micro-USDC (1 USDC = 1_000_000). Prices/values are
-- BIGINT micro-USD ("*_e6"). Quantities are BIGINT scale-1e6 ("qty_e6"). No floats.
-- IDs are app-generated UUID text (crypto.randomUUID) to avoid extension deps.
-- Idempotent: safe to run repeatedly (CREATE ... IF NOT EXISTS).

-- =========================================================================
-- Chart of accounts + double-entry ledger (the heart of the system)
-- =========================================================================
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                       -- NULL for system accounts
  type        TEXT NOT NULL,              -- USER_COLLATERAL | USER_POSITION_MARGIN | LP_POOL | ...
  currency    TEXT NOT NULL DEFAULT 'USDC',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_user_type ON accounts(user_id, type) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_system_type ON accounts(type) WHERE user_id IS NULL;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  txn_id       TEXT NOT NULL,             -- groups the entries of one atomic operation
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  amount_uusdc BIGINT NOT NULL,           -- signed; +credit / -debit
  reason       TEXT NOT NULL,
  ref_type     TEXT,
  ref_id       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_txn ON ledger_entries(txn_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, id);

-- Materialized balance cache (verified against SUM(ledger_entries) by the reconciler).
CREATE TABLE IF NOT EXISTS balances (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id),
  amount_uusdc BIGINT NOT NULL DEFAULT 0,
  version      BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hard invariant: the entries of any txn_id must net to zero. Enforced at COMMIT
-- via a deferred constraint trigger (the engine also asserts this in app code).
CREATE OR REPLACE FUNCTION ledger_txn_balanced() RETURNS trigger AS $$
DECLARE s BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_uusdc), 0) INTO s FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'ledger txn % is unbalanced: sum=%', NEW.txn_id, s;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();

-- =========================================================================
-- Identity / auth (SIWS)
-- =========================================================================
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  solana_pubkey TEXT UNIQUE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  pubkey     TEXT NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  refresh_hash TEXT NOT NULL,
  family       TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- Markets (cards AND indices) + index composition
-- =========================================================================
CREATE TABLE IF NOT EXISTS markets (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,            -- 'card' | 'index'
  symbol             TEXT UNIQUE NOT NULL,
  display_name       TEXT NOT NULL,
  card_id            TEXT,
  variant            TEXT,
  index_slug         TEXT,
  image_small        TEXT,
  status             TEXT NOT NULL DEFAULT 'active',  -- active|reduce_only|halted|delisted
  tradeable          BOOLEAN NOT NULL DEFAULT true,
  max_leverage_e2    INT NOT NULL DEFAULT 2000,       -- 20.00x
  init_margin_bps    INT NOT NULL DEFAULT 500,        -- 5%
  maint_margin_bps   INT NOT NULL DEFAULT 250,        -- 2.5%
  max_oi_long_uusdc  BIGINT NOT NULL DEFAULT 0,
  max_oi_short_uusdc BIGINT NOT NULL DEFAULT 0,
  skew_k_e6          BIGINT NOT NULL DEFAULT 1000000, -- k = 1.0
  premium_cap_e6     BIGINT NOT NULL DEFAULT 100000,  -- ±10%
  max_dev_bps        INT NOT NULL DEFAULT 1500,       -- ±15% anchor clamp
  min_qty_e6         BIGINT NOT NULL DEFAULT 10000,   -- 0.01 units
  qty_step_e6        BIGINT NOT NULL DEFAULT 10000,
  price_tick_e6      BIGINT NOT NULL DEFAULT 10000,   -- $0.01
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_markets_kind ON markets(kind, status);

CREATE TABLE IF NOT EXISTS index_constituents (
  id        TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES markets(id),
  card_id   TEXT NOT NULL,
  weight_e6 BIGINT NOT NULL,
  as_of     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_constituents_market ON index_constituents(market_id, as_of);

CREATE TABLE IF NOT EXISTS index_divisors (
  market_id    TEXT PRIMARY KEY REFERENCES markets(id),
  divisor_e6   BIGINT NOT NULL,
  base_value_e6 BIGINT NOT NULL,
  as_of        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- Oracle prints + computed marks
-- =========================================================================
CREATE TABLE IF NOT EXISTS oracle_prices (
  id                 BIGSERIAL PRIMARY KEY,
  market_id          TEXT NOT NULL REFERENCES markets(id),
  index_price_e6     BIGINT NOT NULL,
  raw_payload        JSONB,
  source_observed_at TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_accepted        BOOLEAN NOT NULL DEFAULT true,
  reject_reason      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_oracle_market_observed ON oracle_prices(market_id, source_observed_at);

CREATE TABLE IF NOT EXISTS marks (
  id             BIGSERIAL PRIMARY KEY,
  market_id      TEXT NOT NULL REFERENCES markets(id),
  mark_price_e6  BIGINT NOT NULL,
  index_price_e6 BIGINT NOT NULL,
  skew_uusdc     BIGINT NOT NULL DEFAULT 0,
  premium_e6     BIGINT NOT NULL DEFAULT 0,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marks_market ON marks(market_id, computed_at);

-- =========================================================================
-- Positions / orders / fills
-- =========================================================================
CREATE TABLE IF NOT EXISTS positions (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id),
  market_id                 TEXT NOT NULL REFERENCES markets(id),
  side                      TEXT NOT NULL,            -- long | short
  qty_e6                    BIGINT NOT NULL,
  avg_entry_e6              BIGINT NOT NULL,
  margin_uusdc              BIGINT NOT NULL,
  leverage_e2               INT NOT NULL,
  realized_pnl_uusdc        BIGINT NOT NULL DEFAULT 0,
  funding_index_snapshot_e6 BIGINT NOT NULL DEFAULT 0,
  liq_price_e6              BIGINT NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'open',  -- open|closed|liquidated
  opened_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at                 TIMESTAMPTZ,
  version                   BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_position ON positions(user_id, market_id, side) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  market_id       TEXT NOT NULL REFERENCES markets(id),
  idempotency_key TEXT NOT NULL,
  kind            TEXT NOT NULL,           -- market | reduce_only
  side            TEXT NOT NULL,
  qty_e6          BIGINT NOT NULL,
  leverage_e2     INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  reject_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idempotency is scoped per user, not global, so one user's key can't collide with another's
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_user_idem ON orders(user_id, idempotency_key);

CREATE TABLE IF NOT EXISTS fills (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id),
  position_id        TEXT NOT NULL REFERENCES positions(id),
  market_id          TEXT NOT NULL REFERENCES markets(id),
  exec_price_e6      BIGINT NOT NULL,
  qty_e6             BIGINT NOT NULL,
  fee_uusdc          BIGINT NOT NULL DEFAULT 0,
  impact_e6          BIGINT NOT NULL DEFAULT 0,
  realized_pnl_uusdc BIGINT NOT NULL DEFAULT 0,
  txn_id             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fills_position ON fills(position_id, created_at);

-- =========================================================================
-- Funding / LP pool / liquidations
-- =========================================================================
CREATE TABLE IF NOT EXISTS funding_rates (
  id                  BIGSERIAL PRIMARY KEY,
  market_id           TEXT NOT NULL REFERENCES markets(id),
  interval_start      TIMESTAMPTZ NOT NULL,
  interval_end        TIMESTAMPTZ NOT NULL,
  rate_e6             BIGINT NOT NULL,        -- signed
  skew_uusdc          BIGINT NOT NULL DEFAULT 0,
  cumulative_index_e6 BIGINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_funding_market ON funding_rates(market_id, interval_end);

CREATE TABLE IF NOT EXISTS lp_pool (
  id                    TEXT PRIMARY KEY,
  total_assets_uusdc    BIGINT NOT NULL DEFAULT 0,
  total_shares          BIGINT NOT NULL DEFAULT 0,
  reserved_for_oi_uusdc BIGINT NOT NULL DEFAULT 0,
  version               BIGINT NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lp_positions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  shares           BIGINT NOT NULL DEFAULT 0,
  cost_basis_uusdc BIGINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lp_user ON lp_positions(user_id);

CREATE TABLE IF NOT EXISTS liquidations (
  id                    TEXT PRIMARY KEY,
  position_id           TEXT NOT NULL REFERENCES positions(id),
  market_id             TEXT NOT NULL REFERENCES markets(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  trigger_mark_e6       BIGINT NOT NULL,
  closed_qty_e6         BIGINT NOT NULL,
  liquidation_fee_uusdc BIGINT NOT NULL DEFAULT 0,
  bad_debt_uusdc        BIGINT NOT NULL DEFAULT 0,
  insurance_drawn_uusdc BIGINT NOT NULL DEFAULT 0,
  socialized_uusdc      BIGINT NOT NULL DEFAULT 0,
  txn_id                TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
