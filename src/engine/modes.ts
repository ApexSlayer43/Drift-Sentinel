// ============================================================
// Drift Engine — Mode Evaluators (A–D)
// ============================================================

import { FillEventV1, UserConfig } from '../types';
import { ModeResult } from './types';
import { groupByUtcDate, distinctUtcDays, severityMap, dedupFills } from './utils';
import { WindowMetrics, BaselineShiftTrigger } from '../types';

// ============================================================
// Mode A — OVERSIZE
// ============================================================

export function evaluateOversize(
  scoringWindow: FillEventV1[],
  config: UserConfig
): ModeResult | null {
  const oversizeFills = scoringWindow.filter(f => f.qty > config.max_contracts);
  if (oversizeFills.length === 0) return null;

  // Points: 12 per oversize fill, capped at 36 per day
  let points = 0;
  const byDay = groupByUtcDate(oversizeFills);
  for (const [, dayFills] of byDay) {
    points += Math.min(dayFills.length * 12, 36);
  }

  // Severity based on raw count (uncapped)
  const severity = severityMap(oversizeFills.length, [
    [1, 'MED'],
    [2, 'HIGH'],
    [4, 'CRITICAL'],
  ]);

  return {
    mode: 'OVERSIZE',
    rule_id: 'OVERSIZE_V1',
    severity,
    points,
    evidence_fills: oversizeFills,
  };
}

// ============================================================
// Mode B — OFF_SESSION
// ============================================================

export function evaluateOffSession(
  scoringWindow: FillEventV1[]
): ModeResult | null {
  const offFills = scoringWindow.filter(f => f.off_session);
  if (offFills.length === 0) return null;

  // Points: 8 per off-session fill, capped at 24 per day
  let points = 0;
  const byDay = groupByUtcDate(offFills);
  for (const [, dayFills] of byDay) {
    points += Math.min(dayFills.length * 8, 24);
  }

  // Severity based on raw count (uncapped)
  const severity = severityMap(offFills.length, [
    [1, 'LOW'],
    [2, 'MED'],
    [4, 'HIGH'],
  ]);

  return {
    mode: 'OFF_SESSION',
    rule_id: 'OFF_SESSION_V1',
    severity,
    points,
    evidence_fills: offFills,
  };
}

// ============================================================
// Mode C — FREQUENCY (per UTC day within scoring window)
// ============================================================

export function evaluateFrequency(
  scoringWindow: FillEventV1[],
  config: UserConfig
): ModeResult[] {
  const results: ModeResult[] = [];
  const byDay = groupByUtcDate(scoringWindow);

  for (const [day, dayFills] of byDay) {
    const extra = dayFills.length - config.max_fills_per_day;
    if (extra <= 0) continue;

    const points = Math.min(10 + 2 * extra, 30);

    const severity = severityMap(extra, [
      [1, 'MED'],
      [2, 'HIGH'],
      [4, 'CRITICAL'],
    ]);

    results.push({
      mode: 'FREQUENCY',
      rule_id: 'FREQUENCY_V1',
      severity,
      points,
      evidence_fills: dayFills,
      anchor_date: day,
    });
  }

  return results;
}

// ============================================================
// Mode D — BASELINE_SHIFT
// ============================================================

export function computeWindowMetrics(fills: FillEventV1[]): WindowMetrics {
  if (fills.length === 0) {
    return { avg_qty: 0, off_session_rate: 0, fills_per_day_avg: 0 };
  }

  const avg_qty = fills.reduce((sum, f) => sum + f.qty, 0) / fills.length;
  const off_session_rate = fills.filter(f => f.off_session).length / fills.length;
  const numDays = distinctUtcDays(fills);
  const fills_per_day_avg = numDays > 0 ? fills.length / numDays : fills.length;

  return { avg_qty, off_session_rate, fills_per_day_avg };
}

export function evaluateBaselineShift(
  scoringWindow: FillEventV1[],
  baselineWindow: FillEventV1[],
  config: UserConfig
): ModeResult | null {
  // Suppress if insufficient baseline history
  if (baselineWindow.length < config.baseline_window_fills) {
    return null;
  }

  const baseline = computeWindowMetrics(baselineWindow);
  const recent = computeWindowMetrics(scoringWindow);

  const triggers: BaselineShiftTrigger[] = [];
  let evidenceFills: FillEventV1[] = [];

  // Size creep: avg_qty_recent >= avg_qty_baseline * 1.5
  if (recent.avg_qty >= baseline.avg_qty * 1.5) {
    triggers.push('size_creep');
    // Top 5 largest-qty fills in recent window
    const sorted = [...scoringWindow].sort((a, b) => b.qty - a.qty);
    evidenceFills = evidenceFills.concat(sorted.slice(0, 5));
  }

  // Off-session shift: off_session_rate_recent >= off_session_rate_baseline + 0.20
  if (recent.off_session_rate >= baseline.off_session_rate + 0.20) {
    triggers.push('off_session_shift');
    evidenceFills = evidenceFills.concat(scoringWindow.filter(f => f.off_session));
  }

  // Pacing creep: fills_per_day_avg_recent >= fills_per_day_avg_baseline * 1.5
  if (recent.fills_per_day_avg >= baseline.fills_per_day_avg * 1.5) {
    triggers.push('pacing_creep');
    // Day(s) with max fills in recent window
    const byDay = groupByUtcDate(scoringWindow);
    let maxCount = 0;
    for (const [, dayFills] of byDay) {
      maxCount = Math.max(maxCount, dayFills.length);
    }
    for (const [, dayFills] of byDay) {
      if (dayFills.length === maxCount) {
        evidenceFills = evidenceFills.concat(dayFills);
      }
    }
  }

  if (triggers.length === 0) return null;

  // Points: 18 base + 6 per additional trigger (max 30)
  const points = 18 + 6 * (triggers.length - 1);

  const severity = severityMap(triggers.length, [
    [1, 'MED'],
    [2, 'HIGH'],
    [3, 'CRITICAL'],
  ]);

  // Dedup and cap evidence at 25
  evidenceFills = dedupFills(evidenceFills);
  if (evidenceFills.length > 25) {
    // Truncate by timestamp_utc ASC, tie-break event_id
    evidenceFills.sort((a, b) => {
      const cmp = a.timestamp_utc.localeCompare(b.timestamp_utc);
      return cmp !== 0 ? cmp : a.event_id.localeCompare(b.event_id);
    });
    evidenceFills = evidenceFills.slice(0, 25);
  }

  return {
    mode: 'BASELINE_SHIFT',
    rule_id: 'BASELINE_SHIFT_V1',
    severity,
    points,
    evidence_fills: evidenceFills,
  };
}
