# Examples moved to `loom-examples`

The runnable examples now live in the sibling repository **`loom-examples`**
(`git@github.com:chhetrisushil/loom-examples.git`), mirroring how third-party
plugins live in `loom-plugins`. This keeps the framework/kernel repo focused on
the packages themselves.

## Why they moved

Every example depended on the workspace's `@loom/*` packages and added ~15 build
+ test tasks to this repo. Loom is unpublished, so the examples resolve those
packages from a sibling `../loom` checkout via `link:` (pnpm `overrides`) instead
of `workspace:*`. See `../loom-examples/AGENTS.md` for the full mechanism.

## Getting them

```
workspace/
├── loom/            # this repo:            pnpm install && pnpm build
└── loom-examples/   # git clone, then:      pnpm install   (resolves @loom/* from ../loom)
```

```bash
git clone git@github.com:chhetrisushil/loom-examples.git
cd loom-examples && pnpm install
pnpm --filter @loom/db-observability start
```

## Evaluating usage patterns without cloning

- **[docs/examples.md](../docs/examples.md)** — the catalogue: each example, the
  pattern it teaches, and the loom APIs/ADRs it exercises.
- **[AGENTS.md](../AGENTS.md)** — the same index plus the sibling-checkout / `link:`
  wiring, written for AI coding agents.
