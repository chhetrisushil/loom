# Surface-area audit — is loom bloated?

- Status: **Verdict recorded. Not bloated in code; bloated in NAMES.** Nothing is decided here —
  the staged proposal in §5 needs a decision per stage, and stages 2–3 change public import
  paths, which is an ADR's job rather than an audit's.
- Date: 2026-09-11
- Question, as asked: *"audit if loom has become bloated or not — if yes, what can we do to
  unbloat it while keeping all the benefits intact"*, with the stated lens of **DX and agentic
  application development**.
- Method: measurement first. Every number below is reproducible from the repo; the scripts are
  described inline so a later pass can re-run rather than re-derive. This is the inverse of every
  other evaluation in this folder — those asked *should we add this*; this one asks *what should
  we have refused, and can we still refuse it*.

---

## 1. The verdict in three numbers

| | |
|---|---|
| **56,467** | lines of non-test source across the entire framework — 72 packages, averaging 780 LOC each |
| **4%** | of exported VALUES (39 of 875 functions/classes/constants) are referenced nowhere outside their own package, docs included |
| **10** | kernel syscalls, `KERNEL_ABI` 1.1.0, unchanged through every arc this year |

The code is small, alive, and the kernel held the line it was designed to hold. **The weight is
in the surface a person has to learn**, and it lands precisely where the question is pointed: at
someone building an agentic app.

### The growth already stopped

Package creation, by month of first commit:

```
2026-07   67  ████████████████████████████
2026-08    4  ██
2026-09    1  █
```

Sixty-seven of seventy-two packages landed in one July build-out. The
[second-consumer rule](../adr/0083-second-consumer-rule.md) arrived **2026-08-12**, and of the
five packages since, four have real consumers (`learning` — a 3P policy; `plugin-mcp-app` — an
example; `knowledge` — two; `bench-throughput` — a tool). The fifth, `replay-inspector`, predates
the rule by a month.

**So this is not runaway growth. It is an un-pruned burst, plus an antibody that cannot reach
backwards.** That distinction decides the whole remedy: the fix is a one-time prune and a
retroactive check, not a policy change.

---

## 2. Where the weight actually is

