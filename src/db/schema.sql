-- ============================================================
-- Drift Sentinel — Supabase Schema (MVP-B, Merged & Hardened)
-- Run this in the Supabase SQL Editor on a FRESH database.
-- ============================================================

-- 0) Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. accounts — Ownership mapping (for RLS + multi-tenant)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.accounts (
  account_ref    TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source         TEXT NOT NULL DEFAULT 'TRADOVATE',
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_user
  ON public.accounts (user_id);

-- ============================================================
-- 2. entitlements — One row per user (replaces licenses)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.entitlements (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  trial_end  TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  limits     JSONB NOT NULL DEFAULT '{"max_accounts": 1, "max_fills_per_month": 5000}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_status_chk CHECK (
    status IN ('TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED')
  )
);

CREATE INDEX IF NOT EXISTS idx_entitlements_status
  ON public.entitlements (status);

-- ============================================================
-- 3. user_configs — Per-account drift engine config
--    Defaults match Subsystem 3 spec (section 3.0).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_configs (
  account_ref           TEXT PRIMARY KEY
                        REFERENCES public.accounts(account_ref) ON DELETE CASCADE,
  max_contracts         INTEGER NOT NULL DEFAULT 2,
  max_fills_per_day     INTEGER NOT NULL DEFAULT 5,
  baseline_window_fills INTEGER NOT NULL DEFAULT 10,
  scoring_window_fills  INTEGER NOT NULL DEFAULT 20,
  sessions_utc          JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_configs_positive_chk CHECK (
    max_contracts > 0
    AND max_fills_per_day > 0
    AND baseline_window_fills > 0
    AND scoring_window_fills > 0
  )
);

