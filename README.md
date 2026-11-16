# ew-account-service-api

EurekaWorld **Account Service API**: the internal ECS service that will own all account management for the EurekaWorld system. Its first release implements the user registration backend (coupon, email and username validation, email verification, registration through Robust, `ew_index` account records). Account functions then move here from `ew-portal-api` one by one; when all have moved, the `apiaccount.eurekaworld.internal` CNAME switches to this service.

Design: `EurekaWorld_Account_Service_Design_v1.0` (project docs). Not created from `ew-app-api-base`: it is an internal infrastructure service, like `ew-grid-service-api` and `ew-mail-gateway`.

**Status:** 0.1.0 (skeleton, `/health`) deployed to ECS on 2026-11-07 at `http://apiaccounttemp.eurekaworld.internal:8080` (VPC only). 0.2.0 on `dev`: registration backend (design §6), not deployed yet.

## Stack

Node.js 22 LTS (`node:22-alpine`) + TypeScript + Express 5, helmet, winston logging, multi-stage production Dockerfile with graceful SIGTERM/SIGINT shutdown, Vitest + supertest, VS Code Dev Container on the Linux Docker server, ECS Fargate in the `default` cluster.

## Endpoints

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/health` | `{ status: "ok", service, version }`. Liveness only (no dependency checks), used by the container health check and the internal ALB target group. No auth. |
| POST | `/registration/validate-coupon` | `{ couponCode }` → `{ valid: true, licenseId, instituteId, instituteName }` · 404 `COUPON_NOT_FOUND` |
| POST | `/registration/validate-email` | `{ email }` → `{ available: true }` · 409 `EMAIL_ALREADY_IN_USE` |
| POST | `/registration/validate-username` | `{ username }` → `{ available: true }` · 409 `USERNAME_ALREADY_IN_USE` · 400 `INVALID_USERNAME` |
| POST | `/registration` | `{ couponCode, username, firstName, lastName, email?, password, avatarCode }` → 201 `{ accountId, username }` |
| PUT | `/users/:userId/password` | `{ actingUserId, actingUserPassword, newPassword, isInitial? }` → 200 `{ status: "password_changed", gridSync: "ok" \| "failed" \| "skipped", code? }` |
| POST | `/auth/login` | `{ username, password, captchaToken?, mfaToken? }` → 200 `{ accessToken, user }` + refresh cookie, or 200 `{ status: "MFA_REQUIRED" \| "MFA_INITIAL" }` |
| POST | `/auth/mfa/qr` | `{ username, password, captchaToken? }` → `image/png` (QR of the never-verified MFA secret) |
| POST | `/users/:userId/password/reset` | Header `X-Service-Token` (`system:set-password`); `{ newPassword }` → same 200 response |

All `/registration*` routes need the caller's `X-Api-Key` (`ACCOUNT_SERVICE_API_KEY`; 401 `INVALID_API_KEY`).

**Registration flow** (`POST /registration`, fail fast): field shapes (400 `INVALID_USERNAME` for the username, `VALIDATION_ERROR` for the other fields) → coupon in `license_index` + `institute_index` → email not in `account_index` (email is optional; verification is the Portal's job) → username not in `account_index`/`user_index` nor taken in the grid (two words → that name; one word → `<username> EW` or legacy `<username> Resident`) → `avatarCode` active in `avatar_index` (400 `INVALID_AVATAR_CODE`) → Robust `POST /api/user/account` with the grid name (two words → `first`/`last`; one word → `first=<username>`, `last=EW`), empty `email`, `avatar=<avatarCode>` (502 `REGISTRATION_FAILED`) → `PrincipalID` from grid `useraccounts` (502 `USER_LOOKUP_FAILED`) → bms-adapter `POST /users` (`X-Registrant-Type: User`; 502 `BMS_REGISTRATION_FAILED`, 504 `BMS_ADAPTER_TIMEOUT`), which creates the BMS user and the `account_index`/`user_index` rows. If bms-adapter reports `indexWriteSucceeded: false`, the response is still 201 with `accountId: null` and the case is logged for reconciliation.

Rules: username is one or two words of `[A-Za-z0-9_]`, 1–64 characters each (Robust's name rule); a second word may not be `EW` or `Resident` (it would be the one-word username's grid account). Password: the EurekaWorld standard (Registration Wizard Architecture v1.0 §4) — at least 10 characters, at least one English letter and one digit, only `[A-Za-z0-9!@#$%^&*()]` (max 128).

`ROBUST_SKIP=true` (dev only, refused in production) skips Robust and the grid lookup; a random UUID stands in for the PrincipalID and bms-adapter is still called.

Errors follow the standards' `{ code, message }` shape: also `NOT_FOUND` (404), `INVALID_JSON` (400), `PAYLOAD_TOO_LARGE` (413), `INDEX_DB_UNAVAILABLE` / `GRID_DB_UNAVAILABLE` (503), `INTERNAL_ERROR` (500).

**Login** (`POST /auth/login`, copied from ew-portal-api; Asaff 2026-11-16). ew-portal-api proxies it unchanged and forwards the end user's IP as the first `X-Forwarded-For` entry; the response (body, `Retry-After`, `Set-Cookie`) goes back as is. Steps as in ew-portal-api: rate limit per (username, IP), 10 attempts / 15 min → 429 `RATE_LIMITED` + `Retry-After`; after 3 consecutive failures reCAPTCHA v2 (400 `CAPTCHA_REQUIRED` / `INVALID_CAPTCHA`); `account_index` ⋈ `user_index` by username (+ `BMS_LOGIN_FALLBACK_ENABLED` on-demand migration); BMS password hash → 401 `INVALID_CREDENTIALS` (`requiresCaptcha: true` from the 3rd failure). Then MFA (new):
- `hasMfa` and no `mfaToken` → 200 `{ status: "MFA_REQUIRED" }`, or `{ status: "MFA_INITIAL" }` while the secret was never verified (`mfaIsInitial`). No tokens.
- `mfaToken` (6 digits) → TOTP check (RFC 6238, ±1 step) on the BMS secret (bms-adapter `GET /users/{id}/mfa`); a code from a step at or before the last verification is rejected (no reuse). Wrong → 401 `INVALID_MFA_TOKEN` (with `status`; counts as a failed attempt). Right → bms-adapter `POST /users/{id}/mfa/verify` (sets `LastVerificationOn`, which ends the initial state).
- `hasMfa` but no active secret → 409 `MFA_NOT_AVAILABLE`.
- Success: `{ accessToken, user }` and the `ewRefreshToken` cookie, identical to ew-portal-api (same claims, same RS256 key pair, `COOKIE_DOMAIN`).

`POST /auth/mfa/qr`: same password checks and rate limit, then the QR (PNG, `Cache-Control: no-store`) of `otpauth://totp/EurekaWorld:<username>?secret=…&issuer=EurekaWorld`, generated here; only while the secret was never verified (else 409 `MFA_NOT_INITIAL`).

**Passwords** (Pre-Launch Security Design §1; all password authentication moves here). `:userId` is the BMS `Users.UserId` (`user_index.user_id`); both routes need the caller's `X-Api-Key`.

- `PUT /users/:userId/password`: every change except forgot-password (own change, admin, teacher). The acting user (may be the user themself) proves their **current** BMS password, whatever its state (initial or expired), with bms-adapter `GET /users/{id}/credentials` + `POST /users/compute-hash` (logic copied from ew-portal-api): 401 `INVALID_ACTING_USER_PASSWORD`. `isInitial` (default false) marks an admin/teacher-set password. On an own change, `newPassword` must differ from the current one. Future: rules on who may change whose password.
- `POST /users/:userId/password/reset`: forgot-password. ew-portal-api authenticates the user (emailed code), mints a one-time `system:set-password` token for this user (`ew_system.sp_mint_service_action_token('system:set-password', userId, userId)`) and sends it as `X-Service-Token`. The account service consumes it first with `ew_system.sp_consume_service_action_token` (deleted whatever the outcome) and checks its action and user; missing, expired, reused or for another user/action: 403 `INVALID_SERVICE_TOKEN`.

Both then: `newPassword` meets the password standard (400 `VALIDATION_ERROR`) → password history (`POST /users/{id}/password/validate`; 400 `PASSWORD_RECENTLY_USED`) → BMS password (`PUT /users/{id}/password`) → grid password through the registration Robust (`POST /api/password/<PrincipalID>`, PrincipalID = `user_index.open_sim_user_id`, called only when that grid account exists in `useraccounts`). If the grid step fails, BMS has already changed: still 200 with `gridSync: "failed"` and `code: "GRID_PASSWORD_SYNC_FAILED"`, logged for manual repair. `ROBUST_SKIP` → `gridSync: "skipped"`. Other errors: 404 `USER_NOT_FOUND`, 502 `BMS_ADAPTER_UNAVAILABLE`, 504 `BMS_ADAPTER_TIMEOUT`, 503 `INDEX_DB_UNAVAILABLE` / `GRID_DB_UNAVAILABLE`.

Database setup: `db/ew_system_service_action_tokens.sql` (`ew_system` service action tokens and routines, owned by this service), `db/avatar_index.sql` (new `ew_index.avatar_index` table, including the wizard's picker columns, owned by this service) and `db/setup.sql` (production DB user, SELECT only).

## Ports and addresses

| Where | Address |
| --- | --- |
| Container port (dev and prod) | 8080 (internal-only component, non-root) |
| Dev, from your workstation via VS Code port forwarding | `http://localhost:8080` (VS Code picks the next free local port if 8080 is taken; see the **Ports** tab) |
| Dev, Docker server host port | `http://localhost:3060` on the server, or `http://<server>:3060` |
| Dev, from another container on `ew-dev` | `http://account-service-api:8080` |
| Prod-check image on the Docker server | `http://localhost:3069` |
| Production (VPC only) | `http://apiaccounttemp.eurekaworld.internal:8080` via the internal ALB (later `apiaccount.eurekaworld.internal`) |

## Development

On the Linux Docker server (`~/projects/ew-account-service-api`, branch `dev`):

1. Open the folder in VS Code (Remote SSH) → **Reopen in Container**. The first open creates the `ew-dev` network if missing and copies `.env.example` to `.env`.
2. In the container terminal: `npm run dev` (tsx watch, restarts on save).
3. Browse `http://localhost:8080/health` on your workstation (forwarded by VS Code; check the **Ports** tab for the actual local port), or use `requests.http` / Thunder Client. Nothing listens until `npm run dev` is running (the container itself only runs `sleep infinity`).

| Script | What it does |
| --- | --- |
| `npm run dev` | Run from source with reload |
| `npm run typecheck` | Type-check `src` and `test` |
| `npm test` | Vitest |
| `npm run build` | Compile to `dist/` |

After changing `package.json`, run `npm install` in the container (node_modules live in a named Docker volume). After editing `.env`, restart `npm run dev`; recreate the container if you changed variables used by Compose itself.

**Check the production image** before deploying:

```bash
cp .env.example .env.prod && sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' .env.prod
docker compose -f docker-compose.prod.yml up --build -d
curl -s localhost:3069/health
docker compose -f docker-compose.prod.yml down
```

## Deployment

See [`deploy/README.md`](deploy/README.md): one-time infrastructure setup, then `bash deploy/deploy.sh` for each release.

## Branches

`dev` for development, `main` for releases (promoted manually as a fast-forward of `dev`, tagged `vX.Y.Z` matching `package.json`).
