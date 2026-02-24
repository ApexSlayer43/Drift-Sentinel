# MVP-B Acceptance Checklist

## 1) Authentication, tenancy, and ingest authority

- [ ] Device auth uses Bearer token hash lookup.
- [ ] `account_ref` is bound from device token mapping only.
- [ ] Payload `account_ref` is ignored for ingest authority.
- [ ] Entitlement states `TRIAL` / `ACTIVE` / `EXPIRED` / `SUSPENDED` are enforced on ingest.
- [ ] **RLS tenant isolation:** Authenticated user A cannot `SELECT` rows belonging to user B (cross-tenant read fails).

## 2) Idempotency, precision, and schema invariants

- [ ] `UNIQUE(device_id,file_hash)` idempotency on ingest runs.
- [ ] `event_id` primary-key idempotency on canonical fills.
- [ ] `UNIQUE(token_hash)` on device tokens.
- [ ] `NUMERIC(18,8)` is used for `price` and `commission`.
- [ ] RLS `SELECT` policies exist per table; authenticated writes are denied; service-role writes are expected.
- [ ] UTC sessions only.

## 3) Drift engine contract checks

- [ ] Driver ordering is deterministic: points descending, onset most recent first, `rule_id` alphabetical tie-break.
- [ ] `drift_index` clamps to max 100.
- [ ] Onset continuity is preserved via `mode_instance_id = sha256(account_ref + '|' + mode + '|' + onset_utc)`.

## 4) Data stale behavior and evaluation gating

- [ ] Data stale holds last computed state and blocks re-evaluation without new fills.
- [ ] Imperative re-evaluation is forbidden unless new canonical data exists (or evaluate endpoint is removed).
- [ ] Stale-data test case passes: repeated evaluate attempt with no new fills does not create a recomputed snapshot and returns/holds last computed state.
