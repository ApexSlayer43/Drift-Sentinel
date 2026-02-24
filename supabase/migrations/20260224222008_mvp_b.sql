-- ============================================================
-- Drift Sentinel — Supabase Schema (MVP-B, Spec-Compliant + Hardened)
-- Intended for a FRESH database (single migration).
-- ============================================================

-- 0) Extensions
create extension if not exists pgcrypto;

-- ============================================================
-- 1) accounts — ownership mapping (tenant boundary)
-- ============================================================
create table if not exists public.accounts (
  account_ref    text primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  source         text not null default 'TRADOVATE',
  created_at     timestamptz not null default now()
);

create index if not exists accounts_user_id_idx
  on public.accounts(user_id);

-- ============================================================
-- 2) entitlements — one row per user
-- ============================================================
create table if not exists public.entitlements (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  status     text not null,
  trial_end  timestamptz,
  period_end timestamptz,
  limits     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint entitlements_status_chk check (status in ('TRIAL','ACTIVE','EXPIRED','SUSPENDED'))
);

create index if not exists entitlements_status_idx
  on public.entitlements(status);

-- ============================================================
-- 3) user_configs — per-account config (UTC sessions)
-- ============================================================
create table if not exists public.user_configs (
  account_ref           text primary key references public.accounts(account_ref) on delete cascade,
  max_contracts         integer not null default 2,
  max_fills_per_day     integer not null default 5,
  baseline_window_fills integer not null default 10,
  scoring_window_fills  integer not null default 20,
  sessions_utc          jsonb not null default '[]'::jsonb,
  updated_at            timestamptz not null default now(),
  constraint user_configs_positive_chk check (
    max_contracts > 0 and
    max_fills_per_day > 0 and
    baseline_window_fills > 0 and
    scoring_window_fills > 0
  )
);

-- ============================================================
-- 4) device_tokens — helper device auth (store token_hash only)
-- ============================================================
create table if not exists public.device_tokens (
  device_id    text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  account_ref  text not null references public.accounts(account_ref) on delete cascade,
  token_hash   text not null,
  status       text not null default 'ACTIVE',
  last_seen    timestamptz,
  created_at   timestamptz not null default now(),
  constraint device_tokens_status_chk check (status in ('ACTIVE','REVOKED'))
);

create index if not exists device_tokens_user_id_idx
  on public.device_tokens(user_id);

create index if not exists device_tokens_account_ref_idx
  on public.device_tokens(account_ref);

create unique index if not exists device_tokens_token_hash_uniq
  on public.device_tokens(token_hash);

-- ============================================================
-- 5) ingest_runs — idempotent file ingestion tracking
-- ============================================================
create table if not exists public.ingest_runs (
  ingest_run_id     uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  account_ref       text not null references public.accounts(account_ref) on delete cascade,
  device_id         text not null references public.device_tokens(device_id) on delete restrict,
  file_name         text not null,
  file_hash         text not null,
  accepted_count    integer not null default 0,
  dup_count         integer not null default 0,
  reject_count      integer not null default 0,
  reject_summary    jsonb not null default '{}'::jsonb,
  compute_triggered boolean not null default false,
  created_at        timestamptz not null default now(),
  constraint ingest_runs_counts_chk check (accepted_count >= 0 and dup_count >= 0 and reject_count >= 0)
);

create index if not exists ingest_runs_account_created_idx
  on public.ingest_runs(account_ref, created_at desc);

create index if not exists ingest_runs_user_created_idx
  on public.ingest_runs(user_id, created_at desc);

-- file-level idempotency
create unique index if not exists ingest_runs_device_filehash_uniq
  on public.ingest_runs(device_id, file_hash);

-- ============================================================
-- 6) fills_canonical — Subsystem 0 output (idempotent by event_id)
-- ============================================================
create table if not exists public.fills_canonical (
  event_id        text primary key,
  account_ref     text not null references public.accounts(account_ref) on delete cascade,
  ingest_run_id   uuid not null references public.ingest_runs(ingest_run_id) on delete cascade,
  timestamp_utc   timestamptz not null,
  instrument_root text not null,
  contract        text not null,
  side            text not null,
  qty             integer not null,
  price           numeric(18,8) not null,
  commission      numeric(18,8) not null default 0,
  off_session     boolean not null default false,
  created_at      timestamptz not null default now(),
  constraint fills_side_chk check (side in ('BUY','SELL')),
  constraint fills_qty_chk check (qty > 0),
  constraint fills_price_chk check (price > 0)
);

