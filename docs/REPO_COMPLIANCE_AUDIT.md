# Drift Sentinel MVP-B — Repository Compliance Audit

This audit compares current repository behavior to `SPEC_DRIFT_SENTINEL_MVPB.md`.

Scope reviewed:
- Express app composition and route surface (`src/index.ts`, `src/routes/*.ts`)
- Canonicalization and session tagging (`src/subsystem0/*.ts`)
- Drift engine contracts (`src/engine/*.ts`)
- Auth middleware (`src/middleware/auth.ts`)
- Supabase access and SQL schema (`src/db/supabase.ts`, `supabase/migrations/20260224222008_mvp_b.sql`)

Schema source-of-truth note:
- The normative database source for MVP-B is the Supabase migration `supabase/migrations/20260224222008_mvp_b.sql` (not an ad-hoc `schema.sql` artifact).

---

## Aligned with MVP-B

1. **Deterministic canonical event id strategy exists and matches locked tuple concept.**
   - `src/subsystem0/parser.ts` computes event ids using tuple + running occurrence count with SHA-256.
   - The tuple described in code comments and implementation includes account, contract, timestamp, side, qty, price, commission.

2. **Drift rule universe is constrained to the locked MVP-B set.**
   - `src/engine/types.ts` and `src/engine/modes.ts` use `OVERSIZE_V1`, `OFF_SESSION_V1`, `FREQUENCY_V1`, and `BASELINE_SHIFT_V1`.

3. **Mode onset persistence model is implemented via state machine semantics.**
   - `src/engine/drift.ts` includes INACTIVE/ACTIVE onset map behavior and preserves onset while mode remains active.
   - `src/routes/drift.ts` persists per-mode state in `mode_state`.

4. **`mode_instance_id` formula aligns with locked definition.**
   - `src/engine/drift.ts` computes `mode_instance_id` using SHA-256 over `mode|account_ref|onset_utc` fields.

5. **Driver ordering logic is partially aligned (points and recency).**
   - `src/engine/drift.ts` sorts drivers by points descending, then onset recency.

6. **Drift index clamping is implemented.**
   - `src/engine/drift.ts` clamps drift index with `Math.min(100, totalPoints)`.

7. **Webhook behavior is store-only and explicitly not scoring input.**
   - `src/routes/webhooks.ts` persists webhook events and states they do not affect drift scoring in MVP.

8. **DB schema includes required MVP-B tables and key constraints.**
   - `supabase/migrations/20260224222008_mvp_b.sql` includes: `accounts`, `entitlements`, `user_configs`, `device_tokens`, `ingest_runs`, `fills_canonical`, `mode_state`, `violations`, `drift_scores`, `webhook_events`.

9. **Financial precision and idempotency constraints exist in schema.**
   - `supabase/migrations/20260224222008_mvp_b.sql` uses `NUMERIC(18,8)` for `fills_canonical.price` and `fills_canonical.commission`.
   - `supabase/migrations/20260224222008_mvp_b.sql` has `fills_canonical.event_id` primary key and `UNIQUE(device_id,file_hash)` on `ingest_runs` and `UNIQUE(token_hash)` on `device_tokens`.

10. **RLS read policies and authenticated write-deny policies are present in schema.**
    - `supabase/migrations/20260224222008_mvp_b.sql` enables RLS per table, defines SELECT policies, and denies authenticated writes.

---

## Violations / Drift

1. **Route contract mismatch (`/v1/*` required, `/api/*` implemented).**
   - **Now:** `src/index.ts` mounts `/api/fills`, `/api/drift`, `/api/webhooks`, `/api/config`; no `/v1/device/register`, `/v1/ingest/fills`, `/v1/state`, `/v1/drivers`, `/v1/evidence`.
   - **Spec conflict:** MVP-B API contract mandates `/v1/*` endpoint surface.
   - **Minimal corrective action:** Add `/v1/*` contract endpoints (or alias layer) and document retirement/mapping of legacy `/api/*` routes.

2. **Auth is stubbed and not Bearer hash lookup against device token store.**
   - **Now:** `src/middleware/auth.ts` accepts any non-empty `x-device-token` or `authorization` value and does not hash/lookup against `device_tokens`.
   - **Spec conflict:** Device auth must be Bearer token hash lookup; token storage is hashed and validated.
   - **Minimal corrective action:** Implement strict Bearer parsing, SHA-256 lookup against `device_tokens.token_hash`, and reject invalid/revoked tokens.

