# Drift Sentinel MVP-B — Locked Normative Specification (Binding)

## 0. Status, authority, and interpretation

This document is the **binding architecture contract** for Drift Sentinel MVP-B.

- **Normative language** uses RFC-style terms: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.
- If implementation behavior conflicts with this document, this spec takes precedence for MVP-B.
- This is a **locked MVP-B** contract. Post-MVP ideas are explicitly non-binding and out of scope.

---

## 1. Core invariants (non-negotiable)

### 1.1 Non-executing product boundary
Drift Sentinel is an observational risk monitor.

- The system **MUST NOT** place, modify, cancel, route, or otherwise execute orders.
- The system **MUST NOT** automate trade actions in broker/exchange platforms.

### 1.2 No signal/alpha/advice boundary
- The system **MUST NOT** generate or present trade signals, alpha, trade recommendations, investment advice, or optimization directives.
- The system **MUST NOT** provide "best settings" or prescriptive strategy tuning.

### 1.3 Deterministic evaluation only
- Evaluation **MUST** be deterministic from canonical inputs and configuration.
- The system **MUST NOT** use inference, probabilistic model scoring, or non-deterministic decision paths for drift decisions in MVP-B.

### 1.4 Time model and sessions
- All timestamps and session logic **MUST** be UTC-based.
- Sessions **MUST** be represented and evaluated in UTC only.

### 1.5 Alert philosophy
- Alerts and derived UI state **MUST** remain low-noise, based on explicit rule violations only.
- No speculative or predictive alerting is allowed in MVP-B.

### 1.6 Data staleness is first-class
- "Data stale" **MUST** be a first-class runtime state.
- When stale, the system **MUST** hold the last computed drift state and drivers.
- The system **MUST NOT** re-evaluate drift without new canonical input data.

---

## 2. MVP-B scope (locked)

### 2.1 In-scope surfaces
- **Platform:** Windows-first operational flow.
- **Primary truth input:** Tradovate `Fills.csv` is canonical trading activity truth for MVP-B.
- **Secondary input (optional):** `Orders.csv` may be ingested as contextual metadata only.
- **Webhook input (optional):** TradingView webhook events may be accepted and stored as context markers.
- **UI surface scope:** MVP-B UI output is limited to a badge + drawer presentation of current drift state, drivers, and evidence pointers.

### 2.2 Explicit out-of-scope (post-MVP)
The following are excluded from MVP-B and are non-binding for this release:

- Broker-side trade control/automation.
- Strategy optimization assistants and recommendation engines.
- Multi-platform parity requirements beyond Windows-first baseline.
- Expanded UI beyond badge+drawer (e.g., full analytics suite/dashboard complexity).
- Any probabilistic or ML-driven drift decisioning.

---

## 3. Subsystem 0 (Locked) — Canonicalization contract

## 3.1 Canonical event model
Canonicalization output **MUST** produce `FillEventV1` records from Tradovate `Fills.csv`.

Each canonical fill event includes:
- `event_id`
- `account_ref`
- `timestamp_utc`
- `instrument_root`
- `contract`
- `side`
- `qty`
- `price`
- `commission`
- `off_session`

## 3.2 Mapping requirements
- Mapping from Tradovate `Fills.csv` to `FillEventV1` **MUST** be deterministic and total for valid rows.
- Invalid rows **MUST** be rejected with parse accounting; accepted rows **MUST** preserve financial precision contract required by Subsystem 2.

## 3.3 Idempotency key definition (locked)
For each fill row, define tuple:

- `T = (account_ref, contract, timestamp_utc, side, qty, price, commission)`

Within a single ingest batch:

- `occ` = running count of identical `T` encountered so far in that batch (0-based running occurrence index).
- `event_id = sha256(serialize(T) + '|' + occ)`

`serialize(T)` **MUST** be stable and deterministic for identical tuple values.

## 3.4 Account binding requirement for ingest
- `account_ref` used for ingest canonicalization and storage **MUST** be derived from the validated device token binding.
- Any payload-provided `account_ref` in ingest requests **MUST** be ignored for trust decisions.

---

## 4. Subsystem 3 (Locked) — Drift engine contract