| Cost | Measurement |
|---|---|
| **Names to learn** | 72 packages. Eight are under 200 LOC: `plugin-kit` 44, `registry` 45, `live-query` 94, `orchestrator` 105, `saga` 109, `plugin-sentinel` 110, `graph-executor` 110, `worker-runtime-local` 163. Each costs a `package.json`, a tsconfig, a build task, an api-reference section, a docs row, a version — and a name |
| **"Start here" costs ten names** | `loom-starter`, described as *"the smallest example that shows the way you build a Loom app today"*, is **186 lines of source importing 10 `@loom/*` packages** (32 on disk after closure), and teaches Cloud Run placement, remote workers and SQLite along the way |
| **The barrel nobody uses** | `@loom/sdk` re-exports 205 values from 20+ packages so that an app depends on one name instead of a dozen. **Zero examples import it** — including the starter. The device built to collapse the surface is maintained for no one |
| **Six inert libraries** | `isolate` (643 LOC, K7 data-plane isolation — referenced outside itself only in *comments*; no code path wires it) · `replay-inspector` (1,039 LOC, while `loom inspect` ships its **own** inspector in `tools/cli/src/inspector.ts`) · `fair-scheduler` (302 LOC, a drop-in implementation of `@loom/scheduler`'s own interface, no consumer) · `saga` (109) · `plugin-sentinel` (110) · `sdk` |
| **An advertised consumer that does not exist** | `docs/examples.md` states that `db-sentinel` uses `sentinelPreset`. It does not: the example imports ten packages and `@loom/plugin-sentinel` is not among them. The only named consumer of that plugin is fiction — which is the [vacuous-check pattern](../adr/0083-second-consumer-rule.md) wearing a catalogue entry |
| **Confusable pairs** | `orchestrator` (approval decisions + `dispatchPlan`) vs `orchestration` (child executions) — unrelated jobs, one letter apart; a previous audit already had to record *"not a typo"*, which is itself the cost. `scheduler` vs `fair-scheduler` |
| **Config surface** | **26 top-level `defineConfig` keys** (47 including the nested `security`/`observability`/`durability`/`execution`/`checks` groups), of which **7 are `*Modules` twins** of keys that already exist (`flows`/`flowModules`, `memories`/`memoryModules`, `projections`/`projectionModules`, …) |
| **Authoring constructs** | 11 builders (`flow$ step$ handler$ tool$ agent$ skill$ memory$ policy$ projection$ schedule$ instructions$`) |

---

## 3. What the measurements do NOT say

Stated explicitly, because a surface-area audit is the easiest place to manufacture alarm:

- **There is no meaningful dead code.** 4% of exported values unreferenced is low, and most of
  those are constants a consumer never names (`MCP_INVOKE_TOOL_ID`, `DEFAULT_BUCKETS`).
- **Type exports are not waste.** An exported interface that appears in a signature is public
  whether or not anyone types its name; a naive count flags ~21% and means nothing.
- **Package count is not the metric.** `orchestration`, `saga` and `live-query` do genuinely
  different jobs; merging them to shrink a number would trade a real distinction for a cosmetic
  one. The metric is *how many names a person must hold to do the common thing*.
- **The plugin tier is fine.** 18 plugins for 11 seams, each an adapter behind an SPI, is the
  shape [ADR 0043](../adr/0043-plugin-packaging-and-1p-3p-separation.md) intended.

### Two measurement traps, recorded so the next pass avoids them

1. **`\b` does not bound a `$`.** A dead-export sweep using `grep '\bflow$\b'` reports every
   builder — `flow$`, `blueprint$`, `agentLoop$` — as unused. The first run of this audit said
   74 dead values; with fixed-string matching for `$`-suffixed names it is 39.
2. **`dependencies` alone under-counts consumers.** `@loom/conformance`, `@loom/testing` and
   `@loom/dst` are devDependencies everywhere they are used; counting only runtime deps makes
   three healthy packages look orphaned.

---

## 4. The one finding that is a defect, not a trade-off

`docs/examples.md` names `sentinelPreset` as what `db-sentinel` demonstrates, and it does not use
it. Either the example should adopt the preset it is documented to show, or the plugin has no
consumer at all and the catalogue should stop claiming one. This is worth fixing regardless of
what happens to the rest of the proposal, and it is the retroactive form of the second-consumer
rule: **a 1P package whose only named consumer turns out not to use it is app code that escaped.**

---

## 5. Proposal — five stages, ordered by payoff against risk

Each stage stands alone. Nothing here removes a capability.

### Stage 1 — Make the barrel real *(no API change; the biggest DX win)*

Point `loom-starter` and the quick-start at `@loom/sdk`: the first thing anyone reads goes from
**ten package names to one**. Split the starter so compute placement moves to
`compute-cloudrun`, where it is the subject rather than the background.

If the barrel is not good enough to build the starter from, that is a bug in the barrel worth
finding now; if it is, nothing justifies the starter importing ten packages by hand.

### Stage 2 — Fold the micro-packages into their natural parents *(re-export; no capability loss)*

`fair-scheduler` → `@loom/scheduler` (it implements that package's interface) · `worker-runtime-local`
→ `@loom/worker-runtime` (the reference implementation of that SPI) · `plugin-kit` + `registry` →
`@loom/app` · resolve `orchestrator`'s name against `orchestration`. Roughly **72 → 64 names**,
with every export still reachable.

### Stage 3 — Retire the inert *(needs a decision per package)*

- **`isolate`** — 643 LOC of K7 isolation that no code path reaches. Either wire it (it is a
  documented ring of the hardening model) or retire it; what it cannot stay is documented and
  unreachable.
- **`replay-inspector`** — fold into the CLI, which already ships a second implementation of the
  same idea. Two inspectors, one of them dead, is the clearest duplication in the repo.
- **`plugin-sentinel`** — adopt it in `db-sentinel` or delete it. See §4.

### Stage 4 — Collapse the `*Modules` twins *(config ergonomics)*

One key per construct, accepting either a module namespace or a definition list. **26 → 19**
top-level `defineConfig` keys, no capability removed.

### Stage 5 — Guard it *(so the prune does not have to happen twice)*

A fitness test asserting every 1P package has a consumer — in-repo, in an example, or in a 3P
plugin — with an exemption list whose entries state a reason, exactly as `NOT_A_CAPABILITY` and
`NO_CHANGELOG_ENTRY` do. The second-consumer rule currently lives in review; this is the half
that can be enforced, and it is what stops a future July from accumulating silently.

---

## 6. What this audit is not deciding

Stages 2 and 3 change public import paths. That is an ADR's decision, not an audit's, and it
should record the migration story (re-export shims, a deprecation window, or a deliberate break)
before any of it is written. Stage 1 and Stage 5 are additive and could proceed on their own.

## Appendix — how to re-run this

- **Inventory** (LOC, exports, in-repo dependents, example imports per package): walk
  `packages|plugins|tools`, count non-test `.ts` lines, parse `dist/index.d.ts` for exported
  names, build the dependent map from `dependencies` **and** `devDependencies`, and grep the
  examples repo for `@loom/<name>`.
- **Orphans**: a package with zero in-repo dependents, zero example files and zero 3P-plugin
  files. Exclude binaries (`cli`, `create-loom-app`, `bench-throughput`).
- **Dead values**: `Object.keys(require(dist))` per package — runtime exports only, since types
  cannot be "implicitly used" — then grep the workspace, the examples, the 3P plugins and `docs/`
  for each name, matching `$`-suffixed names as fixed strings.
- **Growth**: `git log --diff-filter=A --format=%ad -1 -- <pkg>/package.json`, bucketed by month.
- **Closure**: transitive `@loom/*` `dependencies` from an entry point — `@loom/app` pulls 23,
  `@loom/sdk` 31, `loom-starter`'s ten direct imports reach 32.
