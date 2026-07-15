# ADR 0059 — Streaming content ingestion: `putStream` + stream-typed claim-check results

- Status: **Accepted — shipped** (`ContentStore.putStream` optional SPI method,
  `streamResult`/`resolveClaimCheckBytes` in `@loom/middleware`)
- Date: 2026-07-15
- Builds on: [the db-copilot infrastructure requirements](../requirements/2026-07-15-db-copilot-infrastructure.md)
  (§3 ST, issue #186), ADR 0046 (`ContentStore`), ADR 0054 (claim-check).
- Part of: the db-copilot infra series (ST-1/2). No kernel changes; KERNEL_ABI and
  EVENT_SCHEMA untouched.

## Context — and the recorded rejection this bounds

The copilot's large captures (table samples, shadow-execution output, lock graphs) are
memory-bound today: `ContentStore.put` takes full bytes, and the claim-check middleware
`JSON.stringify`s whole results. The requirements' ST-R verdict (recorded, not reopened here)
rejected durable kernel streams/pipes — chunks-as-events breaks the fold economics ADR 0054
exists to protect. What remains is the sound half: **streaming as a transport on the transient
side of the determinism boundary, with only the outcome durable** — the same discipline as
effect execution, warming, and `now()` injection.

## Decisions

### D1 — `putStream` is an optional `ContentStore` method with an outcome contract (ST-1)

`putStream?(stream: AsyncIterable<Uint8Array>): Promise<ContentRef>` — the returned ref MUST
be the content address of the full streamed sequence, idempotent by that address, exactly as
if `put(concat(chunks))` had been called. **How** is backend business (requirements §6.3
resolved): the reference implementation hashes while spooling; an object-store backend that
cannot choose its key before completion may hash-while-upload and verify/re-key on finalize.
Conformance pins the contract structurally (streamed address ≡ whole-buffer address, faithful
round-trip, idempotent) and skips backends that omit the method. Node `Readable`s satisfy the
iterable directly.

### D2 — Stream-typed tool results: the tool streams, the envelope is the value (ST-2)

A tool returns `streamResult(stream, { digest, codec })`; the middleware pipes it into
`putStream` through a byte-counting wrapper — the only thing between the tool and the store,
so the worker heap never holds the payload — and records
`{ __loomClaimCheck, ref, size, digest?, codec }`. Three deliberate asymmetries with the
classic offload path:

- **Always offloads** — a stream is a declared-big payload; there is no cap check (and no
  sound way to measure without consuming).
- **The digest comes from the tool**, not the per-tool `digests` map: the bytes are consumed
  by the upload, so no post-hoc projection exists. The tool computes it while producing
  (row counts, max values) — still the CC-2 purity contract.
- **The envelope carries a `codec`** (default `"bytes"`): stream content is not JSON.
  `resolveClaimCheck` refuses non-JSON codecs loudly; `resolveClaimCheckBytes` is the
  read-side path — same outside-the-determinism-boundary rule as CC-4.

A store without `putStream` refuses a streamed result with a typed error — the effect fails
loudly rather than silently buffering.

### D3 — Determinism unchanged, by construction

The recorded value is the envelope; replay folds it and never touches the store (ADR 0054's
contract). A crash-recovery re-run re-produces the stream → same bytes → same address → an
identical envelope (`putStream` idempotence is what makes the at-least-once re-run safe).

## Consequences

- Copilot tools can hand back Node streams without buffering; memory ceilings stop being a
  tool-author problem. The future object-storage backend gets the SPI shape multipart upload
  wants.
- `resolveClaimCheck` gained a codec guard — a behavioral tightening only for envelopes that
  could never have parsed anyway (they did not exist before this ADR).
- The K10.6 pin/sweep machinery applies to streamed refs unchanged (refs are refs).