## 4.1 Rule universe
`rule_id` **MUST** be one of:
- `OVERSIZE_V1`
- `OFF_SESSION_V1`
- `FREQUENCY_V1`
- `BASELINE_SHIFT_V1`

No additional rule IDs are in MVP-B scope.

## 4.2 Violation identity semantics
- `violation_id` in MVP-B is an **evaluation-snapshot identifier**, not a stable cross-time identity.
- `mode_instance_id` **MUST** be streak-stable and defined as:
  - `mode_instance_id = sha256(account_ref + '|' + mode + '|' + onset_utc)`

## 4.3 Onset continuity state machine
For each `(account_ref, mode)`:
- State space is **exactly** `{INACTIVE, ACTIVE}`.
- Transition `INACTIVE -> ACTIVE` sets `onset_utc` to the first qualifying onset in that streak.
- While condition remains active on subsequent evaluations, state **MUST** remain `ACTIVE` and original `onset_utc` **MUST** persist.
- Transition `ACTIVE -> INACTIVE` occurs only after a clean evaluation for that mode.

## 4.4 Driver ordering (locked)
Drivers returned for current state **MUST** be sorted by:
1. `points` descending,
2. `onset_utc` most recent first,
3. `rule_id` alphabetical ascending (tie-break).

## 4.5 Drift index bounds
- `drift_index` **MUST** be clamped to `<= 100`.

## 4.6 Data stale behavior
- If input data is stale (no new canonical fills since last valid evaluation), engine output **MUST** hold last computed state.
- Imperative evaluation without new data **MUST NOT** produce a newly recomputed score snapshot.

---

## 5. Subsystem 2 (Build Now) — Database schema and API contract

## 5.1 Required tables and keys
The data model **MUST** include these tables with these contract-level identities:

1. `accounts`
   - Primary key: `account_ref`
2. `entitlements`
   - Primary key: `user_id`
3. `user_configs`
   - Primary key: `account_ref`
4. `device_tokens`
   - Primary key: `device_id`
   - Unique: `token_hash`
5. `ingest_runs`
   - Primary key: `ingest_run_id`
   - Idempotency unique index: `UNIQUE(device_id, file_hash)` (for non-null file hash)
6. `fills_canonical`
   - Primary key: `event_id`
7. `mode_state`
   - Composite primary key: `(account_ref, mode)`
8. `violations`
   - Primary key: `violation_id`
9. `drift_scores`
   - Primary key: `score_id`
10. `webhook_events`
    - Primary key: `webhook_event_id`

## 5.2 Required API endpoints
### Helper endpoints
- `POST /v1/device/register`
- `POST /v1/ingest/fills` (authenticated via Bearer `device_token`)

### Extension endpoints
- `GET /v1/state`
- `GET /v1/drivers`
- `GET /v1/evidence`

### Optional context endpoint
- `POST /v1/webhooks/tradingview`
  - Store-only semantics in MVP-B.
  - Webhooks **MUST NOT** directly affect scoring calculations.

## 5.3 Authentication and entitlement rules
- Device tokens **MUST** be stored hashed (never plaintext at rest).
- Ingest account binding **MUST** come from validated device token mapping only.
- Entitlement gate on ingest **MUST** enforce status enum:
  - `TRIAL`, `ACTIVE`, `EXPIRED`, `SUSPENDED`.

## 5.4 Database invariants (locked)
- Financial precision:
  - `price` and `commission` **MUST** use `NUMERIC(18,8)`.
- Idempotency constraints:
  - `ingest_runs`: `UNIQUE(device_id, file_hash)`.
  - `device_tokens`: `UNIQUE(token_hash)`.
  - `fills_canonical`: `event_id` primary key.
- Access control:
  - RLS **MUST** be enabled with per-table `SELECT` policies for authenticated users.
  - Authenticated write operations **MUST** be denied by policy.
  - Service role is the trusted writer path.

---

## 6. Compliance requirements and change control

- Any implementation deviation from this spec is a **compliance drift** and **MUST** be documented in repository compliance audit artifacts.
- Runtime behavior changes that alter normative semantics in this document require explicit spec revision.
- MVP-B delivery acceptance is contingent on demonstrating conformance to this document and the acceptance checklist.