create index if not exists fills_account_time_idx
  on public.fills_canonical(account_ref, timestamp_utc desc);

create index if not exists fills_contract_time_idx
  on public.fills_canonical(contract, timestamp_utc desc);

create index if not exists fills_ingest_run_idx
  on public.fills_canonical(ingest_run_id);

-- ============================================================
-- 7) mode_state — onset tracking per (account_ref, mode)
-- ============================================================
create table if not exists public.mode_state (
  account_ref text not null references public.accounts(account_ref) on delete cascade,
  mode        text not null,
  state       text not null,
  onset_utc   timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (account_ref, mode),
  constraint mode_state_state_chk check (state in ('INACTIVE','ACTIVE')),
  constraint mode_state_mode_chk  check (mode in ('OVERSIZE','OFF_SESSION','FREQUENCY','BASELINE_SHIFT'))
);

create index if not exists mode_state_account_idx
  on public.mode_state(account_ref);

-- ============================================================
-- 8) violations — Subsystem 3 output (snapshot IDs)
-- ============================================================
create table if not exists public.violations (
  violation_id       uuid primary key default gen_random_uuid(), -- snapshot (NOT stable)
  mode_instance_id   text not null,                               -- stable for streak continuity
  account_ref        text not null references public.accounts(account_ref) on delete cascade,
  rule_id            text not null,
  mode               text not null,
  severity           text not null,
  points             integer not null,
  first_seen_utc     timestamptz not null,
  window_start_utc   timestamptz not null,
  window_end_utc     timestamptz not null,
  evidence_event_ids text[] not null default '{}'::text[],
  created_at         timestamptz not null default now(),
  constraint violations_rule_id_chk check (rule_id in ('OVERSIZE_V1','OFF_SESSION_V1','FREQUENCY_V1','BASELINE_SHIFT_V1')),
  constraint violations_mode_chk    check (mode in ('OVERSIZE','OFF_SESSION','FREQUENCY','BASELINE_SHIFT')),
  constraint violations_severity_chk check (severity in ('LOW','MED','HIGH')),
  constraint violations_points_chk check (points >= 0)
);

create index if not exists violations_account_first_seen_idx
  on public.violations(account_ref, first_seen_utc desc);

create index if not exists violations_mode_instance_idx
  on public.violations(mode_instance_id);

-- ============================================================
-- 9) drift_scores — last computed state + stale semantics
-- ============================================================
create table if not exists public.drift_scores (
  score_id         uuid primary key default gen_random_uuid(),
  account_ref      text not null references public.accounts(account_ref) on delete cascade,
  computed_at      timestamptz not null default now(),
  window_start_utc timestamptz not null,
  window_end_utc   timestamptz not null,
  drift_index      integer not null,
  state            text not null,
  data_stale       boolean not null default false,
  top_modes        jsonb not null default '[]'::jsonb,
  constraint drift_scores_index_chk check (drift_index >= 0 and drift_index <= 100),
  constraint drift_scores_state_chk check (state in ('OK','DRIFT','DATA_STALE'))
);

create index if not exists drift_scores_account_computed_idx
  on public.drift_scores(account_ref, computed_at desc);

-- ============================================================
-- 10) webhook_events — optional TradingView context (store-only)
-- ============================================================
create table if not exists public.webhook_events (
  webhook_event_id uuid primary key default gen_random_uuid(),
  account_ref      text not null references public.accounts(account_ref) on delete cascade,
  timestamp_utc    timestamptz not null,
  event_type       text not null,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  constraint webhook_event_type_chk check (event_type in ('SETUP_FIRED','CONTRACT_MODE'))
);

create index if not exists webhook_events_account_time_idx
  on public.webhook_events(account_ref, timestamp_utc desc);

-- ============================================================
-- 11) RLS enable
-- ============================================================
alter table public.accounts       enable row level security;
alter table public.entitlements   enable row level security;
alter table public.user_configs   enable row level security;
alter table public.device_tokens  enable row level security;
alter table public.ingest_runs    enable row level security;
alter table public.fills_canonical enable row level security;
alter table public.mode_state     enable row level security;
alter table public.violations     enable row level security;
alter table public.drift_scores   enable row level security;
alter table public.webhook_events enable row level security;

