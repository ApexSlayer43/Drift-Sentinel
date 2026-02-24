// ============================================================
// Drift Engine — Main Evaluation Pipeline (Subsystem 3)
// ============================================================

import {
  FillEventV1,
  UserConfig,
  Violation,
  DriftMode,
  DriftState,
  DriftScore,
  DriverEntry,
  OnsetMap,
  DEFAULT_CONFIG,
} from '../types';
import { EvaluationInput, EvaluationOutput, ModeResult } from './types';
import {
  sha256,
  anchorKeyFromEvidence,
  computeViolationId,
} from './utils';
import {
  evaluateOversize,
  evaluateOffSession,
  evaluateFrequency,
  evaluateBaselineShift,
} from './modes';

// ============================================================
// Drift state mapping
// ============================================================

function driftStateFromIndex(index: number): DriftState {
  if (index <= 20) return 'STABLE';
  if (index <= 40) return 'DRIFT_FORMING';
  if (index <= 60) return 'COMPROMISED';
  return 'BREAKDOWN';
}

// ============================================================
// Convert ModeResult → Violation
// ============================================================

/**
 * Compute mode_instance_id = sha256(mode + account_ref + onset_utc).
 * Stable for the duration of a streak, changes when mode goes inactive→active.
 */
function computeModeInstanceId(
  mode: DriftMode,
  accountRef: string,
  onsetUtc: string
): string {
  return sha256(`${mode}|${accountRef}|${onsetUtc}`);
}

function modeResultToViolation(
  result: ModeResult,
  accountRef: string,
  windowStartUtc: string,
  windowEndUtc: string,
  onsetUtc: string
): Violation {
  const evidenceIds = result.evidence_fills.map(f => f.event_id);

  // Compute anchor_key per mode
  let anchorKey: string;
  if (result.mode === 'FREQUENCY' && result.anchor_date) {
    anchorKey = result.anchor_date;
  } else if (result.mode === 'BASELINE_SHIFT') {
    // Use last event_id in the evidence (already sorted/deduped)
    const lastFill = result.evidence_fills[result.evidence_fills.length - 1];
    anchorKey = lastFill ? lastFill.event_id : '';
  } else {
    // OVERSIZE, OFF_SESSION: hash of sorted evidence
    anchorKey = anchorKeyFromEvidence(evidenceIds);
  }

  const violationId = computeViolationId(result.rule_id, accountRef, anchorKey);
  const modeInstanceId = computeModeInstanceId(result.mode, accountRef, onsetUtc);

  return {
    violation_id: violationId,
    account_ref: accountRef,
    rule_id: result.rule_id,
    mode: result.mode,
    mode_instance_id: modeInstanceId,
    severity: result.severity,
    points: result.points,
    window_start_utc: windowStartUtc,
    window_end_utc: windowEndUtc,
    evidence_event_ids: evidenceIds,
    first_seen_utc: onsetUtc,
    created_at_utc: new Date().toISOString(),
  };
}

// ============================================================
// Onset state machine
// ============================================================

export function updateOnsetState(
  currentOnset: OnsetMap,
  activeModesWithEvidence: Map<DriftMode, string> // mode → min evidence timestamp
): OnsetMap {
  const ALL_MODES: DriftMode[] = ['OVERSIZE', 'OFF_SESSION', 'FREQUENCY', 'BASELINE_SHIFT'];
  const updated: OnsetMap = { ...currentOnset };

  for (const mode of ALL_MODES) {
    const evidenceTs = activeModesWithEvidence.get(mode);

    if (evidenceTs) {
      // Mode is active this evaluation
      if (currentOnset[mode].status === 'INACTIVE') {
        // Transition: INACTIVE → ACTIVE
        updated[mode] = { status: 'ACTIVE', onset_utc: evidenceTs };
      }
      // If already ACTIVE, preserve existing onset
    } else {
      // Mode is inactive this evaluation
      updated[mode] = { status: 'INACTIVE' };
    }
  }

  return updated;
}

export function defaultOnsetMap(): OnsetMap {
  return {
    OVERSIZE: { status: 'INACTIVE' },
    OFF_SESSION: { status: 'INACTIVE' },
    FREQUENCY: { status: 'INACTIVE' },
    BASELINE_SHIFT: { status: 'INACTIVE' },
  };
}

// ============================================================
// Main evaluation function
// ============================================================

