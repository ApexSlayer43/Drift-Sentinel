// ============================================================
// Subsystem 0 — UTC Session Tagging
// ============================================================

import { FillEventV1, SessionConfig } from '../types';

/**
 * Get day-of-week abbreviation for a UTC timestamp.
 */
function utcDayName(ts: string): string {
  const d = new Date(ts);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  return days[d.getUTCDay()] ?? 'Sun';
}

/**
 * Get HH:MM string from a UTC timestamp.
 */
function utcTimeStr(ts: string): string {
  const d = new Date(ts);
  const h = d.getUTCHours().toString().padStart(2, '0');
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Check if a time string (HH:MM) is within a session window.
 * Rule: start_utc <= t < end_utc (non-wrapping for MVP).
 */
function timeInRange(time: string, start: string, end: string): boolean {
  return time >= start && time < end;
}

/**
 * Determine if a fill is OFF_SESSION based on session configs.
 *
 * IN_SESSION = day_allowed AND start_utc <= t < end_utc
 * else OFF_SESSION = true
 *
 * If no sessions are configured, all fills are considered IN_SESSION.
 */
export function isOffSession(timestampUtc: string, sessions: SessionConfig[]): boolean {
  if (sessions.length === 0) return false;

  const dayName = utcDayName(timestampUtc);
  const timeStr = utcTimeStr(timestampUtc);

  for (const session of sessions) {
    const dayAllowed = session.days.includes(dayName);
    if (dayAllowed && timeInRange(timeStr, session.start_utc, session.end_utc)) {
      return false; // IN_SESSION
    }
  }

  return true; // OFF_SESSION
}

/**
 * Tag all fills with off_session status.
 * Mutates fills in-place and returns them.
 */
export function tagSessions(
  fills: FillEventV1[],
  sessions: SessionConfig[]
): FillEventV1[] {
  for (const fill of fills) {
    fill.off_session = isOffSession(fill.timestamp_utc, sessions);
  }
  return fills;
}
