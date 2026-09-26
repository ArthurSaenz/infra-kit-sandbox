# infra-kit-sandbox — a consumer-shaped monorepo for `infra-kit dev`

A small standalone pnpm workspace shaped like hulyo/travelist (same naming: unscoped `<app>-api` /
`<app>-ui` apps, `@pkg/*` shared packages), used as the fixture for real-process e2e
tests of `infra-kit dev --watch` (real turbo, real tsc, real fastify — nothing faked). Plan and test
catalogue: [`docs/dev-watch-test-plan-integration.md`](https://github.com/ArthurSaenz/infra-kit/blob/main/docs/dev-watch-test-plan-integration.md)
in infra-kit.

It is its own repo — its own git root, `pnpm-workspace.yaml` and lockfile — so infra-kit treats it exactly like
a real consumer (own `~/.infra-kit/projects/infra-kit-sandbox/` config, own repo name).

```
apps/shop/api        shop-api          serverless-style backend, tsc -b → dist, GET /api/v1/ping
apps/admin/api       admin-api         same shape
apps/shop/ui         shop-ui           vite + infraKit() plugin, /api routed local|cloud
apps/admin/ui        admin-ui          same shape
packages/types       @pkg/types        shared types (both sides)
packages/lib-core    @pkg/lib-core     backend shared lib (tsc -b); LIB_VERSION flows into /ping
packages/api-client  @pkg/api-client   FE ↔ BE interfaces (depends on types)
packages/ui-kit      @pkg/ui-kit       FE shared lib (vite build + vite-plugin-dts)
e2e/                                   the vitest suite
```

infra-kit is consumed through `link:` dependencies on `../infra-kit/apps/infra-kit/{cli,config,vite}` — clone
[infra-kit](https://github.com/ArthurSaenz/infra-kit) as a sibling of this repo — so the local build is what runs. `tsconfig.service.json` is a pinned copy of hulyo's service tsconfig.

## Run the e2e suite

```bash
pnpm --filter infra-kit build     # in ../infra-kit — the suite refuses a dist older than src/
pnpm install
pnpm run e2e
```

Needs a portless daemon serving HTTPS on :443 (`infra-kit dev` refuses to start without one; `infra-kit
doctor` prints the one-time install). It is only probed; every write goes to a temp dir.

Each test copies the sandbox (minus `node_modules`, `dist`, `.turbo`, `e2e`) to a temp dir, commits it to
a fresh git repo (turbo watch tracks git-visible sources), and runs `pnpm install --offline
--frozen-lockfile` there — cheap, because `enableGlobalVirtualStore` makes node_modules symlinks into the
store. A symlink `<tmp>/infra-kit/apps/infra-kit` keeps the lockfile's `link:../infra-kit/apps/infra-kit/*` specifiers valid.
`HOME`, `XDG_CACHE_HOME` and `PORTLESS_STATE_DIR` point into the temp dir, so the copy never touches
`~/.infra-kit` or `~/.portless`. The checked-in sandbox is never modified.

## Play with it manually

```bash
pnpm exec turbo run build
pnpm exec infra-kit dev --target=shop/api       # or --target=shop/api,shop/ui, or no flag for the wizard
```

Then edit `packages/lib-core/src/version.ts` and watch the backend restart.
