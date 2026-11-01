# CMS & Auth — Architecture (as built)

This document describes the **demo CMS / authentication layer** that actually ships in
this repository. It is a browser-only build: everything runs client-side against
`localStorage`, so it is a usable demonstration of the workflow, **not a security
boundary**. A determined user can bypass any of it from devtools.

Implementation: [`plugins/cms-engine/cms-engine.js`](../plugins/cms-engine/cms-engine.js)
(data/auth, `window.BoundaryQCCMS`, no UI of its own),
[`plugins/security-pki/security-pki.js`](../plugins/security-pki/security-pki.js),
[`plugins/billing/billing.js`](../plugins/billing/billing.js). The UI is
split across [`plugins/security/security.js`](../plugins/security/security.js)
(sign-in/register modal, header account indicator) and
[`plugins/dashboard/dashboard.js`](../plugins/dashboard/dashboard.js) (the
`#tab-cms` admin panel) — both depend on `cms-engine` rather than owning
its data. See the section below for the optional PostgreSQL sync bridge
(`plugins/db-sync/`, `plugins/db-settings/`).

---

## What is implemented

### 1. Password auth & sessions (`cms-engine.js`)
- **Password hashing**: PBKDF2‑SHA‑256, 100 000 iterations, per‑user random 16‑byte
  salt, via `window.crypto.subtle` for real registrations and password changes. Seed
  accounts and the schema migration use a lighter synchronous salted‑iterated
  SHA‑256 (`_deriveHashSync`) so page load stays fast. Credential records store
  `{ algo, salt, iterations, hash }` — never a plaintext password.
- **Verification** uses a constant‑time comparison (`_safeEqual`).
- **Password policy**: minimum 8 chars, at least one letter and one digit.
- **Sessions**: a random token with an `expiresAt` timestamp in `localStorage`
  (`SESSION_HOURS = 8`, or `REMEMBER_DAYS = 30` with "remember me"). An expired
  session is treated as signed‑out.
- **Lockout**: 5 failed attempts locks the email for 60 s; the same generic error is
  returned whether the account is missing or the password is wrong.
- **Register / change‑password / logout / impersonate** (`impersonate` is a demo
  convenience — an authenticated user can switch to another account in the workspace
  with no re‑auth; it is written to the audit log as `SESSION_SWITCHED`).
- **Seed data**: 3 users at `@kimley-horn.com`, all with the demo password
  `Fdot2026!` (shown as a hint on the sign‑in form).

### 2. RBAC
Five roles (`PSM_SURVEYOR`, `PE_ENGINEER`, `FIRM_ADMIN`, `MUNICIPAL_REVIEWER`,
`CONTRACTOR`) with a `canSign` flag and an F.A.C. rule string. Roles are displayed
and recorded; they do not gate any computation in this build.

### 3. Per‑user client master templates
Each user keeps a set of "client master templates" — small setting profiles
(`discipline`, `idfZone`, `sheetDwt`, `precisionPass`, `fpidPrefix`, `county`,
`district`, `notes`). Settings are normalised and clamped on write
(`_normalizeSettings`). Other plugins read the **active** template through
`getActiveTemplateSetting(key, fallback)` — e.g. the SSA hydrology tab defaults its
IDF zone from it, and the traverse / legal‑description tabs take their closure
pass‑threshold from `precisionPass`.
- **Count gate**: the number of templates a user may keep comes from the billing
  tier (`clientTemplates`: Free/Pro = 5, Firm = 25, Enterprise = 999). Exceeding it
  throws an error carrying `code: "TEMPLATE_LIMIT"` and an upsell message.
- Templates are per‑user — `getTemplates()` filters by `ownerId`, so one user never
  sees another's.

### 4. Projects & submittals
CRUD over FDOT projects (FPID, county, district) and DXF submittal records
(filename, score, precision ratio, bow‑tie flag, SHA‑256). Seeded with example rows.
Storage only — nothing is uploaded anywhere.

### 5. Hash‑linked audit log
Every state change appends a block:

```
BlockHash_n = SHA256( sequence | timestamp | actor | action | details | prevHash )
```