export function evaluate(input: EvaluationInput): EvaluationOutput {
  const { scoring_window, baseline_window, config, account_ref } = input;

  if (scoring_window.length === 0) {
    return {
      violations: [],
      drift_index: 0,
      drift_state: 'STABLE',
      total_points: 0,
      baseline_status: baseline_window.length < config.baseline_window_fills ? 'building' : 'ready',
    };
  }

  // Window boundaries (safe — we checked length > 0 above)
  const firstFill = scoring_window[0]!;
  const lastFill = scoring_window[scoring_window.length - 1]!;
  const windowStartUtc = firstFill.timestamp_utc;
  const windowEndUtc = lastFill.timestamp_utc;

  // Evaluate all modes
  const modeResults: ModeResult[] = [];

  const oversizeResult = evaluateOversize(scoring_window, config);
  if (oversizeResult) modeResults.push(oversizeResult);

  const offSessionResult = evaluateOffSession(scoring_window);
  if (offSessionResult) modeResults.push(offSessionResult);

  const frequencyResults = evaluateFrequency(scoring_window, config);
  modeResults.push(...frequencyResults);

  const baselineResult = evaluateBaselineShift(scoring_window, baseline_window, config);
  if (baselineResult) modeResults.push(baselineResult);

  // Determine baseline status
  const baselineStatus = baseline_window.length < config.baseline_window_fills
    ? 'building' as const
    : 'ready' as const;

  // Compute total points and drift index
  const totalPoints = modeResults.reduce((sum, r) => sum + r.points, 0);
  const driftIndex = Math.min(100, totalPoints);
  const driftState = driftStateFromIndex(driftIndex);

  // Build violations (onset_utc will be set by the caller/persistence layer)
  const violations: Violation[] = modeResults.map(r =>
    modeResultToViolation(
      r,
      account_ref,
      windowStartUtc,
      windowEndUtc,
      // Use min evidence timestamp as initial onset (caller updates from state machine)
      r.evidence_fills.length > 0 ? r.evidence_fills[0]!.timestamp_utc : windowStartUtc
    )
  );

  return {
    violations,
    drift_index: driftIndex,
    drift_state: driftState,
    total_points: totalPoints,
    baseline_status: baselineStatus,
  };
}

// ============================================================
// Full evaluation with onset tracking + driver ordering
// ============================================================

export function evaluateWithOnset(
  input: EvaluationInput,
  currentOnset: OnsetMap
): { output: EvaluationOutput; updatedOnset: OnsetMap; drivers: DriverEntry[] } {
  const output = evaluate(input);

  // Build map of active modes → min evidence timestamp
  const activeModesWithEvidence = new Map<DriftMode, string>();
  for (const v of output.violations) {
    const existing = activeModesWithEvidence.get(v.mode);
    if (!existing || v.first_seen_utc < existing) {
      activeModesWithEvidence.set(v.mode, v.first_seen_utc);
    }
  }

  // Update onset state machine
  const updatedOnset = updateOnsetState(currentOnset, activeModesWithEvidence);

  // Update violations with correct onset_utc from state machine
  for (const v of output.violations) {
    const onsetEntry = updatedOnset[v.mode];
    if (onsetEntry.status === 'ACTIVE') {
      v.first_seen_utc = onsetEntry.onset_utc;
    }
  }

  // Build drivers list (aggregate points per mode)
  const modePoints = new Map<DriftMode, { points: number; onset_utc: string; evidence_count: number }>();
  for (const v of output.violations) {
    const existing = modePoints.get(v.mode);
    if (existing) {
      existing.points += v.points;
      existing.evidence_count += v.evidence_event_ids.length;
    } else {
      const onsetEntry = updatedOnset[v.mode];
      modePoints.set(v.mode, {
        points: v.points,
        onset_utc: onsetEntry.status === 'ACTIVE' ? onsetEntry.onset_utc : v.first_seen_utc,
        evidence_count: v.evidence_event_ids.length,
      });
    }
  }

  // Rule ID mapping
  const RULE_IDS: Record<DriftMode, 'OVERSIZE_V1' | 'OFF_SESSION_V1' | 'FREQUENCY_V1' | 'BASELINE_SHIFT_V1'> = {
    OVERSIZE: 'OVERSIZE_V1',
    OFF_SESSION: 'OFF_SESSION_V1',
    FREQUENCY: 'FREQUENCY_V1',
    BASELINE_SHIFT: 'BASELINE_SHIFT_V1',
  };

  const drivers: DriverEntry[] = Array.from(modePoints.entries()).map(([mode, info]) => ({
    mode,
    rule_id: RULE_IDS[mode],
    points: info.points,
    onset_utc: info.onset_utc,
    evidence_count: info.evidence_count,
  }));

  // Sort drivers: highest points DESC, most recent onset DESC, alphabetical mode ASC
  drivers.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.onset_utc !== a.onset_utc) return b.onset_utc.localeCompare(a.onset_utc);
    return a.mode.localeCompare(b.mode);
  });

  return { output, updatedOnset, drivers };
}
