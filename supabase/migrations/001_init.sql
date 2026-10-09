-- ==============================================================================
-- SIGNALEX V10 — Supabase Initial Schema Migration
-- ==============================================================================

-- 1. App Settings (single-row configuration with strict guardrails)
CREATE TABLE IF NOT EXISTS app_settings (
  id                    INT PRIMARY KEY DEFAULT 1,
  mode                  TEXT NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF', 'SIGNALS', 'SEMI', 'AUTO')),
  account               TEXT NOT NULL DEFAULT 'demo' CHECK (account IN ('demo', 'real')),
  trading_paused        BOOLEAN NOT NULL DEFAULT FALSE,
  pause_reason          TEXT,
  loss_streak_limit     INT NOT NULL DEFAULT 3,
  max_stake             REAL NOT NULL DEFAULT 25.0,
  stake_mode            TEXT NOT NULL DEFAULT 'fixed' CHECK (stake_mode IN ('fixed', 'percent')),
  stake_value           REAL NOT NULL DEFAULT 10.0,
  max_trades_per_day    INT NOT NULL DEFAULT 30,
  daily_loss_limit      REAL NOT NULL DEFAULT 100.0,
  min_payout_pct        INT NOT NULL DEFAULT 80,
  min_tier_for_auto     TEXT NOT NULL DEFAULT 'B',
  max_signal_age_secs   INT NOT NULL DEFAULT 3,
  max_data_age_secs     INT NOT NULL DEFAULT 120,
  trading_hours_filter  TEXT NOT NULL DEFAULT 'off' CHECK (trading_hours_filter IN ('off', 'london_ny')),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_settings_row CHECK (id = 1)
);

INSERT INTO app_settings (id, mode, account, trading_paused, loss_streak_limit, max_stake, stake_mode, stake_value, max_trades_per_day, daily_loss_limit, min_payout_pct, min_tier_for_auto, max_signal_age_secs, max_data_age_secs, trading_hours_filter)
VALUES (1, 'OFF', 'demo', FALSE, 3, 25.0, 'fixed', 10.0, 30, 100.0, 80, 'B', 3, 120, 'off')
ON CONFLICT (id) DO NOTHING;

-- 2. Signals Table
CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,
  pair          TEXT NOT NULL,
  market        TEXT NOT NULL CHECK (market IN ('forex', 'otc')),
  price_source  TEXT NOT NULL CHECK (price_source IN ('po', 'deriv')),
  direction     TEXT NOT NULL CHECK (direction IN ('CALL', 'PUT')),
  confidence    INT NOT NULL,
  tier          TEXT NOT NULL,
  quality_score INT NOT NULL,
  strategy      TEXT,
  expiry_secs   INT NOT NULL DEFAULT 60,
  session_label TEXT,
  status        TEXT NOT NULL DEFAULT 'NEW',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_pair ON signals (pair);

-- 3. Trades Table (The single honest ledger)
CREATE TABLE IF NOT EXISTS trades (
  id            TEXT PRIMARY KEY,
  signal_id     TEXT,
  account       TEXT NOT NULL CHECK (account IN ('demo', 'real')),
  source        TEXT NOT NULL CHECK (source IN ('auto', 'semi', 'manual')),
  pair          TEXT NOT NULL,
  market        TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('CALL', 'PUT')),
  stake         REAL NOT NULL,
  payout_pct    INT NOT NULL,
  expiry_secs   INT NOT NULL,
  signal_price  REAL,
  entry_price   REAL,
  exit_price    REAL,
  po_deal_id    TEXT,
  result        TEXT CHECK (result IN ('WIN', 'LOSS', 'TIE', 'UNCONFIRMED', NULL)),
  profit        REAL,
  result_source TEXT DEFAULT 'broker' CHECK (result_source IN ('broker', 'unconfirmed', 'manual', NULL)),
  shadow_result TEXT,
  signal_time   TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  confirmed_at  TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  latency_ms    INT,
  slippage      REAL,
  session_label TEXT,
  tier          TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_account ON trades (account);
CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades (closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_signal_id ON trades (signal_id);
CREATE INDEX IF NOT EXISTS idx_trades_deal_id ON trades (po_deal_id);

-- 4. Pending Confirmations (SEMI mode countdowns)
CREATE TABLE IF NOT EXISTS pending_confirmations (
  id          TEXT PRIMARY KEY,
  signal_id   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'executed', 'skipped', 'expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pending_conf_state ON pending_confirmations (state, expires_at);

-- 5. Audit Log (tamper-evident log of changes)
CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor   TEXT NOT NULL CHECK (actor IN ('user', 'engine', 'system')),
  action  TEXT NOT NULL,
  details JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);

-- 6. Tier Performance
CREATE TABLE IF NOT EXISTS tier_performance (
  tier        TEXT PRIMARY KEY,
  wins        INT DEFAULT 0,
  losses      INT DEFAULT 0,
  uses        INT DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO tier_performance (tier, wins, losses, uses)
VALUES ('A', 0, 0, 0), ('B', 0, 0, 0), ('C', 0, 0, 0)
ON CONFLICT (tier) DO NOTHING;

-- 7. Market Condition Log
CREATE TABLE IF NOT EXISTS market_condition_log (
  id          BIGSERIAL PRIMARY KEY,
  pair        TEXT,
  state       TEXT,
  risk_type   TEXT,
  confidence  INT,
  reason      TEXT,
  logged_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Kill Switch Log
CREATE TABLE IF NOT EXISTS kill_switch_log (
  id         BIGSERIAL PRIMARY KEY,
  pair       TEXT,
  reason     TEXT,
  pause_ms   INT,
  logged_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Session Log
CREATE TABLE IF NOT EXISTS session_log (
  id          BIGSERIAL PRIMARY KEY,
  session_key TEXT,
  wins        INT DEFAULT 0,
  losses      INT DEFAULT 0,
  total       INT DEFAULT 0,
  accuracy    REAL DEFAULT 0,
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ
);

-- 10. Pre-Session Table
CREATE TABLE IF NOT EXISTS pre_session (
  date_str    TEXT PRIMARY KEY,
  pairs_json  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 11. App State Key-Value Table
CREATE TABLE IF NOT EXISTS app_state (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Outbox Queue (for local reliable async sync)
CREATE TABLE IF NOT EXISTS outbox_events (
  id          BIGSERIAL PRIMARY KEY,
  topic       TEXT NOT NULL,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  retry_count INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================================================================
-- Row Level Security (RLS)
-- Enable RLS on all tables without public policies to enforce service role only
-- ==============================================================================
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tier_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_condition_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE kill_switch_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE pre_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
