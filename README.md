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
| POST | `/registration/validate-coupon` | `{ couponCode }` → `{ valid: true, licenseId, instituteId }` · 404 `COUPON_NOT_FOUND` |
| POST | `/registration/validate-email` | `{ email }` → `{ available: true }` · 409 `EMAIL_ALREADY_IN_USE` |
| POST | `/registration/validate-username` | `{ username }` → `{ available: true }` · 409 `USERNAME_ALREADY_IN_USE` |
| POST | `/registration` | `{ couponCode, username, firstName, lastName, email?, password, avatarCode }` → 201 `{ accountId, username }` |

All `/registration*` routes need the caller's `X-Api-Key` (`ACCOUNT_SERVICE_API_KEY`; 401 `INVALID_API_KEY`).

**Registration flow** (`POST /registration`, fail fast): field shapes (400 `VALIDATION_ERROR`) → coupon in `license_index` + `institute_index` → email not in `account_index` (email is optional; verification is the Portal's job) → username not in `account_index`/`user_index` nor in the grid as `<username> EW` / `<username> Resident` → `avatarCode` active in `avatar_index` (400 `INVALID_AVATAR_CODE`) → Robust `POST /api/user/account` with `first=<username>`, `last=EW`, empty `email`, `avatar=<avatarCode>` (502 `REGISTRATION_FAILED`) → `PrincipalID` from grid `useraccounts` (502 `USER_LOOKUP_FAILED`) → bms-adapter `POST /users` (`X-Registrant-Type: User`; 502 `BMS_REGISTRATION_FAILED`, 504 `BMS_ADAPTER_TIMEOUT`), which creates the BMS user and the `account_index`/`user_index` rows. If bms-adapter reports `indexWriteSucceeded: false`, the response is still 201 with `accountId: null` and the case is logged for reconciliation.

Rules: username is one word of `[A-Za-z0-9_]`, 1–64 characters (Robust's name rule); password 8–128 characters.

`ROBUST_SKIP=true` (dev only, refused in production) skips Robust and the grid lookup; a random UUID stands in for the PrincipalID and bms-adapter is still called.

Errors follow the standards' `{ code, message }` shape: also `NOT_FOUND` (404), `INVALID_JSON` (400), `PAYLOAD_TOO_LARGE` (413), `INDEX_DB_UNAVAILABLE` / `GRID_DB_UNAVAILABLE` (503), `INTERNAL_ERROR` (500).

Database setup: `db/avatar_index.sql` (new `ew_index.avatar_index` table) and `db/setup.sql` (production DB user, SELECT only).

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
