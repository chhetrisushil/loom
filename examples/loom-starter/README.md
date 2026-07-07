# loom-starter — the canonical new-architecture example

The smallest example that shows **the way you build a Loom app today**. A compact
**release-approval** workflow — assess risk → (pause for a human) → apply — wired
with every current best-practice primitive:

| Feature | Where |
|---|---|
| **`defineConfig`** composition root | [`src/config.ts`](src/config.ts) |
| **Folder convention + `loom gen`** (static `loom.gen.ts`) | [`app/flows/release-approval/flow.ts`](app/flows/release-approval/flow.ts) → `app/loom.gen.ts` |
| **Effect middleware** (retry w/ backoff) | `effectMiddleware: [retryMiddleware(...)]` in `src/config.ts` |
| **Durable suspend / resume** | `ctx.suspend(...)` in the flow, `runtime.resume(...)` in `src/main.ts` |
| **`@loom/testing`** (createTestApp, waitForPhase) | [`test/release-approval.test.ts`](test/release-approval.test.ts) |
| **Log-as-fixture evals** | [`evals/happy-path.json`](evals/happy-path.json) + `loom eval` |
| **Deploy simulation** | [`src/deploy.config.ts`](src/deploy.config.ts) + `loom deploy check` |
| **Pluggable compute seam** | [`src/compute.ts`](src/compute.ts) |

## Run it

```bash
pnpm install
pnpm --filter @loom/loom-starter gen     # regenerate app/loom.gen.ts from app/flows/**
pnpm --filter @loom/loom-starter build
pnpm --filter @loom/loom-starter start   # start → pause at gate → resume → release
pnpm --filter @loom/loom-starter test    # @loom/testing suite (incl. retry proof)
```

## Inspect the durable log (after `start`)

```bash
loom logs   --db .data/events.db <executionId>       # tail the event timeline
loom debug  --db .data/events.db <executionId> --at 4 # time-travel to sequence 4
loom inspect --db .data/events.db <executionId>       # web timeline + slider
```

## CI gates

```bash
pnpm --filter @loom/loom-starter record:golden   # (re)capture evals/happy-path.json
pnpm --filter @loom/loom-starter eval            # replay golden vs expectations
pnpm --filter @loom/loom-starter deploy:check    # replay history vs THIS build's flows
```

## The folder convention

```
app/
  flows/
    release-approval/
      flow.ts        ← you write this (step$ / handler$ / flow$ + runner)
  loom.gen.ts        ← `loom gen` writes this: static `export const flowModules = [...]`
src/
  config.ts          ← defineConfig({ storage, surfaces, flowModules, effectMiddleware })
  main.ts            ← start / suspend / resume driver
  deploy.config.ts   ← getFlow resolver for `loom deploy check`
  compute.ts         ← the local→remote→Cloud Run dispatcher seam
test/                ← @loom/testing
evals/               ← golden fixtures for `loom eval`
```

`loom gen` turns the folder convention into a **static** module (build-time codegen,
not runtime globbing) so the flow set is identical on every resume and remote
worker — see [ADR 0011](../../docs/adr/0011-folder-convention-codegen.md).

## Learn more

[Getting Started](../../docs/getting-started.md) · [Usage](../../docs/usage.md) ·
[User Guide](../../docs/user-guide.md) · [Architecture](../../docs/architecture.md)