-- ============================================================
-- 12) RLS READ policies (authenticated only)
-- ============================================================

drop policy if exists accounts_read on public.accounts;
create policy accounts_read
on public.accounts for select
to authenticated
using (user_id = auth.uid());

drop policy if exists entitlements_read on public.entitlements;
create policy entitlements_read
on public.entitlements for select
to authenticated
using (user_id = auth.uid());

drop policy if exists user_configs_read on public.user_configs;
create policy user_configs_read
on public.user_configs for select
to authenticated
using (
  exists (
    select 1 from public.accounts a
    where a.account_ref = user_configs.account_ref
      and a.user_id = auth.uid()
  )
);

drop policy if exists device_tokens_read on public.device_tokens;
create policy device_tokens_read
on public.device_tokens for select
to authenticated
using (user_id = auth.uid());

drop policy if exists ingest_runs_read on public.ingest_runs;
create policy ingest_runs_read
on public.ingest_runs for select
to authenticated
using (user_id = auth.uid());

drop policy if exists fills_read on public.fills_canonical;
create policy fills_read
on public.fills_canonical for select
to authenticated
using (
  exists (
    select 1 from public.accounts a
    where a.account_ref = fills_canonical.account_ref
      and a.user_id = auth.uid()
  )
);

drop policy if exists mode_state_read on public.mode_state;
create policy mode_state_read
on public.mode_state for select
to authenticated
using (
  exists (
    select 1 from public.accounts a
    where a.account_ref = mode_state.account_ref
      and a.user_id = auth.uid()
  )
);

drop policy if exists violations_read on public.violations;
create policy violations_read
on public.violations for select
to authenticated
using (
  exists (
    select 1 from public.accounts a
    where a.account_ref = violations.account_ref
      and a.user_id = auth.uid()
  )
);

drop policy if exists drift_scores_read on public.drift_scores;
create policy drift_scores_read
on public.drift_scores for select
to authenticated
using (
  exists (
    select 1 from public.accounts a
    where a.account_ref = drift_scores.account_ref
      and a.user_id = auth.uid()
  )
);

drop policy if exists webhook_events_read on public.webhook_events;
create policy webhook_events_read
on public.webhook_events for select
to authenticated
using (
  exists (
    select 1 from public.accounts a
    where a.account_ref = webhook_events.account_ref
      and a.user_id = auth.uid()
  )
);

-- ============================================================
-- 13) RLS WRITE lockdown (authenticated users)
-- Service role bypasses RLS automatically.
-- ============================================================

drop policy if exists accounts_no_write on public.accounts;
create policy accounts_no_write on public.accounts
for all to authenticated
using (false) with check (false);

drop policy if exists entitlements_no_write on public.entitlements;
create policy entitlements_no_write on public.entitlements
for all to authenticated
using (false) with check (false);

drop policy if exists user_configs_no_write on public.user_configs;
create policy user_configs_no_write on public.user_configs
for all to authenticated
using (false) with check (false);

drop policy if exists device_tokens_no_write on public.device_tokens;
create policy device_tokens_no_write on public.device_tokens
for all to authenticated
using (false) with check (false);

drop policy if exists ingest_runs_no_write on public.ingest_runs;
create policy ingest_runs_no_write on public.ingest_runs
for all to authenticated
using (false) with check (false);

drop policy if exists fills_no_write on public.fills_canonical;
create policy fills_no_write on public.fills_canonical
for all to authenticated
using (false) with check (false);

drop policy if exists mode_state_no_write on public.mode_state;
create policy mode_state_no_write on public.mode_state
for all to authenticated
using (false) with check (false);

drop policy if exists violations_no_write on public.violations;
create policy violations_no_write on public.violations
for all to authenticated
using (false) with check (false);

drop policy if exists drift_scores_no_write on public.drift_scores;
create policy drift_scores_no_write on public.drift_scores
for all to authenticated
using (false) with check (false);

drop policy if exists webhook_events_no_write on public.webhook_events;
create policy webhook_events_no_write on public.webhook_events
for all to authenticated
using (false) with check (false); 
