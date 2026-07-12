# Cek SEO MVP — Implementation Plan

SEO-audit SaaS ("Cek SEO") built on this monorepo, powered by squirrelscan's cloud REST API.

## Context

Market-validation MVP: users register (email verification via Resend), add a site, run a cloud SEO audit (squirrelscan with browser rendering, free tier = 500 credits/mo), and view score/report. Admin app shows remaining squirrelscan credits + all recent audits. No payments, no site-ownership verification.

Free tier math: audit = 50 cr + 2/rendered page → with `AUDIT_MAX_PAGES=20` ≈ 8–10 audits/month **total across all users**, so a small per-user monthly quota protects the shared pool.

### Squirrelscan API (verified)

Base `https://api.squirrelscan.com`, header `Authorization: Bearer $SQUIRRELSCAN_API_KEY`:

| Endpoint | Notes |
|---|---|
| `POST /v1/agent-runs` | body `{ url, trigger: "api", config: "<JSON-encoded string: { maxPages, ... }>" }` → 201 `{ id, status: "pending" }` |
| `GET /v1/agent-runs/{id}` | status polling |
| `GET /v1/agent-runs/{id}/report` | 404 until ready (`error.runStatus` in body); 200 → `{ healthScore, totalPages, failed, warnings, passed, categories, topIssues, url, ... }` |
| `GET /v1/credits` | `{ balance, plan, pricing, pricingVersion }` |

OpenAPI 3.1 spec: `https://docs.squirrelscan.com/openapi.json`. Errors: 400/401/403/429/502. Failed audits auto-refund credits.

## Key decisions

