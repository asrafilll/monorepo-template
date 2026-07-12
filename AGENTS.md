# AGENTS.md — Cek SEO

SEO-audit SaaS built on a pnpm monorepo. Users add a site and run cloud SEO audits via the squirrelscan REST API; reports show health score, category scores, and top issues. See `PLAN.md` for the MVP implementation plan and `README.md` for setup detail.

## Commands

```sh
pnpm install                          # deps
docker compose -f docker-compose.dev.yaml up -d   # local postgres (15432) + redis (16379)
pnpm db:generate && pnpm db:migrate   # prisma
pnpm --filter @repo/api dev           # API (Hono, port 8000)
pnpm --filter @repo/worker dev        # BullMQ worker
pnpm --filter @repo/platform dev      # customer app
pnpm --filter @repo/admin dev         # admin app
pnpm test                             # vitest, all packages
pnpm typecheck                        # tsc, all packages
pnpm check                            # biome lint+format check (check:fix to write)
pnpm createsuperuser                  # create/promote admin user
```

Always run `pnpm test && pnpm typecheck && pnpm check` before committing.

## Layout

| Path | What |
|---|---|
| `apps/api` | Hono API. Feature modules at `src/modules/<name>/{router,services,schema,types}.ts`. App assembled in `src/app.ts`, which exports `AppType` for RPC. |
| `apps/platform` | Customer app. React + Vite + TanStack Router file routes (`src/routes/`) + TanStack Query. |
| `apps/admin` | Admin app, mirrors platform. Admin gating: `isAdminRole` + `AdminForbiddenState`. |
| `packages/db` | Prisma schema, migrations, client singleton (if not yet extracted, these live in `apps/api/prisma` + `apps/api/src/utils/prisma.ts`). |
| `packages/worker` | Worker runtime (BullMQ + Redis). Queues, processors, and the squirrelscan API client. |
| `packages/api-client` | `hc<AppType>` Hono RPC client + hand-written typed helpers. Frontends only talk to the API through this. |
| `packages/config` | Single `src/index.ts`: zod `serverEnvSchema` parsed eagerly, sliced into frozen config objects (`apiConfig`, `redisConfig`, …). |
| `packages/ui` | Shared shadcn components, import as `@repo/ui/components/<name>`. |
| `packages/i18n` | i18next setup; app copy lives in each app's `src/i18n.ts` (EN + ID). |

Packages are **source-only**: they export `.ts`/`.tsx` directly, no build step.

## Conventions

- **API module pattern**: copy `apps/api/src/modules/users` or `modules/profile`. Router = `new Hono<{ Variables: AuthVariables }>()` with chained methods + `zValidator("json"|"query", schema)`. Business logic in `services.ts` with typed custom errors. Mount in `app.ts` with `.route(...)` chained (never break the builder chain — `AppType` inference depends on it).
- **Auth**: Better Auth mounted at `/api/auth/*`; config in `apps/api/src/modules/auth/auth.ts`. Global `loadAuthSession` middleware sets `c.get("user")`/`c.get("session")`. Guards: `const user = c.get("user"); if (!user) return c.json({ error: "unauthorized" }, 401)`; admin via `requireAdmin(c)` → 403.
- **Frontend data**: services wrap `@repo/api-client` (see `apps/platform/src/modules/auth/services.ts`), hooks wrap TanStack Query (`hooks/use-*.ts`). Route auth guard: `beforeLoad` + `ensureQueryData(meQueryOptions)` + redirect to `/login` on `UnauthorizedError` (see `routes/profile.tsx`).
- **i18n**: all user-facing copy through `useTranslation()` from `@repo/i18n`; add keys to both `en` and `id` trees.
- **Env vars**: add to `serverEnvSchema` in `packages/config/src/index.ts` → export frozen config slice → update `.env.example` → update `x-server-environment` anchor in `docker-compose.yaml`. Never read `process.env` elsewhere.
- **Tests**: vitest; DB fully mocked with `vi.hoisted` + `vi.mock` (canonical: `apps/api/src/app.test.ts`, drives routes via `app.request()`). Worker processors tested by calling them directly with a fake `{ data, id }` job and injected deps — no Redis in tests.
- **Lint/format**: Biome (`biome.json`). Match existing style; don't add eslint/prettier.

## Squirrelscan integration

- Cloud REST API only (no local CLI binary). Base `https://api.squirrelscan.com`, `Authorization: Bearer $SQUIRRELSCAN_API_KEY`.
- Endpoints: `POST /v1/agent-runs` (body `{ url, trigger: "api", config: "<JSON-encoded string>" }`), `GET /v1/agent-runs/{id}`, `GET /v1/agent-runs/{id}/report` (404 until ready, check `error.runStatus`), `GET /v1/credits`.
- **Credits are a shared, tiny pool** (free tier 500/mo; audit = 50 + 2/rendered page). Never auto-retry audit jobs (`attempts: 1`), keep `AUDIT_MAX_PAGES` low, enforce per-user quota (`USER_MONTHLY_AUDIT_LIMIT`) before enqueueing. Failed audits are refunded by squirrelscan and excluded from quota counts.
- Client lives in `packages/worker/src/squirrelscan/`; both worker (runs) and API (admin credits) use it.

## Gotchas

- API ↔ worker: API imports the queue from `@repo/worker`; worker must NOT import from `@repo/api` (cycle). Shared DB access goes through `@repo/db`.
- `BETTER_AUTH_SECRET` must be unique and ≥32 chars; prod rejects the default.
- No `RESEND_API_KEY` in dev → verification emails aren't sent; the verification URL is logged by the API instead.
- Docker worker service reuses the API image (`target: app`); new runtime deps must be reachable from the root install, no per-service Dockerfiles.
