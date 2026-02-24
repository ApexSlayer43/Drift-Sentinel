// ============================================================
// Drift Sentinel — Core Type Definitions
// ============================================================

// --- Subsystem 0: Canonical Fill Event ---

export interface FillEventV1 {
  event_id: string;
  source: 'tradovate';
  account_ref: string;
  timestamp_utc: string; // ISO8601 with Z
  instrument_root: string;
  contract: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  commission: number;
  off_session: boolean;
}

export interface SessionConfig {
  name: string;
  start_utc: string; // HH:MM
  end_utc: string;   // HH:MM
  days: string[];     // ["Mon","Tue",...]
}

export interface UserConfig {
  max_contracts: number;
  max_fills_per_day: number;
  baseline_window_fills: number;
  scoring_window_fills: number;
  sessions_utc: SessionConfig[];
}

export const DEFAULT_CONFIG: UserConfig = {
  max_contracts: 2,
  max_fills_per_day: 5,
  baseline_window_fills: 10,
  scoring_window_fills: 20,
  sessions_utc: [],
};

// --- Subsystem 3: Violation Model ---

export type DriftMode = 'OVERSIZE' | 'OFF_SESSION' | 'FREQUENCY' | 'BASELINE_SHIFT';

export type RuleId = 'OVERSIZE_V1' | 'OFF_SESSION_V1' | 'FREQUENCY_V1' | 'BASELINE_SHIFT_V1';

export type Severity = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';

export interface Violation {
  violation_id: string;
  account_ref: string;
  rule_id: RuleId;
  mode: DriftMode;
  severity: Severity;
  points: number;
  window_start_utc: string;
  window_end_utc: string;
  evidence_event_ids: string[];
  first_seen_utc: string;
  created_at_utc: string;
}

export type DriftState = 'Stable' | 'Drift forming' | 'Compromised' | 'Breakdown';

export interface DriftScore {
  account_ref: string;
  drift_index: number;
  drift_state: DriftState;
  total_points: number;
  drivers: DriverEntry[];
  violations: Violation[];
  scoring_window_size: number;
  baseline_status: 'ready' | 'building';
  evaluated_at_utc: string;
}

export interface DriverEntry {
  mode: DriftMode;
  rule_id: RuleId;
  points: number;
  onset_utc: string;
  evidence_count: number;
}

// --- Onset State Machine ---

export type OnsetState =
  | { status: 'INACTIVE' }
  | { status: 'ACTIVE'; onset_utc: string };

export type OnsetMap = Record<DriftMode, OnsetState>;

// --- Baseline Shift Metrics ---

export interface WindowMetrics {
  avg_qty: number;
  off_session_rate: number;
  fills_per_day_avg: number;
}

export type BaselineShiftTrigger = 'size_creep' | 'off_session_shift' | 'pacing_creep';

// --- Ingest Run ---

export interface IngestRun {
  id?: string;
  account_ref: string;
  source_file: string;
  fills_parsed: number;
  fills_new: number;
  fills_duplicate: number;
  fills_rejected: number;
  started_at_utc: string;
  completed_at_utc: string;
  status: 'success' | 'partial' | 'failed';
  error_message?: string;
}

// --- License / Entitlements (stubbed) ---

export type LicenseStatus = 'trial' | 'active' | 'expired' | 'suspended';

export interface License {
  license_id: string;
  user_id: string;
  status: LicenseStatus;
  plan: string;
  trial_ends_at?: string;
  current_period_ends_at?: string;
  max_accounts: number;
  max_fills_per_month: number;
}

// --- API Request/Response Types ---

export interface FillUploadRequest {
  account_ref: string;
  fills: FillEventV1[];
  source_file: string;
}

export interface FillUploadResponse {
  ingest_run_id: string;
  fills_new: number;
  fills_duplicate: number;
  fills_rejected: number;
}

export interface DriftQueryRequest {
  account_ref: string;
  config?: Partial<UserConfig>;
}

export interface TruthSummary {
  account_ref: string;
  total_fills: number;
  date_range: { min: string; max: string } | null;
  instruments: string[];
  contracts: string[];
  fills_per_day: Record<string, number>;
  max_qty: number;
  off_session_pct: number;
}
