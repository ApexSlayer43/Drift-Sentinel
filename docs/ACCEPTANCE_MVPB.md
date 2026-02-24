# MVP-B Acceptance Checklist

## Core contract checks

- [ ] device auth via Bearer token hash lookup
- [ ] bind `account_ref` from device token only
- [ ] payload `account_ref` is ignored for ingest authority
- [ ] entitlements `TRIAL` / `ACTIVE` / `EXPIRED` / `SUSPENDED` enforced on ingest
- [ ] `UNIQUE(device_id,file_hash)` idempotency
- [ ] `event_id` PK idempotency
- [ ] RLS `SELECT` policies per table + authenticated write deny
- [ ] `NUMERIC(18,8)` for `price` / `commission`
- [ ] UTC sessions only
- [ ] data stale holds last state; no re-eval without new data

## Drift engine behavior checks

- [ ] driver ordering: points desc, onset most recent first, `rule_id` alphabetical tie-break
- [ ] `drift_index` clamps to 100 max
- [ ] onset continuity: `mode_instance_id = sha256(account_ref + '|' + mode + '|' + onset_utc)` and persists until clean eval

## Endpoint and evaluation gating checks

- [ ] forbid imperative re-eval unless new data exists (or remove evaluate endpoint)
- [ ] explicit stale-data test case: repeated evaluate attempt with no new canonical fills returns/holds last computed state and does not create recomputed snapshot
