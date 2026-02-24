import { FillEventV1, UserConfig, Violation, DriftMode, Severity } from '../types';

/**
 * Internal representation of a mode evaluation result before
 * violation_id is computed.
 */
export interface ModeResult {
  mode: DriftMode;
  rule_id: 'OVERSIZE_V1' | 'OFF_SESSION_V1' | 'FREQUENCY_V1' | 'BASELINE_SHIFT_V1';
  severity: Severity;
  points: number;
  evidence_fills: FillEventV1[];
  /** For FREQUENCY: the UTC date string; for others: undefined */
  anchor_date?: string;
}

export interface EvaluationInput {
  scoring_window: FillEventV1[];
  baseline_window: FillEventV1[];
  config: UserConfig;
  account_ref: string;
}

export interface EvaluationOutput {
  violations: Violation[];
  drift_index: number;
  drift_state: 'Stable' | 'Drift forming' | 'Compromised' | 'Breakdown';
  total_points: number;
  baseline_status: 'ready' | 'building';
}
