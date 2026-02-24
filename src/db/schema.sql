-- ============================================================
-- Drift Sentinel — Supabase Schema (MVP-B)
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. fills_canonical — Subsystem 0 output
-- ============================================================
CREATE TABLE IF NOT EXISTS fills_canonical (
  event_id       TEXT PRIMARY KEY,
  source         TEXT NOT NULL DEFAULT 'tradovate',
  account_ref    TEXT NOT NULL,
  timestamp_utc  TIMESTAMPTZ NOT NULL,
  instrument_root TEXT NOT NULL,
  contract       TEXT NOT NULL,
  side           TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty            INTEGER NOT NULL CHECK (qty > 0),
  price          DOUBLE PRECISION NOT NULL CHECK (price > 0),
  commission     DOUBLE PRECISION NOT NULL DEFAULT 0,
  off_session    BOOLEAN NOT NULL DEFAULT false,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fills_account_ts
  ON fills_canonical (account_ref, timestamp_utc);

CREATE INDEX IF NOT EXISTS idx_fills_account_date
  ON fills_canonical (account_ref, (timestamp_utc::date));

-- ============================================================
-- 2. ingest_runs — Upload tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_ref     TEXT NOT NULL,
  source_file     TEXT NOT NULL,
  fills_parsed    INTEGER NOT NULL DEFAULT 0,
  fills_new       INTEGER NOT NULL DEFAULT 0,
  fills_duplicate INTEGER NOT NULL DEFAULT 0,
  fills_rejected  INTEGER NOT NULL DEFAULT 0,
  started_at_utc  TIMESTAMPTZ NOT NULL,
  completed_at_utc TIMESTAMPTZ,
  status          TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_account
  ON ingest_runs (account_ref, created_at DESC);

-- ============================================================
-- 3. violations — Subsystem 3 output
-- ============================================================
CREATE TABLE IF NOT EXISTS violations (
  violation_id      TEXT PRIMARY KEY,
  account_ref       TEXT NOT NULL,
  rule_id           TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('OVERSIZE', 'OFF_SESSION', 'FREQUENCY', 'BASELINE_SHIFT')),
  severity          TEXT NOT NULL CHECK (severity IN ('LOW', 'MED', 'HIGH', 'CRITICAL')),
  points            INTEGER NOT NULL,
  window_start_utc  TIMESTAMPTZ NOT NULL,
  window_end_utc    TIMESTAMPTZ NOT NULL,
  evidence_event_ids TEXT[] NOT NULL,
  first_seen_utc    TIMESTAMPTZ NOT NULL,
  created_at_utc    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_violations_account
  ON violations (account_ref, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_violations_mode
  ON violations (account_ref, mode, created_at_utc DESC);

-- ============================================================
-- 4. drift_scores — Evaluation snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS drift_scores (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_ref       TEXT NOT NULL,
  drift_index       INTEGER NOT NULL CHECK (drift_index >= 0 AND drift_index <= 100),
  drift_state       TEXT NOT NULL CHECK (drift_state IN ('Stable', 'Drift forming', 'Compromised', 'Breakdown')),
  total_points      INTEGER NOT NULL,
  drivers           JSONB NOT NULL DEFAULT '[]',
  violation_ids     TEXT[] NOT NULL DEFAULT '{}',
  scoring_window_size INTEGER NOT NULL,
  baseline_status   TEXT NOT NULL CHECK (baseline_status IN ('ready', 'building')),
  evaluated_at_utc  TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drift_account
  ON drift_scores (account_ref, evaluated_at_utc DESC);

-- ============================================================
-- 5. webhook_events — TradingView optional context
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_license_id TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  timestamp_utc   TIMESTAMPTZ NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  correlated_fill_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_license
  ON webhook_events (user_license_id, created_at DESC);

-- ============================================================
-- 6. onset_state — Drift onset tracking per mode
-- ============================================================
CREATE TABLE IF NOT EXISTS onset_state (
  account_ref     TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('OVERSIZE', 'OFF_SESSION', 'FREQUENCY', 'BASELINE_SHIFT')),
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  onset_utc       TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_ref, mode)
);

-- ============================================================
-- 7. licenses — Entitlement stubs (MVP)
-- ============================================================
CREATE TABLE IF NOT EXISTS licenses (
  license_id            TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('trial', 'active', 'expired', 'suspended')),
  plan                  TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at         TIMESTAMPTZ,
  current_period_ends_at TIMESTAMPTZ,
  max_accounts          INTEGER NOT NULL DEFAULT 1,
  max_fills_per_month   INTEGER NOT NULL DEFAULT 5000,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_licenses_user
  ON licenses (user_id);

-- ============================================================
-- 8. user_configs — Per-account drift engine config
-- ============================================================
CREATE TABLE IF NOT EXISTS user_configs (
  account_ref            TEXT PRIMARY KEY,
  max_contracts          INTEGER NOT NULL DEFAULT 2,
  max_fills_per_day      INTEGER NOT NULL DEFAULT 5,
  baseline_window_fills  INTEGER NOT NULL DEFAULT 10,
  scoring_window_fills   INTEGER NOT NULL DEFAULT 20,
  sessions_utc           JSONB NOT NULL DEFAULT '[]',
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Row Level Security (prep for multi-tenant)
-- ============================================================
ALTER TABLE fills_canonical ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE drift_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE onset_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_configs ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so backend access works.
-- Browser/extension access will need per-user policies (added later).
