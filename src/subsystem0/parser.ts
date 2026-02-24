// ============================================================
// Subsystem 0 — Tradovate CSV Parser
// ============================================================

import { FillEventV1 } from '../types';
import { sha256 } from '../engine/utils';

/**
 * Known Tradovate Fills CSV column mappings.
 * The parser tries multiple known column names for each field.
 */
interface RawFillRow {
  [key: string]: string;
}

interface ParseResult {
  fills: FillEventV1[];
  rejected: number;
  errors: string[];
}

/**
 * Parse a CSV string into an array of raw row objects.
 * Handles quoted fields and various line endings.
 */
export function parseCSV(csvText: string): RawFillRow[] {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = parseCSVLine(headerLine);
  const rows: RawFillRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine.trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    const row: RawFillRow = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (header) {
        row[header.trim()] = (values[j] || '').trim();
      }
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Parse a single CSV line respecting quoted fields.
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * Resolve a field value from a row, trying multiple column names.
 */
function resolveField(row: RawFillRow, names: string[]): string | undefined {
  for (const name of names) {
    const val = row[name];
    if (val !== undefined && val !== '') return val;
  }
  return undefined;
}

/**
 * Parse side from Tradovate action codes.
 * _action: 0 = Buy, 1 = Sell
 * B/S text fallback
 */
function parseSide(row: RawFillRow): 'BUY' | 'SELL' | null {
  const action = resolveField(row, ['_action', 'Action']);
  if (action === '0' || action?.toUpperCase() === 'B' || action?.toUpperCase() === 'BUY') {
    return 'BUY';
  }
  if (action === '1' || action?.toUpperCase() === 'S' || action?.toUpperCase() === 'SELL') {
    return 'SELL';
  }

  // Try B/S column
  const bs = resolveField(row, ['B/S', 'Side']);
  if (bs?.toUpperCase() === 'B' || bs?.toUpperCase() === 'BUY') return 'BUY';
  if (bs?.toUpperCase() === 'S' || bs?.toUpperCase() === 'SELL') return 'SELL';

  return null;
}

/**
 * Parse timestamp to ISO8601 UTC.
 */
function parseTimestamp(raw: string): string | null {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

/**
 * Compute the fingerprint tuple and event_id for a fill.
 * T = (account_ref, contract, timestamp_utc, side, qty, price, commission)
 * event_id = sha256(serialize(T) + "|" + occ)
 */
function computeEventId(
  accountRef: string,
  contract: string,
  timestampUtc: string,
  side: string,
  qty: number,
  price: number,
  commission: number,
  occurrenceIndex: number
): string {
  const tuple = `${accountRef}|${contract}|${timestampUtc}|${side}|${qty}|${price}|${commission}`;
  return sha256(`${tuple}|${occurrenceIndex}`);
}

/**
 * Parse Tradovate Fills CSV into canonical FillEventV1 records.
 *
 * Handles idempotency via occurrence-indexed fingerprint hashing.
 */
export function parseTradovateFills(
  csvText: string,
  accountRefOverride?: string
): ParseResult {
  const rows = parseCSV(csvText);
  const fills: FillEventV1[] = [];
  const errors: string[] = [];
  let rejected = 0;

  // Track occurrence indices for identical tuples
  const tupleCounts = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rowNum = i + 2; // +2 for 1-indexed + header row

    try {
      // Account
      const accountRaw = resolveField(row, ['Account', 'account']);
      if (!accountRaw && !accountRefOverride) {
        errors.push(`Row ${rowNum}: missing Account`);
        rejected++;
        continue;
      }
      const accountRef = accountRefOverride || sha256(accountRaw!.toLowerCase().trim());

      // Timestamp
      const tsRaw = resolveField(row, ['_timestamp', 'Timestamp', 'Time', 'Fill Time']);
      if (!tsRaw) {
        errors.push(`Row ${rowNum}: missing timestamp`);
        rejected++;
        continue;
      }
      const timestampUtc = parseTimestamp(tsRaw);
      if (!timestampUtc) {
        errors.push(`Row ${rowNum}: unparseable timestamp "${tsRaw}"`);
        rejected++;
        continue;
      }

      // Contract + instrument root
      const contract = resolveField(row, ['Contract', 'contract']);
      if (!contract) {
        errors.push(`Row ${rowNum}: missing Contract`);
        rejected++;
        continue;
      }
      const instrumentRoot = resolveField(row, ['Product', 'product']) || contract.replace(/[A-Z]\d+$/, '');

      // Side
      const side = parseSide(row);
      if (!side) {
        errors.push(`Row ${rowNum}: unparseable side`);
        rejected++;
        continue;
      }

      // Quantity
      const qtyRaw = resolveField(row, ['_qty', 'Qty', 'Quantity', 'quantity']);
      const qty = qtyRaw ? parseInt(qtyRaw, 10) : NaN;
      if (isNaN(qty) || qty <= 0) {
        errors.push(`Row ${rowNum}: invalid qty "${qtyRaw}"`);
        rejected++;
        continue;
      }

      // Price
      const priceRaw = resolveField(row, ['_price', 'Price', 'price', 'Fill Price']);
      const price = priceRaw ? parseFloat(priceRaw) : NaN;
      if (isNaN(price) || price <= 0) {
        errors.push(`Row ${rowNum}: invalid price "${priceRaw}"`);
        rejected++;
        continue;
      }

      // Commission (optional, default 0)
      const commRaw = resolveField(row, ['Commission', 'commission', 'Comm']);
      const commission = commRaw ? parseFloat(commRaw) : 0;

      // Compute fingerprint + occurrence index
      const tupleKey = `${accountRef}|${contract}|${timestampUtc}|${side}|${qty}|${price}|${isNaN(commission) ? 0 : commission}`;
      const occ = tupleCounts.get(tupleKey) || 0;
      tupleCounts.set(tupleKey, occ + 1);

      const eventId = computeEventId(
        accountRef, contract, timestampUtc, side, qty, price,
        isNaN(commission) ? 0 : commission, occ
      );

      fills.push({
        event_id: eventId,
        account_ref: accountRef,
        timestamp_utc: timestampUtc,
        instrument_root: instrumentRoot,
        contract,
        side,
        qty,
        price,
        commission: isNaN(commission) ? 0 : commission,
        off_session: false, // Set by session tagger
      });
    } catch (err) {
      errors.push(`Row ${rowNum}: unexpected error — ${err}`);
      rejected++;
    }
  }

  return { fills, rejected, errors };
}