- The hash is computed **synchronously** (pure‑JS FIPS 180‑4 SHA‑256 in
  `security-pki.js`, verified byte‑for‑byte against Node's `crypto` in the test
  suite) *before* the row is persisted, so the log never stores a placeholder and a
  concurrent append can't link to an unhashed predecessor.
- `verifyAuditHashChain(logs)` recomputes every block digest and checks every
  `prevHash` link, reporting the first tampered block. This proves the local log has
  not been edited in place — it is **not** an external notarisation.

### 6. Billing / entitlement (`billing.js`)
- Tier is read from `localStorage` (`bqc_user_tier`). Tier limits table drives the
  template gate and the (display‑only) feature flags.
- `generateEntitlementJwt()` signs an `ES256` JWT with an **ECDSA P‑256 key pair
  generated fresh on every page load** via `window.crypto.subtle`. The token is
  therefore only self‑consistent within one browser session — there is no published
  public key for an external verifier to trust. Stored in `sessionStorage`.
- `processStripeWebhook(event, signature, idempotencyKey)` simulates a Stripe event
  with an idempotency lock and an ASC‑606‑style ledger entry. **The `signature`
  argument is accepted for shape compatibility and is not verified** — there is no
  webhook secret and no server.

### 7. PKI / TSA gates (`security-pki.js`)
`verifyPKICertificate` and `verifyRFC3161Timestamp` check a CA / TSA name against a
small hard‑coded allow‑list (exact, case‑insensitive — no substring match) and an
LTV flag. `authenticateHardwareToken` calls the real `navigator.credentials.get()`
WebAuthn API and **fails closed** (returns `success: false`) when WebAuthn is
unavailable. These validate inputs against a list; they do not perform real
certificate‑chain or timestamp‑token cryptography.

---

## Now implemented: an optional PostgreSQL sync bridge

Unlike when this section was first written, `generateCloudSyncPayload()`'s
consumer now exists: [`server.py`](../server.py) + [`db/schema.sql`](../db/schema.sql)
is a small stdlib-only HTTP server that serves the static app *and* a
`/api/db/*` REST bridge to a local (or remote) Postgres. `plugins/db-sync/db-sync.js`
(`window.DatabaseService`) is the only thing that talks to it, and
`plugins/db-settings/db-settings.js` is its Admin Dashboard UI (status
badge, sync push/pull, connection settings). It's **additive and optional**:
`cms-engine.js` still knows nothing about it (`db-sync` does the Postgres
column-shape ↔ this class's object-shape translation, via `merge*()`/
`replaceAuditChain()`), and every plugin here keeps working unmodified,
`localStorage`-only, if the bridge/DB isn't running. Auth itself is **not**
part of this — `users` rows sync for reference, but the DB stores whatever
credential record `cms-engine` happens to have locally, and nothing on the
server verifies a login. See `npm run db:start`/`db:init` and `npm run
test:db` (its own suite, deliberately excluded from the zero-install
default `npm test`).

## Not implemented (aspirational — mentioned elsewhere in the repo)

The marketing/architecture material in this repo also references the following.
None of it exists in the code:

- Argon2id hashing, server‑side auth (login is still verified client-side
  against `localStorage`), `__Host-` / `HttpOnly` / `SameSite=Strict` cookies.
- Row‑level security enforcement, real multi‑tenant isolation, remote/cloud
  Postgres — the sync bridge above is local-first; see its own docs for what
  "remote" currently means (a connection-string field, nothing more yet).
- A verified Stripe webhook receiver, a real payment flow.
- SOC 2 controls, a REST/GraphQL API gateway, CloudEvents webhooks.
- AES‑256‑GCM "zero‑knowledge" OPFS/WASM storage vault.
- PAdES‑LTV / OCSP / real RFC 3161 token validation.

## Tests

`tests/auth.test.js` covers the seed + session, login, lockout, register,
change‑password, impersonate, per‑user template isolation, the 5‑template license
gate, settings normalisation, billing tier limits, and audit‑chain tamper
detection. `tests/geo.test.js` covers the SHA‑256 engine, the PKI/TSA gates, and
WebAuthn failing closed. Run with `npm test`.