3. **`account_ref` trust boundary violated on ingest.**
   - **Now:** `src/routes/fills.ts` accepts `account_ref` from request body and uses it for reads/writes; per-fill payload value may override route-level account.
   - **Spec conflict:** Ingest account binding must come from device-token binding only; payload account_ref must be ignored for authority.
   - **Minimal corrective action:** Resolve account_ref exclusively from authenticated device token mapping and ignore payload account_ref for authorization/storage identity.

4. **Entitlement gate is not enforced.**
   - **Now:** `src/middleware/auth.ts` `licenseCheckMiddleware` is pass-through.
   - **Spec conflict:** Ingest must enforce entitlement statuses `TRIAL/ACTIVE/EXPIRED/SUSPENDED`.
   - **Minimal corrective action:** Query entitlements for authenticated principal and gate ingest acceptance by status.

5. **Imperative re-evaluation endpoint exists without stale-data gate.**
   - **Now:** `src/routes/drift.ts` exposes `POST /api/drift/evaluate` and computes a new snapshot when called.
   - **Spec conflict:** No re-eval without new data; stale state must hold last computed output.
   - **Minimal corrective action:** Gate evaluation on new canonical fills since last score or remove/disable imperative evaluate endpoint in favor of data-driven evaluation trigger.

6. **Data stale first-class behavior is not represented in API/schema contract.**
   - **Now:** No explicit stale status field/path; evaluate endpoint can produce fresh writes without checking new input.
   - **Spec conflict:** Data stale is first-class and must hold last state.
   - **Minimal corrective action:** Add stale detection state and enforce no recomputation when stale.

7. **Driver ordering tie-break differs from locked spec.**
   - **Now:** `src/engine/drift.ts` tie-break is alphabetical by `mode` after points and onset.
   - **Spec conflict:** Tie-break must be alphabetical by `rule_id`.
   - **Minimal corrective action:** Sort by `rule_id` as final comparator.

8. **Violation identity semantics differ from MVP-B snapshot requirement.**
   - **Now:** `src/engine/utils.ts` + `src/engine/drift.ts` compute deterministic `violation_id` from `rule_id|account_ref|anchor_key` intended to be stable across evaluations.
   - **Spec conflict:** MVP-B requires evaluation-snapshot `violation_id` (not stable identity over time).
   - **Minimal corrective action:** Move to per-evaluation snapshot identity (while retaining `mode_instance_id` for streak continuity).

9. **Webhook endpoint identity contract differs (`user_license_id` used, not device/account binding).**
   - **Now:** `src/routes/webhooks.ts` validates/stores `user_license_id`; optional payload `account_ref` is accepted directly.
   - **Spec conflict:** MVP-B authority model is device token binding + account mapping for ingest and extension reads; webhook should be context storage and avoid trust in payload account binding.
   - **Minimal corrective action:** Align webhook identity/mapping model with account ownership constraints; avoid payload account trust.

10. **Supabase client always uses service role at runtime paths.**
    - **Now:** `src/db/supabase.ts` creates one service-role client; route code performs all reads/writes through it.
    - **Spec risk:** While service-role writes are allowed, contract also expects authenticated read scoping and write deny for non-service callers; using service role universally bypasses RLS in app-layer operations.
    - **Minimal corrective action:** Separate caller-scoped client (for user-scoped reads) from service writer client, or enforce equivalent app-layer ownership checks before each query.

11. **UI contract not represented in repository artifacts.**
    - **Now:** API repository has no explicit badge+drawer UI contract docs beyond ad hoc comments.
    - **Spec conflict:** MVP-B scope explicitly constrains UI surface to badge + drawer only.
    - **Minimal corrective action:** Keep this as documented architectural boundary in product docs and extension contract docs (without requiring backend runtime changes).

---

## Summary

Current repo has strong building blocks (schema constraints, deterministic parser/event-id, onset persistence, clamped index, and store-only webhooks), but it is not yet fully conformant to the locked MVP-B authority and API contract. Highest-priority compliance gaps are authentication/account binding, entitlement enforcement, stale-data evaluation gating, and endpoint contract alignment.
