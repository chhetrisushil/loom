# ADR 0076 — Array crossings in classification paths: expand late, walk once

- Status: **Accepted** (2026-08-09)
- Date: 2026-08-09
- Builds on: [ADR 0028](0028-runtime-verification.md) (the `classification-reachability`
  check, which existed to report exactly the gap this closes), K10-R1 data classification,
  K10.2 field-level encryption, [ADR 0046](0046-content-store-seam-thin-authoritative-log.md) (content
  externalization).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged
  (1.1.0); EVENT_SCHEMA unchanged (1.17.0); EVENT_STORE_SPI unchanged (1.3.0)** — no new
  syscall, event type, or SPI method. One new pure function in one package, plus a one-line
  change in each of three existing appliers.

## Context

`sensitive()`, `secret()` and `internal()` mark fields in a Zod schema. `collectMarkedPaths`
walks the schema and turns those marks into dot-paths, which three sinks then apply to a
concrete payload:

| sink | applier | effect |
| --- | --- | --- |
| telemetry / egress scrubbing (K10-R6) | `maskPaths` (`@loom/classify`) | replaces the value with `[redacted]` |
| field-level encryption (K10.2) | `mapPaths` (`@loom/plugin-crypto`) | AES-256-GCM envelope at append |
| content externalization (ADR 0046) | `mapPathsAsync` (`@loom/plugin-content`) | value → content-addressed ref |

The walker descended objects only. A mark inside an array element — `z.array(z.object({ ssn:
sensitive(z.string()) }))`, an entirely ordinary shape — produced **no path at all**, so all
three sinks did nothing. The field was not masked on egress, not encrypted at rest, not
externalized. Nothing failed; nothing warned. The developer wrote `sensitive()` and got
silence.

The package audit (issue #260) found this. The immediate response was
[ADR 0028](0028-runtime-verification.md)'s `classification-reachability` rule: fail the build
rather than leak quietly. That was the right first move — it converted a silent leak into a
loud error — but it is a guard rail around a hole, not a floor over it. The shape is common
enough that "restructure your schema" is a poor answer.

## Decision

**Teach the path language one thing: `[]`, an array crossing.** `people[].ssn` means "the
`ssn` of every element of `people`". The walker emits it; the sinks consume it.

The design question was where array semantics live. Three near-identical spine-walkers already
exist, each with its own structural-sharing copy loop, each independently proven. Teaching all
three to fan out over arrays would triple the surface where an off-by-one or a lost `Array.isArray`
becomes a data leak — and they would inevitably drift.

So: **expand late, walk once.** A single pure function, `expandPaths(root, paths)`, resolves
every `[]` against the concrete value and returns ordinary indexed paths:

```
people[].ssn  +  { people: [ {ssn}, {ssn} ] }   →   ["people.0.ssn", "people.1.ssn"]
```

Those are paths the existing appliers *already handle* — `array["0"]` is a normal property
access, and each applier's spine copy already preserves arrays. Every walker stays exactly as
it was. Array semantics exist in one file, with one test suite.

Each applier gains one line:

```ts
const targets = hasWildcard(paths) ? expandPaths(root, paths) : paths;
```

### Why expand against the value, not the schema

The schema knows a field is an array; only the value knows it has four elements. Expanding at
wiring time would require a length that does not exist yet. Expanding per payload costs one
extra pass over the marked paths — and the `hasWildcard` guard means a payload with no array
marks pays nothing at all.

Determinism is unaffected: expansion is a pure function of the value being written, so replay
of the same payload produces the same paths (P2).

### Consequences that had to be gotten right

- **`maskPaths` copied spine nodes with `{ ...child }`**, which turns an array into a plain
  object with numeric keys. Harmless while paths never crossed arrays; corrupting the moment
  they do. It now uses the array-preserving copy the other two appliers already had. This was
  a latent bug — reachable today by hand-writing an indexed mask path — not only a
  consequence of this change.
- **A `[]` that does not resolve expands to nothing.** Absent field, `null`, or a non-array
  where the schema promised one: nothing is masked or encrypted for that path. Failing closed
  on the *path* (skip it) matches the appliers' existing treatment of absent paths.
- **Backward compatibility is structural, not asserted.** A path containing no `[]` is
  returned untouched and unchecked. Every path that worked before takes a code route that did
  not change.
- **Old logs still read.** `decryptValue` passes non-envelope values through unchanged
  (deliberate, for pre-wrap logs), so events written before an array field started being
  encrypted still fold correctly.

### The reachability rule narrows rather than retires

`collectUnreachableMarks` had to change in lockstep: left alone it would report every array
mark as broken — a false positive on working code, which is worse than the original silence.

It is retargeted, not deleted, because containers the walker still cannot address remain:
`z.record` values, `z.union` branches, `z.tuple` members, `z.intersection` sides. A mark under
any of those is still inert, so the rule keeps its `error` severity and keeps earning its
place. Findings now name the blocking container (`byId.<record>.ssn`, `container: "record"`)
so the fix is locatable. `z.lazy` is deliberately not searched — descending a recursive schema
to hunt for marks risks non-termination for little gain.

Those containers are not given `[]`-style crossings because there is no stable index to expand
to: a record's keys are open-ended, and a union's branch is not known until the value is
validated. Marking the container itself covers the subtree as a unit and is the honest answer.

## Alternatives rejected

- **Wildcard `*` instead of `[]`.** `*` is a legal object key, so `a.*.b` is ambiguous with a
  literal field named `*`. `[]` cannot collide with a JS property name in the dot-path grammar
  and reads as "array" without a legend.
- **Teach each applier to fan out over arrays.** Rejected above: three copies of the most
  security-sensitive loop in the codebase, free to drift.
- **Expand at wiring time from the schema.** Impossible — element count is a property of the
  value.
- **Leave it to the lint (do nothing).** The lint tells a developer their correct-looking
  schema is unsupported and asks them to restructure their data model to satisfy the
  framework. Marking a field inside a list of records is not an exotic request.

## Consequences

Marks inside arrays now mask, encrypt and externalize, at any nesting depth, including
array-of-array (`grid[][].v`). Content externalization dedups identical elements to one blob,
which falls out of content addressing for free.

The `classification-reachability` rule now fires only on genuinely unaddressable containers,
so a passing build means something narrower and truer than it did.

No public API is removed. `expandPaths` and `hasWildcard` are exported from `@loom/classify`
for anyone writing a fourth sink — the point being that they should not write a fourth walker.