- **Extract `packages/db`** (Prisma schema + client). Worker needs DB writes and API needs the worker's queue → shared db package avoids api↔worker import cycle. `apps/api/src/utils/prisma.ts` becomes `export * from "@repo/db"` so existing API imports keep working.
- **Squirrelscan client lives in `packages/worker/src/squirrelscan/`** — API already depends on `@repo/worker` for enqueue; reuse for admin credits call.
- **Single BullMQ `audit` queue, in-job polling loop** (20s interval, 45 polls ≈ 15 min cap), concurrency 1, `attempts: 1` — never auto-retry, retries burn shared credits.
- **Quota = query, not table**: `audit.count` for user in current month, excluding `failed` (squirrelscan refunds failed runs, so users shouldn't lose quota).
- **`requireEmailVerification: true`** — shared credit pool, block throwaway accounts. Dev fallback: no `RESEND_API_KEY` → log verification URL to API logs.

## Phase 0 — Config

`packages/config/src/index.ts` — add to `serverEnvSchema`:

| Var | Rule |
|---|---|
| `SQUIRRELSCAN_API_KEY` | optional string |
| `SQUIRRELSCAN_API_URL` | url, default `https://api.squirrelscan.com` |
| `RESEND_API_KEY` | optional string |
| `EMAIL_FROM` | default `Cek SEO <onboarding@resend.dev>` |
| `AUDIT_MAX_PAGES` | coerce int > 0, default 20 |
| `USER_MONTHLY_AUDIT_LIMIT` | coerce int > 0, default 2 |
| `USER_MAX_SITES` | coerce int > 0, default 5 |

Export frozen `squirrelscanConfig`, `emailConfig`, `auditConfig` following existing pattern. Update `.env.example`, `docker-compose.yaml` `x-server-environment` anchor, config tests.

## Phase 1 — packages/db + models

- Create `packages/db` (`@repo/db`, source-only like other packages): move `apps/api/prisma/` (schema, migrations, lock) + content of `apps/api/src/utils/prisma.ts` into `src/index.ts`. Deps: `@prisma/client`, `@prisma/adapter-pg`, `pg`, `@repo/config`; devDeps `prisma`, `dotenv-cli`. Move `db:*` scripts here; root `package.json` db filters `@repo/api` → `@repo/db`.
- `apps/api/src/utils/prisma.ts` → one-line re-export; add `@repo/db` dep to api.
- New models:

```prisma
enum AuditStatus { queued  running  completed  failed }

model Site {
  id        String   @id @default(cuid())
  userId    String
  url       String
  name      String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  audits    Audit[]
  @@unique([userId, url])
}

model Audit {
  id            String      @id @default(cuid())
  siteId        String
  userId        String      // denormalized: quota count + admin listing without join
  status        AuditStatus @default(queued)
  squirrelRunId String?     @unique
  healthScore   Int?
  totalPages    Int?
  passedCount   Int?
  warningCount  Int?
  failedCount   Int?
  rawReport     Json?
  error         String?
  createdAt     DateTime    @default(now())
  completedAt   DateTime?
  updatedAt     DateTime    @updatedAt
  site          Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
  user          User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([siteId, createdAt(sort: Desc)])
  @@index([userId, createdAt(sort: Desc)])
}
```

Back-relations `sites Site[]` / `audits Audit[]` on `User`. Also add `monthlyAuditLimit Int?` to `User` — per-user quota override set by admin (null → global `USER_MONTHLY_AUDIT_LIMIT` default).

- Migrate: `pnpm db:generate && pnpm db:migrate -- --name add_site_and_audit` (dev postgres up).

## Phase 2 — Squirrelscan client + audit worker

- `packages/worker/src/squirrelscan/{client,types}.ts`: fetch-based client on `squirrelscanConfig`. Functions: `createAgentRun(url)` (config JSON-stringified with `maxPages: auditConfig.maxPages`), `getAgentRun(id)`, `getAgentRunReport(id)` (404 → `null`; `error.runStatus === "failed"` → throw), `getCredits()`. Typed `SquirrelscanApiError { status, message }`; fail fast if apiKey missing.
- `packages/worker/src/queues/audit.ts`: `AuditJob = { auditId }`, lazy `getAuditQueue()`, `enqueueAudit(auditId)` with `{ attempts: 1, removeOnComplete: 100, removeOnFail: 100 }`.
- `packages/worker/src/processors/audit.ts`: `processAuditJob(job, deps = { prisma, client, sleep, maxPolls: 45, pollIntervalMs: 20_000 })`:
  1. load audit — skip unless `queued`
  2. **re-check quota** (same query as API) before spending credits — closes API-side race where two concurrent requests both pass the quota check; worker concurrency 1 makes this check serial and authoritative. Over quota → mark `failed` (`error: "quota_exceeded_at_run"`), no squirrelscan call
  3. mark `running` → `createAgentRun(site.url)` → save `squirrelRunId`
  4. poll loop: sleep → `getAgentRunReport`; report → persist score/counts/rawReport, `completed` + `completedAt`
  5. failure/timeout/throw → `failed` + truncated error (~500 chars), rethrow for BullMQ logging
  Injectable `deps` keep tests instant.
- `packages/worker/src/index.ts`: export new modules; `runWorker()` also starts `new Worker("audit", processAuditJob, { connection, concurrency: 1 })` with log hooks. Add `@repo/db` dep.

## Phase 3 — API routes + api-client

- `apps/api/src/modules/sites/{router,services,schema,types}.ts` (pattern: `modules/users`, `modules/profile`; auth via `c.get("user")`, zod via `zValidator`):
  - `POST /` — create; validate URL (http/https only, reject embedded credentials `user:pass@`, reject localhost/private-IP hosts, length ≤ 2048, `name` ≤ 100 chars); normalize (origin+path, strip trailing slash); site count ≥ `USER_MAX_SITES` → 429 `site_limit_reached`; P2002 → 409 `site_exists`
  - `GET /` — list with latest audit (`take: 1` include)
  - `DELETE /:id` — `deleteMany({ id, userId })`, 404 if 0
  - `POST /:id/audits` — owner check → 409 `audit_in_progress` if queued/running exists → quota check (effective limit = `user.monthlyAuditLimit ?? auditConfig.userMonthlyLimit`; 429 `{ error: "quota_exceeded", used, limit }`) → create `queued` audit → `enqueueAudit` → 201
  - `GET /:id/audits` — history + `{ quota: { used, limit } }` in same payload
- `apps/api/src/modules/audits/router.ts`: `GET /:id` owner-checked → `{ audit, report }` (report parsed from rawReport when completed, else null).
- `apps/api/src/modules/admin/router.ts` (all behind `requireAdmin`):
  - `GET /credits` — proxy `getCredits()`; SquirrelscanApiError → 502
  - `GET /stats` — counts: users, sites, audits this month (excl. failed), audits by status
  - `GET /audits` — paginated (`?page&status&userId`), include user email/name + site url
  - `GET /audits/:id` — full audit + parsed report (any user's)
  - `POST /audits/:id/cancel` — mark stuck `queued`/`running` audit `failed` (`error: "cancelled_by_admin"`); processor's final persist uses `updateMany({ where: { id, status: "running" } })` so a cancelled audit is never overwritten to `completed`
  - `GET /sites` — all sites paginated, include owner + audit count
  - `DELETE /sites/:id` — remove site + cascade audits (abuse cleanup)
  - `PATCH /users/:id/quota` — body `{ monthlyAuditLimit: number | null }`, sets per-user override (null resets to global default)
  - User list/ban/role stays with Better Auth admin plugin endpoints already used by the admin app — don't duplicate.
- `apps/api/src/app.ts`: chain `.route("/sites", ...).route("/audits", ...).route("/admin", ...)` — keep builder style so `AppType` picks types up. Add `@repo/worker` dep to api.
- `packages/api-client/src/index.ts`: typed helpers — `createSite`, `listSites`, `deleteSite`, `runSiteAudit` (429 → `QuotaExceededError`), `listSiteAudits`, `fetchAudit`; admin: `fetchAdminCredits`, `fetchAdminStats`, `fetchAdminAudits`, `fetchAdminAudit`, `cancelAdminAudit`, `fetchAdminSites`, `deleteAdminSite`, `setUserQuota`.

## Phase 4 — Email verification (Resend)

- `apps/api/src/modules/email/mailer.ts`: lazy `new Resend(emailConfig.resendApiKey)`; `sendVerificationEmail({ to, url, userName })`, minimal HTML; no key → log URL (dev fallback). Add `resend` dep to api.
- `apps/api/src/modules/auth/auth.ts`:
  ```ts
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) =>
      sendVerificationEmail({ to: user.email, url, userName: user.name }),
  },
  ```
- `apps/platform/src/modules/auth/services.ts`: register passes `callbackURL`, drop post-signup session fetch, return "verification sent"; login maps 403 `EMAIL_NOT_VERIFIED` → translatable error.
- `apps/platform/src/routes/register.tsx` / `login.tsx`: "check your inbox" success state; unverified-login error message.

## Phase 5 — Platform UI

- `apps/platform/src/modules/sites/{services.ts,hooks/use-sites.ts}` mirroring auth module (query options, mutations invalidating site/audit keys).
- Routes (guard via `beforeLoad` + `meQueryOptions` like `profile.tsx`):
  - `routes/sites.tsx` — sites table (url, last score badge, date), Add Site dialog, delete confirm
  - `routes/sites.$siteId.tsx` — quota line "X / Y this month", Run Audit button (disabled at quota or active audit), history table; `refetchInterval` 5s while any audit active
  - `routes/audits.$auditId.tsx` — running: skeleton + 5s poll; completed: health score (Progress/chart), category cards, topIssues table (severity badges); failed: alert
- `modules/app-shell/app-shell.tsx`: add "Sites" nav item.
- i18n keys EN + ID in `src/i18n.ts` (`sites.*`, `audits.*`, `auth.verifyEmail*`).

## Phase 6 — Admin platform

Full management app, not just a credits card. All routes behind existing `isAdminRole` + `AdminForbiddenState` gating; modules mirror platform pattern (`services.ts` + `hooks/use-*.ts` per feature). i18n EN + ID throughout.

- `apps/admin/src/routes/index.tsx` — **Dashboard**:
  - Credits card: balance, plan, "≈ N audits left" = `floor(balance / (50 + 2*maxPages))`, refetch 60s; low-balance warning (< 1 audit's worth)
  - Stats cards: total users, total sites, audits this month, running now
  - Recent audits table (last 10): user email, site url, status badge, score, date → links to audit detail
- `apps/admin/src/routes/audits.tsx` — **All audits**: paginated table, status filter tabs (all/queued/running/completed/failed), Cancel button on stuck queued/running rows (confirm dialog), row click → detail
- `apps/admin/src/routes/audits.$auditId.tsx` — **Audit detail**: same report view as platform (reuse/copy report components) + owner info + raw error for failed runs
- `apps/admin/src/routes/sites.tsx` — **All sites**: paginated table (url, owner email, audit count, created), Delete with confirm (abuse cleanup)
- `apps/admin/src/routes/users.tsx` — extend existing users page: add columns "audits this month" + "quota" with inline edit (`PATCH /admin/users/:id/quota`, null = default); ban/unban + role via existing Better Auth admin plugin actions
- App-shell nav: Dashboard, Audits, Sites, Users

## Phase 7 — Tests

- `apps/api/src/modules/sites/router.test.ts`: `vi.hoisted` mocks of prisma + `@repo/worker` (enqueueAudit), `app.request()` per `app.test.ts` canon — 401, create/normalize/dup 409, quota 429, in-progress 409, enqueue called with created id.
- `apps/api/src/modules/admin/router.test.ts`: 403 non-admin, credits happy path + 502 mapping, cancel only affects queued/running, quota patch validates int ≥ 0 or null, delete site 404.
- `packages/worker/src/processors/audit.test.ts`: direct processor calls with fake deps (`sleep: async () => {}`) — completed, run-failed, poll-exhaustion, 429-on-create.
- Config defaults test.
- Run: `pnpm -r test && pnpm -r typecheck && pnpm check`.

## Security checklist (built into phases above)

Threat model: shared 500-credit pool is the crown jewel — most attacks here are "burn owner's credits / spam", not data theft.

**Credit-pool abuse (main risk)**
- Quota: API check + worker re-check before `createAgentRun` (race-proof, worker concurrency 1). Phase 2/3.
- `attempts: 1`, never auto-retry. Phase 2.
- `USER_MAX_SITES` cap — no unlimited row creation. Phase 0/3.
- Email verification blocks throwaway signups; admin ban (Better Auth plugin) for repeat abusers. Known gap: Gmail `+alias` multi-accounts — accepted for MVP, watch in admin dashboard.

**Input validation (site URL)**
- http/https only; reject `user:pass@` in URL; reject localhost/private-IP/`.local` hosts (crawl happens on squirrelscan's infra so our net is safe, but blocks credit waste + keeps their ToS happy); length caps. Phase 3.

**Auth/session**
- Better Auth rate limiting is ON by default in production for `/api/auth/*` (memory store — fine, single instance). Covers login brute force + signup/email-send spam. Custom routes: quota + site cap are the effective limiters; no extra middleware for MVP.
- `BETTER_AUTH_SECRET` ≥ 32 chars enforced; cookies via Better Auth defaults (httpOnly, sameSite lax, secure on https baseURL). Prod `BETTER_AUTH_URL` must be https.
- CORS locked to `apiConfig.clientOrigins` with credentials — keep exact origins in prod env.

**Authorization**
- Every sites/audits query scoped by `userId` (`deleteMany({ id, userId })` pattern — no read-then-write IDOR). Admin routes all behind `requireAdmin`. Tests assert 401/403 paths. Phase 3/7.

**Data exposure**
- `SQUIRRELSCAN_API_KEY` / `RESEND_API_KEY` live only in `serverEnvSchema` (server-side parse); frontends use `import.meta.env.VITE_*` only — never add secrets to any `VITE_` var.
- User-facing errors are generic slugs (`site_exists`, `quota_exceeded`); raw squirrelscan/internal error text goes to logs + admin audit detail only, not to end users.
- Report data (crawled-site strings) rendered via React text nodes only — no `dangerouslySetInnerHTML` anywhere in report UI. Phase 5/6.

**Infra**
- Prod compose: only Caddy 80/443 exposed; postgres/redis internal-network only ✓ (verified).
- Dev compose: bind postgres/redis to loopback — change `"15432:5432"` → `"127.0.0.1:15432:5432"` (same for 16379) so laptop on public wifi doesn't expose dev DB. Phase 8.
- Never log request bodies containing passwords; never log `Authorization` headers.

**Deferred (post-MVP, revisit before payments)**
- Redis-backed rate limiting (multi-instance), CAPTCHA on signup, disposable-email domain blocklist, site-ownership verification (stops auditing sites you don't own), audit log for admin actions, CSP headers via Caddy.

## Phase 8 — Docker

No Dockerfile change (root `pnpm db:generate` works after filter rename; `COPY . .` includes `packages/db`). Compose: new env vars in `x-server-environment` anchor; dev compose ports bound to `127.0.0.1`.

## End-to-end verification (real free-tier key)

1. `.env`: `SQUIRRELSCAN_API_KEY=...`, `AUDIT_MAX_PAGES=5` (smoke audit ≈ 60 cr), `USER_MONTHLY_AUDIT_LIMIT=2`; Resend key optional.
2. `docker compose -f docker-compose.dev.yaml up -d` → `pnpm db:migrate` → dev servers: api, worker, platform, admin.
3. Register → grab verification URL from API logs (if no Resend key) → verify → login.
4. Add real small site → Run Audit → status queued→running→completed (~2–5 min) → report renders score/categories/topIssues.
5. Exceed quota → 429 surfaced, button disabled.
6. Admin (promote via `pnpm createsuperuser`): dashboard shows reduced credits balance + stats; audits page lists all runs; cancel a queued audit → row `failed`, never flips to completed; raise a user's quota → they can run extra audit; delete a site → its audits gone.
7. Unreachable URL audit → row ends `failed` with error, quota unaffected.

**Order:** 0 → 1 → 2 → 3 → {4, 5, 6 in any order} → 7 alongside each phase → 8.

## Post-MVP backlog (not in scope now)

- Payments (Xendit/Midtrans for Indonesian market), plan tiers
- Site-ownership verification (DNS TXT / meta tag)
- Scheduled audits (BullMQ repeatables) + score-drop email alerts
- Audit diffing / regression tracking, public share links, PDF export
- Squirrelscan Pro tier or credit top-ups once demand proven
- Check squirrelscan ToS re: commercial resale before charging customers
