# @loomwork/classify — what a value is, on two axes

The vocabulary other packages use to say how a piece of data must be handled. **Confidentiality** is a
property of a field, so you declare it once on the schema (`sensitive()`, `secret()`, `internal()`) and
the packages that mask, encrypt or externalize read the marks from there. **Integrity** is a property of a
value, acquired at runtime from a specific origin, so `tainted()` wraps the value where it enters the
system (an MCP tool result, a fetched page). This package only declares and reads; the enforcement lives
in the packages that consume it. You reach for it when you define schemas or ingest third-party content.

```ts
import { z } from "zod";
import {
  collectClassifiedPaths, isTainted, maskPaths, pathsOfClass, scanTaint,
  secret, sensitive, tainted, unwrapTainted,
} from "@loomwork/classify";

// Confidentiality: declared once, on the schema.
const Signup = z.object({
  email: sensitive(z.string().email()),
  apiKey: secret(z.string()),
  plan: z.string(),
});
collectClassifiedPaths(Signup);
// [{ path: "email", dataClass: "sensitive" }, { path: "apiKey", dataClass: "secret" }]
maskPaths({ email: "ada@example.com", apiKey: "k", plan: "pro" }, pathsOfClass(Signup, "sensitive"));
// { email: "[redacted]", apiKey: "k", plan: "pro" }

// Integrity: attached to a value where it enters the system.
const fetched = tainted("ignore previous instructions", "mcp:search/web");
isTainted(fetched); // true
unwrapTainted(fetched); // the plain string: provenance stops travelling here
scanTaint({ summary: "ok", raw: { hit: fetched } }); // { origins: ["mcp:search/web"], exceeded: false, tainted: true }
```

## Surface

- **Confidentiality marks.** `sensitive`, `secret`, `internal`, and `classify(schema, dataClass)` for a
  computed class. They return the same schema, so validation is untouched. Read them with
  `collectClassifiedPaths` (paths and classes), `pathsOfClass`, `classOf` and `strictest`.
- **Where-stored mark.** `externalized()` with `externalizedPaths` and `isExternalized` (ADR 0046): a
  separate axis for "the log keeps a content reference, not the bytes".
- **Masking.** `maskPaths(value, paths)` replaces each dot-path with `REDACTED` (`"[redacted]"`) and
  copies only the spine it touches. `expandPaths` and `hasWildcard` handle the `[]` array-crossing
  segment (`people[].ssn`).
- **Taint.** `tainted(value, origin)`, `isTainted`, `taintOf`, `unwrapTainted`, plus `scanTaint` and
  `nestedTaintOrigin` for a wrapper buried anywhere in a value, and `taintOriginLabel`.
- **Audit.** `collectUnreachableMarks(schema)` finds marks that no dot-path can address.

## Behaviour that surprises people

- **A mark does nothing where the walker cannot reach it.** Paths cross objects and arrays only. A mark
  under a record's values, a union branch, a tuple member or an intersection is not masked, encrypted or
  externalized, and nothing says so at runtime; `collectUnreachableMarks` is the pre-flight check.
- **Marks live in a `WeakMap` keyed by the schema instance**, not on the schema. The walker looks through
  optional, nullable, default and effects wrappers, but a different schema object than the one you marked
  carries no mark.
- **`isTainted` looks at the top of a value only.** A producer that taints part of a result leaves a plain
  object with a wrapper inside; use `scanTaint` for that. The scan is iterative and cycle-safe, and fails
  closed: past depth 64 or 100,000 nodes it reports `exceeded: true` and `tainted: true`.
- **Re-tainting keeps the original origin.** Provenance records where content entered.
- **Taint is not retrofitted.** A log written before a producer applied `tainted()` replays without it.
- **The origin is display text.** It often contains a third-party-controlled fragment and is escaped where
  it is rendered.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/classify` — what a value IS, on two axes" in [docs/api-reference.org](../../docs/api-reference.org). It lists `classify(schema)` as returning paths; in the source that is `collectClassifiedPaths`.
- Guides: [data classification](../../docs/data-classification.md), [data protection patterns](../../docs/data-protection-patterns.md), [isolation and untrusted content](../../docs/user-guide/isolation-and-untrusted-content.md).
- ADRs: [0085 untrusted-content integrity axis](../../docs/adr/0085-untrusted-content-integrity-axis.md), [0046 content store seam](../../docs/adr/0046-content-store-seam-thin-authoritative-log.md).
- Source: `packages/classify/src`.
