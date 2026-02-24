import crypto from 'crypto';
import { FillEventV1, Severity } from '../types';

/**
 * Compute SHA-256 hex digest of a string.
 */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Get UTC date string (YYYY-MM-DD) from an ISO timestamp.
 */
export function utcDateOf(timestampUtc: string): string {
  return timestampUtc.slice(0, 10);
}

/**
 * Get the UTC day-of-week abbreviation from an ISO timestamp.
 */
export function utcDayName(timestampUtc: string): string {
  const d = new Date(timestampUtc);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  return days[d.getUTCDay()] ?? 'Sun';
}

/**
 * Group fills by UTC date.
 */
export function groupByUtcDate(fills: FillEventV1[]): Map<string, FillEventV1[]> {
  const map = new Map<string, FillEventV1[]>();
  for (const f of fills) {
    const d = utcDateOf(f.timestamp_utc);
    const arr = map.get(d) || [];
    arr.push(f);
    map.set(d, arr);
  }
  return map;
}

/**
 * Count distinct UTC dates in a set of fills.
 */
export function distinctUtcDays(fills: FillEventV1[]): number {
  const days = new Set(fills.map(f => utcDateOf(f.timestamp_utc)));
  return days.size;
}

/**
 * Severity mapping helper.
 * Thresholds are (minCount, severity) pairs in ascending order.
 * Returns the highest severity where count >= minCount.
 */
export function severityMap(
  count: number,
  thresholds: [number, Severity][]
): Severity {
  let result: Severity = 'LOW';
  for (const [minCount, sev] of thresholds) {
    if (count >= minCount) {
      result = sev;
    }
  }
  return result;
}

/**
 * Compute anchor_key from sorted evidence event_ids.
 */
export function anchorKeyFromEvidence(evidenceEventIds: string[]): string {
  const sorted = [...evidenceEventIds].sort();
  return sha256(sorted.join('|'));
}

/**
 * Compute violation_id deterministically.
 */
export function computeViolationId(
  ruleId: string,
  accountRef: string,
  anchorKey: string
): string {
  return sha256(`${ruleId}|${accountRef}|${anchorKey}`);
}

/**
 * Deduplicate fills by event_id, preserving order.
 */
export function dedupFills(fills: FillEventV1[]): FillEventV1[] {
  const seen = new Set<string>();
  const result: FillEventV1[] = [];
  for (const f of fills) {
    if (!seen.has(f.event_id)) {
      seen.add(f.event_id);
      result.push(f);
    }
  }
  return result;
}