-- ============================================================
-- 4. device_tokens — Windows Helper auth
-- ============================================================
CREATE TABLE IF NOT EXISTS public.device_tokens (
  device_id      TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_ref    TEXT NOT NULL REFERENCES public.accounts(account_ref) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  last_seen_utc  TIMESTAMPTZ,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_tokens_status_chk CHECK (status IN ('ACTIVE', 'REVOKED'))
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user
  ON public.device_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_device_tokens_account
  ON public.device_tokens (account_ref);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_hash_uniq
  ON public.device_tokens (token_hash);

-- ============================================================
-- 5. ingest_runs — Upload tracking (idempotent via file_hash)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ingest_runs (
  ingest_run_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_ref       TEXT NOT NULL REFERENCES public.accounts(account_ref) ON DELETE CASCADE,
  device_id         TEXT REFERENCES public.device_tokens(device_id) ON DELETE SET NULL,
  file_name         TEXT NOT NULL,
  file_hash         TEXT,
  accepted_count    INTEGER NOT NULL DEFAULT 0,
  dup_count         INTEGER NOT NULL DEFAULT 0,
  reject_count      INTEGER NOT NULL DEFAULT 0,
  reject_summary    JSONB NOT NULL DEFAULT '{}'::jsonb,
  compute_triggered BOOLEAN NOT NULL DEFAULT false,
  started_at_utc    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at_utc  TIMESTAMPTZ,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'success', 'partial', 'failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ingest_runs_counts_chk CHECK (
    accepted_count >= 0 AND dup_count >= 0 AND reject_count >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_ingest_account
  ON public.ingest_runs (account_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingest_user
  ON public.ingest_runs (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_device_filehash_uniq
  ON public.ingest_runs (device_id, file_hash)
  WHERE file_hash IS NOT NULL;

-- ============================================================
-- 6. fills_canonical — Subsystem 0 output (idempotent by event_id)
--    Uses NUMERIC(18,8) for financial precision.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.fills_canonical (
  event_id        TEXT PRIMARY KEY,
  account_ref     TEXT NOT NULL
                  REFERENCES public.accounts(account_ref) ON DELETE CASCADE,
  ingest_run_id   UUID REFERENCES public.ingest_runs(ingest_run_id) ON DELETE SET NULL,
  timestamp_utc   TIMESTAMPTZ NOT NULL,
  instrument_root TEXT NOT NULL,
  contract        TEXT NOT NULL,
  side            TEXT NOT NULL,
  qty             INTEGER NOT NULL,
  price           NUMERIC(18,8) NOT NULL,
  commission      NUMERIC(18,8) NOT NULL DEFAULT 0,
  off_session     BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fills_side_chk  CHECK (side IN ('BUY', 'SELL')),
  CONSTRAINT fills_qty_chk   CHECK (qty > 0),
  CONSTRAINT fills_price_chk CHECK (price > 0)
);

CREATE INDEX IF NOT EXISTS idx_fills_account_ts
  ON public.fills_canonical (account_ref, timestamp_utc DESC);

CREATE INDEX IF NOT EXISTS idx_fills_account_date
  ON public.fills_canonical (account_ref, (timestamp_utc::date));

CREATE INDEX IF NOT EXISTS idx_fills_ingest_run
  ON public.fills_canonical (ingest_run_id);

CREATE INDEX IF NOT EXISTS idx_fills_contract_ts
  ON public.fills_canonical (contract, timestamp_utc DESC);

-- ============================================================
-- 7. mode_state — Drift onset tracking per mode (streak continuity)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mode_state (
  account_ref TEXT NOT NULL
              REFERENCES public.accounts(account_ref) ON DELETE CASCADE,
  mode        TEXT NOT NULL,
  state       TEXT NOT NULL,
  onset_utc   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_ref, mode),
  CONSTRAINT mode_state_state_chk CHECK (state IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT mode_state_mode_chk  CHECK (mode IN (
    'OVERSIZE', 'OFF_SESSION', 'FREQUENCY', 'BASELINE_SHIFT'
  ))
);

CREATE INDEX IF NOT EXISTS idx_mode_state_account
  ON public.mode_state (account_ref);

-- ============================================================
-- 8. violations — Subsystem 3 output
--    violation_id is deterministic: sha256(rule_id|account_ref|anchor_key)
--    mode_instance_id is streak-stable: sha256(mode|account_ref|onset_utc)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.violations (
  violation_id       TEXT PRIMARY KEY,
  mode_instance_id   TEXT NOT NULL,
  account_ref        TEXT NOT NULL
                     REFERENCES public.accounts(account_ref) ON DELETE CASCADE,
  rule_id            TEXT NOT NULL,
  mode               TEXT NOT NULL,
  severity           TEXT NOT NULL,
  points             INTEGER NOT NULL,
  first_seen_utc     TIMESTAMPTZ NOT NULL,
  window_start_utc   TIMESTAMPTZ NOT NULL,
  window_end_utc     TIMESTAMPTZ NOT NULL,
  evidence_event_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  created_at_utc     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT violations_rule_id_chk CHECK (rule_id IN (
    'OVERSIZE_V1', 'OFF_SESSION_V1', 'FREQUENCY_V1', 'BASELINE_SHIFT_V1'
  )),
  CONSTRAINT violations_mode_chk CHECK (mode IN (
    'OVERSIZE', 'OFF_SESSION', 'FREQUENCY', 'BASELINE_SHIFT'
  )),
  CONSTRAINT violations_severity_chk CHECK (severity IN (
    'LOW', 'MED', 'HIGH', 'CRITICAL'
  )),
  CONSTRAINT violations_points_chk CHECK (points >= 0)
);

CREATE INDEX IF NOT EXISTS idx_violations_account
  ON public.violations (account_ref, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_violations_mode
  ON public.violations (account_ref, mode, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_violations_mode_instance
  ON public.violations (mode_instance_id);

-- ============================================================
-- 9. drift_scores — Evaluation snapshots
--    Spec-correct 4-state model + all fields the extension needs.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.drift_scores (
  score_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_ref         TEXT NOT NULL
                      REFERENCES public.accounts(account_ref) ON DELETE CASCADE,
  drift_index         INTEGER NOT NULL,
  drift_state         TEXT NOT NULL,
  total_points        INTEGER NOT NULL,
  drivers             JSONB NOT NULL DEFAULT '[]'::jsonb,
  violation_ids       TEXT[] NOT NULL DEFAULT '{}'::text[],
  scoring_window_size INTEGER NOT NULL,
  baseline_status     TEXT NOT NULL,
  evaluated_at_utc    TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drift_scores_index_chk CHECK (
    drift_index >= 0 AND drift_index <= 100
  ),
  CONSTRAINT drift_scores_state_chk CHECK (drift_state IN (
    'STABLE', 'DRIFT_FORMING', 'COMPROMISED', 'BREAKDOWN'
  )),
  CONSTRAINT drift_scores_baseline_chk CHECK (
    baseline_status IN ('ready', 'building')
  )
);

CREATE INDEX IF NOT EXISTS idx_drift_account
  ON public.drift_scores (account_ref, evaluated_at_utc DESC);

-- ============================================================
-- 10. webhook_events — TradingView optional context markers
--     account_ref is nullable (webhooks may arrive before mapping)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.webhook_events (
  webhook_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_license_id  TEXT NOT NULL,
  account_ref      TEXT REFERENCES public.accounts(account_ref) ON DELETE SET NULL,
  event_type       TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  timestamp_utc    TIMESTAMPTZ NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlated_fill_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_event_type_chk CHECK (
    event_type IN ('SETUP_FIRED', 'CONTRACT_MODE')
  )
);

CREATE INDEX IF NOT EXISTS idx_webhook_license
  ON public.webhook_events (user_license_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_account
  ON public.webhook_events (account_ref, created_at DESC);

-- ============================================================
-- 11. Row Level Security
-- ============================================================
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fills_canonical ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mode_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drift_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 12. RLS READ policies (authenticated users only)
-- ============================================================

DROP POLICY IF EXISTS accounts_read ON public.accounts;
CREATE POLICY accounts_read
  ON public.accounts FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS entitlements_read ON public.entitlements;
CREATE POLICY entitlements_read
  ON public.entitlements FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_configs_read ON public.user_configs;
CREATE POLICY user_configs_read
  ON public.user_configs FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.account_ref = user_configs.account_ref AND a.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS device_tokens_read ON public.device_tokens;
CREATE POLICY device_tokens_read
  ON public.device_tokens FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS ingest_runs_read ON public.ingest_runs;
CREATE POLICY ingest_runs_read
  ON public.ingest_runs FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS fills_read ON public.fills_canonical;
CREATE POLICY fills_read
  ON public.fills_canonical FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.account_ref = fills_canonical.account_ref AND a.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS mode_state_read ON public.mode_state;
CREATE POLICY mode_state_read
  ON public.mode_state FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.account_ref = mode_state.account_ref AND a.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS violations_read ON public.violations;
CREATE POLICY violations_read
  ON public.violations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.account_ref = violations.account_ref AND a.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS drift_scores_read ON public.drift_scores;
CREATE POLICY drift_scores_read
  ON public.drift_scores FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.account_ref = drift_scores.account_ref AND a.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS webhook_events_read ON public.webhook_events;
CREATE POLICY webhook_events_read
  ON public.webhook_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.account_ref = webhook_events.account_ref AND a.user_id = auth.uid()
  ));

-- ============================================================
-- 13. RLS WRITE lockdown
--     Service role bypasses RLS automatically.
--     Explicit deny for authenticated/anon (defense in depth).
-- ============================================================

DROP POLICY IF EXISTS accounts_no_write ON public.accounts;
CREATE POLICY accounts_no_write ON public.accounts
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS entitlements_no_write ON public.entitlements;
CREATE POLICY entitlements_no_write ON public.entitlements
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS user_configs_no_write ON public.user_configs;
CREATE POLICY user_configs_no_write ON public.user_configs
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS device_tokens_no_write ON public.device_tokens;
CREATE POLICY device_tokens_no_write ON public.device_tokens
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS ingest_runs_no_write ON public.ingest_runs;
CREATE POLICY ingest_runs_no_write ON public.ingest_runs
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS fills_no_write ON public.fills_canonical;
CREATE POLICY fills_no_write ON public.fills_canonical
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS mode_state_no_write ON public.mode_state;
CREATE POLICY mode_state_no_write ON public.mode_state
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS violations_no_write ON public.violations;
CREATE POLICY violations_no_write ON public.violations
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS drift_scores_no_write ON public.drift_scores;
CREATE POLICY drift_scores_no_write ON public.drift_scores
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS webhook_events_no_write ON public.webhook_events;
CREATE POLICY webhook_events_no_write ON public.webhook_events
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
