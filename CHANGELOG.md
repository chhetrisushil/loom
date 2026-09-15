# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Durable leases: only one node pays for a duplicated wake (#380, L1–L2).** `TimerStore.due()`
  has no claim, so two nodes polling the same store both receive the same due timer, both
  resume, and both pay for every effect until one loses at the fence. Fencing (K9.4) makes that
  outcome *safe*, not *cheap* — and durable placement (#392) made the duplicate expensive on
  purpose, since a branch is placed precisely when its work is heavy.

  New optional `LeaseStore` SPI (`acquire` / `renew` / `expired` / `release`), shaped like
  `TimerStore`: `acquire` returns `null` when another owner holds an unexpired lease — that
  single `null` is the mutual exclusion "only one node should run this execution" needs — and
  `renew` returns `false` once ownership is lost, so a node declared dead stops believing it is
  alive. `InMemoryLeaseStore` ships with it, held to `runLeaseStoreConformance`.

  `TimerService` takes `leases: { store, owner, ttlMs? }` and claims before firing. A node that
  cannot claim skips **without completing the timer**, so a wake is never lost if the holder
  dies between claiming and resuming; ownership is released afterwards, because it covers the
  fire rather than the execution's whole life. Unwired, every path is byte-identical.

  `recoverAbandoned` then stops needing a predicate: with `leases` wired, **`isAbandoned`
  becomes optional** — an expired lease *is* the evidence the log cannot hold — and the scan
  narrows from every execution to every expired lease, which is the set you wanted. A predicate
  passed anyway is still asked, so it never becomes a lie, and the pass **claims** each orphan
  before re-driving it so two recovery passes racing the same one do not both pay for it.

  `SqliteLeaseStore` and `PostgresLeaseStore` ship with it. Acquisition is **one statement** on
  both — read-then-write would let several nodes each observe a free lease and all take it,
  which is the race the whole primitive exists to lose loudly. Verified against a real
  PostgreSQL 17, including twelve simultaneous acquires granting exactly one.

  Staged deliberately (`docs/requirements/2026-09-15-durable-lease.md`): the runtime does not
  yet hold a lease across a whole run, because renewal is a ticker on the owning process's
  event loop and a CPU-bound effect can starve it into declaring a healthy execution abandoned.
  That false positive is how this feature fails, and it is written down rather than buried in a
  TTL constant.

- **The audit chain can be verified by someone who could not have written it (#382,
  [ADR 0037](docs/adr/0037-tamper-evident-audit-chain.md) amendment).** The HMAC signature makes
  the log tamper-evident *against a third party who lacks the secret* — but verification needs
  that same secret, so anyone enabled to check the log can also rewrite it: re-chain the hashes,
  re-compute the HMACs, and it verifies cleanly. The verifier and the forger were the same role,
  which is exactly what an auditor must not be.

  The signature seam is now pluggable — `ChainSigner` / `ChainVerifier` — with `ed25519Signer`
  and `ed25519Verifier` shipped over `node:crypto` (no dependency, 64-byte signatures, nothing
  to parameterize wrongly). `ChainMetadata.keyId` names the signing key so rotation does not
  invalidate history; `hmacSecret` and `signer` are mutually exclusive because they make
  different promises; and `ChainVerification` gains **`signaturesChecked`**, so a hash-only
  `ok: true` can never be read as an authorship guarantee. An entry signed by a key the verifier
  does not know is **rejected, not skipped** — authorship that cannot be checked has not been.

  Loom still makes no trust-root decision: it signs with the key you hand it, exactly as it
  HMACs with the secret you hand it.

- **`defineConfig({ timers: { dispatcher } })`** — the composition-root half of #392. An app
  that places executions deliberately can now wire the wake path in one line, instead of
  building its own `TimerService` to get at the option.

- **Placement survives the process that chose it (#392).** `ExecutionPolicy` was a
  caller-side struct mapped to `DispatchMetadata` at dispatch time, so where an execution
  belonged lived in one process's memory. Invisible for an execution that runs once — and
  gone by the time anything re-drives one that suspended for a human, which is how a branch
  sized for a cloned database wakes up inside a web server.

  `start({ computeTarget })` now records the lane on the `EXECUTION_STARTED` anchor
  (sequence 0 — where `truncatePrefix` preserves it through compaction, `deleteExecution`
  removes it, and `metadata.fence` already established that operational data rides), and
  `placementOf(eventStore, executionId)` reads it back in one indexed point-read. **No
  syscall and no EVENT_SCHEMA change**: metadata is descriptive, nothing folds it, replay is
  byte-identical.

  Both wake paths can then use it. `TimerService` and `recoverAbandoned` take an optional
  `dispatcher` and dispatch an `ExecutionPackage` to the recorded lane instead of resuming on
  whatever runtime they happen to hold; without one, behaviour is unchanged. A fork
  **inherits** its parent's lane for free (the prefix copy carries the anchor's metadata) and
  `fork(…, { computeTarget })` overrides it — the case that matters, since a simulation
  branch is exactly the work you do not want on the parent's lane.

  It is a **hint, not a pin**: it is input to a `PlacementPolicy`, which may route elsewhere.
  A target that has since been retired must not strand the executions that named it, so
  `PlacementDispatcher` falls back — and now warns once per unknown name, because falling
  back silently is how an execution placed on sized compute ends up running somewhere else
  forever. That matters most in `recoverAbandoned`, where a node is often recovering an
  execution *because* its original lane went away.

- **Branch registry rows no longer outlive the executions they describe (BranchRegistry SPI
  1.2.0).** Two rows survive a reclaimed branch and nothing collected either. A **fork edge**
  described data that no longer exists — and `LogLifecycle` walks `children()` on every sweep,
  so dead edges make retention slower forever, in proportion to every fork ever taken; the new
  optional `removeLineage(executionId)` is called at the one point where the id is known and
  the data is provably gone, inside `applyRetention`'s delete. A **ref** survives it too, and
  that is worse than untidy: `promote(ghost, "main")` succeeds, leaving `main` naming an
  execution that cannot be read, resumed or replayed. `pruneBranchRefs(eventStore, registry)`
  pages over `listRefs` and deletes refs whose execution has no events — and takes **no
  predicate**, because unlike "is this branch abandoned" (someone's open question, only the app
  can judge), "the execution is gone" is a fact. It protects `main` by default and *reports* it
  as dangling instead: turning "main names a ghost" into "there is no main" makes the problem
  harder to diagnose, not easier.

- **`retireAbandonedBranches()` — a forked parent could never be reclaimed.** `applyRetention`
  refuses anything non-terminal, and refuses a parent while a live descendant branch still has
  events (R5.3, correctly: the fork's copied prefix aliases the parent's). A branch that was
  forked, simulated and then never answered is suspended *forever* — so it is never reclaimed,
  so its parent is never reclaimed either: `blocked-by-branch`, every sweep, permanently. The
  retention policy quietly stopped applying to exactly the executions that did the most work.

  The lever is not deletion. An abandoned branch should become **terminal**, which `cancel()`
  already does durably and auditably — `EXECUTION_CANCELLED` records that the branch was
  abandoned and why, rather than erasing that it existed — after which ordinary retention
  collects the branch on its own TTL and the parent unblocks behind it. The new pass is
  parent-centric (bounded by one parent's children, no global scan), and `isAbandoned` is
  **required with no default** for `recoverAbandoned`'s reason: a branch parked on a human gate
  is someone's open question, not garbage, and only the application knows whether that person
  is still coming. It reports what it left alone, so "still open" is an answer rather than a
  silence.

- **A declared deadline no runtime can honour now says so.** `suspend({ timeout })` becomes a
  durable `wakeAt` only when a `TimerStore` is wired; unwired, the condition is committed
  *without* one — byte-identically, and silently. That is invisible while everything runs in
  one process and becomes a permanently parked execution the moment compute is split: a
  worker built as "a runtime with the flows registered" discards every timeout of every
  execution it suspends, and nothing downstream can tell "no deadline" from "the deadline was
  dropped on the machine that suspended". `WorkflowRuntime` now warns at exactly that point,
  once per (flow, gate), naming both and pointing at `loom verify`'s `suspension-safety` rule
  — which catches it statically, if you run verify against the composition that suspends.
  Routed through a new `onWarn` dep (defaulting to `console.warn`, like `defineConfig`'s
  warning for schedules that can never fire) and wired to `defineConfig({ onWarn })`. The log
  is untouched: this is a diagnostic, not a behaviour, and a test pins the committed condition
  byte-for-byte.

- **`fork()` no longer reads the parent's whole log (EventStore SPI 1.4.0).** It needed the
  tip to validate a fork point and was calling `read()` to get it — materializing every event
  of a long-lived parent, including the entire tail *above* the fork point, and paying that
  even when the store could copy the prefix natively. The SPI gains an optional
  `head(executionId)` (one indexed `MAX(sequence)`; `headOf()` falls back to reading for
  stores that omit it), and `fork()` now reads exactly one window: the tail a snapshot does
  not already cover, widened to the full prefix only when the copy itself needs it (no native
  `copyPrefix`, or live projections that must see the copied events). In the common case — a
  branch forked at a durable gate, where the suspend path has just checkpointed — it reads
  **no events at all**. Implemented natively on SQLite/Postgres/in-memory and forwarded by
  every store decorator (tenant-scoping, coalescing, sharding, profiling, content-resolving,
  hash-chaining, encrypting), so a capability probe behaves the same through a wrapper stack.

- **`BranchRegistry.promote` can be a compare-and-set, and `listRefs` can be paged
  (BranchRegistry SPI 1.1.0).** `promote(from, to)` was read-then-write on every backend, so
  two nodes promoting different winners onto `main` both succeeded and the loser silently
  became what `main` named — a pointer move with no way to say *"only if it still names what
  I read"*. It now takes `{ expect }`: the executionId `to` must name right now, or `null`
  for "must not exist yet". A mismatch throws `BranchPromotionConflictError` and **nothing
  moves**, so a caller re-reads and decides rather than retrying blind. Each backend does the
  check where it is actually atomic — one `UPDATE … WHERE execution_id = $expected` (or an
  `INSERT … ON CONFLICT DO NOTHING`) on Postgres, inside a transaction on SQLite, and
  in-process for the Map. Omitting `expect` keeps 1.0.0's last-write-wins behaviour
  byte-identically. `listRefs({ limit, after })` adds keyset paging for a ref table that is
  unbounded by design — forking is cheap — and the shared `assertListRefsLimit` guard refuses
  a non-positive or fractional `limit` on every backend, because `LIMIT -1` is SQLite for *no
  limit* and would hand the whole table to a caller that asked for one row.

  Found while writing the conformance cases: **the Postgres `BranchRegistry` had never been
  run against the conformance kit at all.** SQLite was held to the portable contract while
  the Postgres implementation — the one with hand-written SQL — was merely assumed to match
  it. `plugins/postgres/src/conformance.test.ts` now runs `runBranchRegistryConformance`
  too (verified against a real PostgreSQL 17: 71/71, up from 64).

- **Recovering executions whose supervisor died ([ADR 0004](docs/adr/0004-failure-recovery.md)
  amendment).** A dead or wedged *worker* was already handled: the dispatcher's
  `executeTimeoutMs` turns a hung attempt into a failed one, redispatches, and the worker
  resumes idempotently from durable state. What that cannot cover is the *supervisor* itself
  dying — detection lives in the dispatcher's process memory, so killing that process leaves
  an execution `running` in the log with no owner. Loom cannot resolve this from the log:
  a `running` execution owned by a healthy node elsewhere is byte-identical to an orphaned
  one, because the difference is a fact about your cluster. `recoverAbandoned(runtime, {
  source, isAbandoned })` (`@loom/workflow-runtime`) therefore does everything *except*
  decide — enumerate, filter to `running`/`pending`, ask your predicate, and resume what it
  claims through the same `EXECUTION_RECOVERED` path the worker uses under redispatch.
  `isAbandoned` is **required with no default**: `true` would preempt live work on other
  nodes, `false` would be a pass that silently recovers nothing while reading as coverage.
  Run it from a cron or a Kubernetes Job — it is a maintenance pass, not a service. A
  `LeaseStore`/heartbeat SPI that would let Loom answer the question itself is deliberately
  deferred to a second consumer ([ADR 0083](docs/adr/0083-second-consumer-rule.md)).

- **A query is an input, and an input has a bound (MemoryStore SPI 2.0.0 → 2.1.0).** Terms are
  OR-ed, so a repeated term is the same term — it cannot change which entries match, only how
  long a store takes to say so. A 128 KB question repeating one word 20,000 times built a
  20,000-clause FTS5 `MATCH` and took `SqliteMemoryStore` **32.7 seconds**: a denial of service
  bought from a text box, on a call any agent makes with whatever a user typed. `queryTerms`
  now deduplicates and caps at `MAX_QUERY_TERMS` (256, far past any real question, and the
  point at which distinct terms stop being signal), and all three backends derive their terms
  from it. It degrades rather than refuses — the choice `searchableText`'s depth limit already
  makes — and a similarity backend, which derives no terms, is unaffected. The same bound is
  applied to `SkillRegistry.find` and `CapabilityCatalog.find`, whose keyword scoring is
  `O(entries × terms)` of substring searches over an equally unbounded query.

- **A pin map is read as data, never as an object.** A derivation id is an untrusted string —
  the premise of ADR 0088 is that a model may have composed the blueprint that names it — and
  `{}["__proto__"] = version` sets a prototype instead of adding a key. The pin vanished,
  `Object.keys` never saw it, and the binding dropped out of `checkBlueprintPins` entirely:
  `compared` counted one fewer and **no finding was raised**, which is precisely the silent
  omission the seam exists to prevent. Every pin map is now built without a prototype
  (`blueprintPins`, `checkBlueprintPins`, `InMemoryProjectionRuntime.pins`,
  `ReadModelService.pins`/`checkPins`) and every read is an own-property read, so a derivation
  called `constructor` or `toString` can no longer be answered for by `Object.prototype`.
  `parseArgs` gets the same treatment: with a prototype, `flags["valueOf"] ?? fallback`
  answered with a function for a flag nobody passed.

- **The binding-semantics pin — a content address that freezes a name, not a meaning.** A
  composed surface is content-addressed, and `docs/composed-surfaces.md` listed *bindings* among
  the things that address freezes, under the heading "the meaning of a view never changes
  silently". It froze `{ projectionId, path }` — a **name**. The projection behind it is live code
  registered under that name with no version, so the query, the filter predicates, the join keys,
  the aggregation and the window all sat on the floating side, and editing a fold changed what
  every pinned view meant under an unchanged hash. The same hole was a live defect in
  `plugins/read-model`, where an edited `extract` leaves old rows in place, the watermark already
  past them, one `query` answering from two extractors, and `rebuild()` the fix nobody is told to
  run. An optional declared `version` on `ProjectionDefinition` / `Projection` /
  `ReadModelDefinition` (declared, not derived — `flowContentHash` excludes handler code for the
  same reason a fold closure has no stable fingerprint), `checkVersionPins(recorded, current)`
  reporting `drift` as an error and `unpinned` as a warn with the side it is missing from, and
  `compared` as the denominator so `ok: true` over nothing cannot read as a pass. The recorded pin
  rides in `Blueprint.projectionVersions`, inside the content address rather than beside it — a
  test asserts two views differing only in their recorded versions hash differently, which is
  what makes the recipe's frozen list true rather than aspirational. `projectionRuntime.pins()`
  is what a composer records; `checkBlueprintPins(view, pins)` is what a render compares.
  Second consumer, wired: `ReadModelService.pins()` / `checkPins(recorded)` — a query, like
  `identityDiff`, that reports what is wrong without rebuilding anything (ADR 0095).

- **Row-granular `purge` on the read-model store SPI (1.0.0 → 1.1.0).** Erasing one subject
  from a read model used to mean `clear` + rebuild — work proportional to the whole log, no
  matter how few rows the subject owned. `purge(modelId, where)` deletes by indexed-field
  equality with the same semantics `query` uses, so a caller can see what it is about to erase
  with the tool it already has, and returns the count. Measured at **68×** on
  `purge.bench.ts` (0.49 ms vs 33.8 ms, one subject of 50 in a 20k-event corpus).
  Three refusals, because an erasure that quietly does nothing is worse than one that fails:
  an empty filter throws rather than meaning either "every row" or "no rows"; a filter naming
  an undeclared field throws rather than reporting zero; and a backend without the method
  raises a typed `PurgeUnsupportedError` naming the fallback rather than resolving with zero.
  Watermarks are deliberately untouched — clearing them would let the next catch-up re-derive
  the rows just erased. Implemented for the in-memory, SQLite and Postgres backends and pinned
  by the conformance kit, which `PostgresReadModelStore` now runs for the first time
  (ADR 0093).

- **`preservesNodes` — node identity across a structural change.** A widget's `id` is derived
  from kind + props unless supplied, so a prop edit *re-identifies* the node: it remounts, and
  any pin, annotation or agent reference keyed on the old id dangles. `validateBlueprint` checks
  one tree (including `duplicate-node-id` within it); nothing compared one tree to another, which
  is where identity is actually lost. `preservesNodes(before, after)` reports which ids the change
  dropped, with `added` as data (a `dropped` beside an `added` is what a re-identification looks
  like) and `compared` as the denominator, so `ok: true` over an empty `before` cannot read as a
  pass. `blueprintNodeIds` / `preservesBlueprintNodes` spell the blueprint case; passing a floor's
  ids as `before` answers "does this variant contain the floor?" with no new vocabulary. Second
  consumer: `A2UISurfaceBridge.identityDiff(next)`, which reports what a proposed `recompose`
  would unmount without committing the tree or emitting — and which is why the API takes id sets
  rather than blueprints, A2UI components being a flat list (ADR 0094).

- **A corpus can have more than one writer** — `DocRecord.source`, `sync(docs, { source })`,
  `putDoc(doc, { source })`, and `SyncResult.retained`. `sync` is a destructive reconcile over
  everything the manifest holds, so an agent writing down what it learned from feedback into the
  same scope as an authored corpus would lose all of it to the next nightly wiki job: those
  documents are not in the set the wiki produced, and never will be. Stamped with a writer, a
  reconcile only ever touches its own documents; the rest come back as `retained`, so the
  protection is visible rather than silent. A write to a document ANOTHER writer owns is refused
  loudly — silently re-stamping would make the two delete each other's revisions on alternate
  syncs, with every individual run looking correct. An absent document has no owner, so any
  writer may create it, and an unstamped corpus behaves exactly as before (the default writer is
  a source of its own, never a wildcard). `loom knowledge sync --source <s>` carries it.

- **Blueprint conformance** ([ADR 0088](docs/adr/0088-blueprint-conformance.md)). A blueprint a
  *person* writes is checked by the type system; one a *model* composes at run time is data, and
  the only thing between an off-catalogue component and a viewer is whatever validates it on the
  way out. `validateBlueprint` / `catalogCoverage` in `@loom/blueprint-runtime` check a composed
  blueprint against the widget catalogue the app already declared — two pure functions and a
  declaration type, no kernel change.

- **Worker-thread sandbox evaluation and the hard kill**
  ([ADR 0089](docs/adr/0089-sandbox-worker-pool.md)). `vm.evalCode` is synchronous and cannot
  yield, so `wallClockMs` was not only the longest a script may run — it was the longest the
  CALLING thread was unavailable. The opt-in `workers` option on `SandboxSpec` moves evaluation
  to a worker pool, which adds the one guarantee the in-engine guards structurally cannot: a hard
  kill for a script that never reaches the interrupt handler (measured at 790ms against a 50ms
  wall clock). In-process stays the default and ADR 0064's security list is parameterized over
  both engines rather than copied.

- **`app.knowledge(scope)`, `loom knowledge`, and a `loom doctor` memory-store check** — the DX
  follow-on to ADR 0091. `app.knowledge` opens a corpus over the app's configured `memoryStore`
  (one per scope, cached; options honoured on the first call only, since two parts of an app
  configuring one corpus with different chunkers would chunk it differently on alternate ingests),
  and refuses a tier a registered `memory$` would evict — both run over the same store, and only
  the runtime that reads applies its own policy.

  `loom knowledge sync --dir <path>` reconciles a directory into a corpus, `list` shows what it
  holds, `search` asks it what a flow would retrieve. `sync` is a **dry run by default** because
  the reconcile is destructive — a document the directory no longer contains is deleted — and the
  preview runs `KnowledgeBase.planSync`, the same classification `sync` itself uses. Skipped files
  (symlinks, over the size cap, empty) are listed rather than quietly dropped, because a file the
  corpus does not contain is the answer to a "why did retrieval miss that" question. `search`
  prints that it is **not a recorded retrieval**: an operator query has no execution to record
  into, so a transcript of it is not what an execution saw. All three refuse an app with no
  configured `memoryStore` — that corpus lives in a store the process discards on exit.

  `loom doctor` gains a memory-store check: no `memoryStore` is a SKIP that names the cost (memory
  and any corpus lost on restart — the shape ADR 0090 opened with), while a configured store
  without `search` is a FAILURE, since `recallRelevant`/`retrieve` refuse it at run time rather
  than degrading.

- **`@loom/memory` is in `SPI_PACKAGES`**, so `loom plugin check` finally holds a memory backend
  to the peer-dependency rule. It had been absent for as long as the seam existed, reporting a
  green "SPI packages are peer dependencies" while being unable to see the one package that
  matters to it. A bundled copy here is not a duplicate kernel but a duplicate CONTRACT:
  `searchableText`/`tokenize`/`clampSearchLimit` decide what a backend indexes and what counts
  as a term, so a plugin carrying its own copy can answer a different question than the app
  asked and still pass conformance.

- **A corpus is mutable, and the SPI could not say so**
  ([ADR 0091](docs/adr/0091-corpus-lifecycle-and-the-knowledge-package.md)). `MemoryStore.search`
  ranks within ONE key, so a searchable corpus has to be one key — while a DOCUMENT, the unit that
  actually gets revised and deleted, is a subset of that key the SPI could not name. Re-ingesting
  an edited document therefore DUPLICATED it (retrieval returning the superseded passage beside the
  current one, with nothing saying which was live), the only removal verb was `clear` on the whole
  scope, and a document deleted upstream kept answering questions. None of it shows in a green
  suite, because every test ingests once.

  `MemoryEntry.id` is now optional for a caller and **required for a backend to round-trip**, with
  the optional `MemoryStore.remove(key, ids)` beside it. The asymmetry is deliberate: `remove` has
  a correct fallback (read-filter-`replace`), but that fallback matches on the id `read` gives
  back, so a backend that dropped ids would turn a delete into a silent no-op on exactly the path
  taken by backends with no native delete. **`MEMORY_STORE_SPI_VERSION` is 2.0.0** — MAJOR because
  a backend that decomposes an entry into columns drops a field nobody told it to keep, which is
  invisible to every case that only checks `content`. Neither first-party SQL backend needed a
  migration: both already store the entry as JSON, so removal reads the id back out of it
  (`json_extract` / `entry->>'id'`) behind a partial expression index.

- **`@loom/knowledge` — document corpora over a memory tier.** `KnowledgeBase.putDoc` is an UPSERT
  and `sync(docs)` reconciles a corpus against its source: write what changed (by a
  `canonicalJson`+`fnv1a64` fingerprint), leave what did not, remove what the source dropped — an
  unchanged source costs one manifest read and zero writes. Manifest rows are APPENDED and pruned
  only after the new one is durable, because the obvious alternative (delete the old row, write the
  new one) has a crash window in which a document has no row at all, and a document nothing counts
  is a document nothing can remove.

  `groundedRequest`/`passageMessages` assemble the one prompt shape `guardRequest` accepts — one
  `user` message per passage, taint intact, never joined — so the shape every RAG tutorial writes
  (passages in the SYSTEM prompt) does not compile rather than being refused at run time.
  `openKnowledgeBase(store, { scope })` is the two-line form of the four every consumer was
  writing by hand — a corpus needs exactly one tier and that tier must not evict, which is a
  fact about corpora rather than a decision each app re-derives (and `app.memory` is a
  `MemoryRuntime`, one layer below the `TieredMemory` the constructor takes, so the
  boilerplate was mandatory rather than incidental).

  `checkCitations`/`assertGrounded` reject a citation to a document that was never retrieved: the
  one hallucination in a RAG answer that is decidable rather than judged, because the retrieval was
  recorded. Chunking stays injected (`packParagraphs` is an ignorable default), embeddings stay
  third-party, and the `knowledge$` construct stays rejected.

- **The `MemoryStore` SPI is versioned** (`MEMORY_STORE_SPI_VERSION`, 1.0.0), carried in the kernel
  manifest and `checkCompatibility` beside the event-store / snapshot / branch / dispatcher SPIs.
  A formality while every implementation lived in this workspace, where a breaking change breaks
  the build that made it — and not one once the seam grew a backend OUTSIDE it, which nothing here
  builds, tests, or can see.

- **A `memory` seam for `loom plugin new`**, and an exports-map rule in `loom plugin check`: an
  `exports` map declaring `require` with no `default`/`import` resolves for CJS and raises
  `ERR_PACKAGE_PATH_NOT_EXPORTED` for ESM — a shape neither tsc nor a CJS test runner can see.

- **Agent memory that survives a restart, and can answer a question**
  ([ADR 0090](docs/adr/0090-knowledge-is-retrieval-over-memory.md)). `@loom/memory` shipped tiers,
  TTL/size policy, summarization and `ctx.decide`-recorded recall over a pluggable `MemoryStore` —
  and exactly one implementation of it, `InMemoryMemoryStore`. Every store plugin carried an event
  store, a snapshot store, a timer store, a durable-state store and a read model, and no memory
  store, so what shipped was a prompt-context manager: an agent that restarted remembered nothing.

  `SqliteMemoryStore` and `PostgresMemoryStore` live in the plugins that already own those
  databases — point them at the event log's file/URL and one backup captures both. A key names an
  ORDERED LIST read back in APPEND order, never timestamp order (entries routinely share a
  timestamp, and ordering by it reshuffles a conversation). `MemoryStore.replace` (OPTIONAL) is a
  durability fix rather than an optimisation: `MemoryRuntime` rewrites a scope's whole list on
  every eviction, and as clear-then-re-append a crash between the two makes routine eviction the
  thing that loses the scope.

- **`MemoryStore.search` — recall by relevance, not just by recency.** `read` answers *what
  happened last*; the `semantic`/`procedural` tiers never evict, so their "newest N" means nothing
  and the only way to use one was to load it whole. `search` ships with three first-party
  implementations (in-memory IDF, SQLite FTS5, Postgres `tsvector`) plus a third-party cosine
  backend, all passing one `runMemoryStoreConformance` — which is what makes the seam a contract
  rather than a description of an inverted index. `searchableText` and `tokenize` are exported
  because *what gets indexed* and *what counts as a term* are the contract; ranking is not, and the
  kit deliberately does not pin an order.

  `TieredMemory.recallRelevant(tier, scope, query, { decide })` takes `decide` as a **required**
  option where `recall`'s is optional: relevance ranks over a corpus that grows, so the set it
  returns differs between a run and its replay, and a type requirement beats a documented one.
  `MemoryRuntime.search` refuses a store without `search` rather than degrading to `read` — a
  silent fallback would look like retrieval and be undetectable downstream.

- **A `memory` seam for `loom plugin new`.** Emits only the three required verbs and explains
  `replace`/`search`/`close` in prose, because for an optional method presence IS the feature flag:
  the runtime tests for it and falls back when absent, so a generated stub that throws advertises a
  capability the store does not have. `loom plugin check` gains an exports-map rule — `require`
  with no `default`/`import` resolves for CJS and raises `ERR_PACKAGE_PATH_NOT_EXPORTED` for ESM.

- **The agent loop is a runner body, and the seams it can now reach are wired**
  ([ADR 0087](docs/adr/0087-durable-agent-loop.md)). `agentStep$` wrapped the whole ReAct loop in
  one `step$({ handler })`, and a handler receives `StepHandlerContext` — `emit`, and nothing else.
  So forty model calls and N tool calls were ONE frame (a crash at turn 39 re-ran all 39), approval
  had to be hoisted out of the agent entirely, and routing choices were hand-emitted in a shape
  `@loom/learning` cannot evaluate. Nothing was missing from the kernel; the loop was on the wrong
  side of it.

  `agentLoop$(ctx, config, input)` is an ordinary function over `ExecutionContext`, called from a
  runner body, issuing `ctx.execute` per turn with ids minted `#turn:<i>` / `#turn:<i>:tool:<j>` per
  the [ADR 0061](docs/adr/0061-step-identity-interpreter-guardrails.md) identity rule. The model
  call resolves through the `EffectRuntime` by `modelToolId`, so K2, metering, retry,
  `idempotencyKey` and K9 in-doubt all apply to it. `requireApproval` parks the execution on a gate
  BEFORE a destructive tool runs, and a refusal is fed back to the model as a tool result rather
  than thrown — a human declining is information the agent can settle on.

  Its choices go through the decision seam: skill selection and memory recall via `ctx.decide`
  (so a replay reconstructs the prompt that actually ran, not the one a re-selection would build),
  compaction via `ctx.execute` (a lossy, nondeterministic summary has to be a recorded fact), and
  Reasoning-Runtime routing likewise. `agentStep$` is retained and NOT deprecated: one frame instead
  of 2N, for an agent that wants none of this.

- **A streamed model call that is still one durable outcome.** `LlmStreamChunk` carries optional
  `toolCalls`/`stopReason`/`usage` on its terminal chunk — without them a stream could carry prose
  to a human and nothing else, since a ReAct loop branches on exactly those. `assembleStream` /
  `collectStream` fold a stream into the `LlmResponse` it represents, and
  `runLlmProviderConformance` pins the contract that makes two paths to one outcome safe: **a
  streamed result MUST equal what `complete` returns** — [ADR 0059](docs/adr/0059-content-put-stream.md)
  D1's streamed-≡-buffered discipline applied to the model call. `createLlmEffect({ stream: true })`
  consumes it internally: deltas reach a transient sink, the journal sees one `STEP_COMPLETED`, and
  an interrupted generation keeps its partial text on an ADR 0060 channel instead of discarding it.

- **K8.4 — a runaway generation is severed while it generates**
  ([ADR 0020](docs/adr/0020-k8-cancellation-deadlines-bounded-effects.md) A8). Every other K3 gate
  is admission control: it decides whether the NEXT effect runs, so a model that emits 100K tokens
  was billed in full and stopped afterwards. `streamTokenBudget(budget)` (`@loom/middleware`) guards
  `collectStream`, estimating output tokens from the text so far plus what `ctx.resources` already
  metered, and on breach emits `QUOTA_EXCEEDED` — the same durable fact `meteringMiddleware`
  writes — then throws `QuotaExceededError`. The estimate is named as an estimate in the type, in
  the reason, and in the default; final metering still uses the provider's own numbers.

### Fixed

- **`wallClockMs` charged the parent's own latency to the script.** The sandbox pool's kill
  deadline is a `setTimeout` on the parent's event loop, and the worker's reply arrives as a
  message to that same loop — so the budget measured the script *plus* however long the parent
  took to post the eval and to drain the reply. libuv runs the timers phase before the poll
  phase, so on a contended host a due deadline fires ahead of a reply that already arrived,
  and a trivial script comes back `limitExceeded { wallClock }`: a resource kill routed to
  drift-repair, where an LLM rewrites a script that was never the problem. (Same failure the
  pool already fixed for cold starts, by a different route.) The deadline is now a **question
  asked of shared memory** rather than a verdict: the worker stamps when the script actually
  started and when it stopped into a `SharedArrayBuffer`, which the parent reads
  *synchronously* inside the timer callback — where it cannot receive a message. A script is
  killed only if it is still running and has outrun its budget **by the worker's own clock**;
  otherwise the parent re-asks. A worker that never starts the run at all is still reclaimed,
  as a worker fault rather than a script breach. Pinned by a test that starves the parent for
  four times the deadline and asserts the fast script still resolves.

- **The retention guard read whole logs to ask a yes/no question.** `hasLiveDescendant` called
  `eventStore.read(child)` and checked `.length > 0` — per child, per swept execution, against
  branch logs, which are the long ones precisely because a branch is forked to do expensive
  work. It is a tip query, and now uses `headOf` (EventStore SPI 1.4.0).

- **A fork copied the gate but not the alarm.** `WorkflowRuntime.fork()` copies the parent's
  prefix verbatim, so a branch forked at a suspension is parked on the same condition —
  including a `wakeAt` derived from `suspend({ timeout })`. But a timer row is keyed by
  executionId, and `timerStore.schedule` was called from exactly one place: the suspend path
  of the run loop. A branch therefore inherited, in its own log, a deadline that nothing
  would ever fire, and nothing else could catch it — `recoverAbandoned` ignores suspended
  executions by design, because suspension is a normal outcome rather than an abandonment.
  The parent timed out on schedule while every branch waited forever. `fork()` now schedules
  the child's wake, after the prefix and seed snapshot are durable (the same invariant the
  suspend path holds: a timer must never fire into a log that does not yet record the
  suspend), and reports a failed schedule through `onStorageError` rather than failing a fork
  that is already complete. **The branch inherits the recorded deadline and cannot re-base
  it**: `TimerService` fires only when `state.suspendedOn.wakeAt === timer.wakeAt` and the
  copied prefix is byte-identical by design, so a re-based deadline would be a timer that
  could never match its own log. A branch that wants its own deadline resumes the gate and
  suspends again with a fresh `timeout` — a fact it appends, not one it inherits. Untimed
  gates gain no timer, a fork before the gate gains none, and with no `TimerStore` wired the
  behaviour is byte-identical to before.

- **`DelegationAuthorizer`'s `base` is required (potentially breaking).** It was optional,
  documented as "omit to allow the full verified delegated set (the callee delegates all of
  its authority decisions upstream)". That mode cannot deliver what it claims: the delegation
  secret is **symmetric**, so the party that verifies a token is also a party that can mint
  one. A callee can sign itself `{ grants: ["*"] }` and the result is *genuine* — no signature
  check can reject it, because it is not forgery. What actually bounds a callee is the
  intersection with `base`, so an absent `base` silently reduced that check to a no-op while
  still reading as a working gate. `base` is now required, with a constructor guard as well as
  the type (the type is not enforcement for JS callers). No production construction sites
  existed in this repo or any sibling, so the practical blast radius is zero;
  [ADR 0024](docs/adr/0024-k12-identity-tenancy-delegated-authority.md) now records the trust
  model and marks cross-organisation delegation — where the verifier must not be able to mint,
  and which needs asymmetric signatures — an explicit non-goal. The same symmetry applies to
  [ADR 0037](docs/adr/0037-tamper-evident-audit-chain.md)'s audit chain: an auditor handed the
  HMAC secret to verify history can also rewrite it, so it is tamper-*evident* against third
  parties rather than third-party *verifiable*.

- **Subject erasure never reached a derived read model, and "just rebuild it" did not work
  either.** A crypto-shred (K10.2) erases the log; it says nothing about anything built from
  the log, and `eraseSubject` does not know a read model exists. Every derived row kept the
  plaintext its extractor copied out before the key died — and those rows are what a query
  reads. The prescribed repair, `clear(modelId)` + re-scan, then failed on its own terms: the
  authoritative read of a shredded subject throws `PayloadShreddedError` by design, and a
  rebuild is a read, so it needs a source configured `onShredded: "tolerate"` — the throw is
  at the SOURCE, before any extractor runs. Under a tolerant source the extractor must then
  decide what `{ $shredded: true }` means, because indexing it verbatim rebuilds the
  placeholder into the cache and collapses every erased subject onto one bucket. All three are
  now documented (`docs/compliance.md`, the `ReadModelStore.clear` contract) and pinned by
  `plugins/read-model/src/erasure.test.ts`. Erasure cost is *O(log)*, not *O(subject)*; a
  row-granular purge stays deferred behind a measured cost (ADR 0092 D6).

- **Indexing recursed without a bound over ingested memory content.** `searchableText` walked
  `entry.content` recursively with no depth cap and no cycle guard, and `content` is whatever was
  ingested. A nesting depth of 5,000 is still JSON-serializable — so it satisfies the documented
  contract AND every durable backend's own `JSON.stringify` — and it exhausted the call stack,
  failing a write the store had promised to accept; a cyclic value never terminated, and the
  in-memory store accepted one at `append` only to detonate later inside an unrelated `search`.
  Now an iterative walk with an explicit stack and a depth cap, indexing over-deep content as far
  as the cap rather than refusing it.

- **`MemoryStore.search` trusted its `limit`.** Three backends, three behaviours: `.slice(0, -1)`
  dropped the last hit, SQLite read `LIMIT -1` as NO LIMIT and returned the entire matching set,
  Postgres threw. The unbounded one is the quiet failure, and `recallRelevant` records what it
  retrieved through `ctx.decide` — so an unbounded search writes the whole corpus into a
  `DECISION_RECORDED` payload, permanently. `clampSearchLimit` mirrors
  `@loom/plugin-read-model`'s `MAX_QUERY_LIMIT`; four conformance cases pin it, and backends MUST
  route their limit through it.

- **`SupervisingDispatcher` never forgot a circuit.** `recordSuccess` reset one in place and
  nothing deleted it, so a `policy.circuit.key` with tenant or execution cardinality — which the
  hook invites, since it receives the whole `ExecutionPackage` — grew for the process lifetime.
  Deleting on success is observationally identical at all three read sites.

- **Two SPI-map claims that understated what ships.** The Timers row said its conformance kit was
  `— (future)` while `runTimerStoreConformance` had shipped and SQLite was running it, and the
  compute section called a dispatcher kit "a natural follow-up" with
  `runExecutionDispatcherConformance` already exported. Four seams with kits and no row at all
  (content store, carry state, read models, subject keys) are now listed, and a fitness function
  keeps the column honest in both directions.

- **Every package's `exports` map was unreachable from ESM.** Forty-nine declared
  `{ require, types }` and nothing else. Node matches export conditions in order and stops at the
  first hit, and an `import` offers `["node", "import"]` — never `"require"` — so it matched
  nothing. Invisible from inside: loom's own test config forces `conditions: ["require",
  "default"]`, TypeScript reads `types` directly, and neither turbo nor tsc resolves at runtime.
  Now `types` / `require` / `default`, with `default` last because it matches everything and
  anything after it is dead. A fitness function in `@loom/spec` holds all three properties, and the
  scaffold no longer mints the defect into new plugins.

- **Three ways a check could silently not run.** The Postgres suites (94 tests) had never executed
  in CI — gated on `LOOM_TEST_POSTGRES_URL`, skipping cleanly, and a skipped suite renders exactly
  like a passing one; CI now provisions a service container, and the requirement lives in the repo
  as a test that fails when `CI` is set and the URL is not. `LOOM_TEST_POSTGRES_URL` and
  `LOOM_TEST_SRC` were absent from turbo's `test` cache key, so a cached result from a run WITHOUT
  a database was replayed verbatim for a run that had one. And seven packages ran vitest with no
  config at all — there is no root config to inherit — so they silently opted out of the shared
  resolution, which is how a value import from `@loom/memory` first broke, and made
  `LOOM_TEST_SRC=1` inert in exactly those packages.

- **`ctx.decide` could not be passed as a value.** Every decider-taking helper takes it as an
  option and the documented spelling is `decide: ctx.decide`, which lost its receiver and died
  inside the context with a `TypeError` naming neither `decide` nor binding. `agentLoop$` carried a
  hand-written wrapper at two call sites, with a comment instructing the reader to do the same — so
  the workaround was known and the fix was not. The context now binds it.

- **A tainted value's `origin` was indexed as searchable text.** An ingested corpus taints every
  entry ([ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)), so the label rode into
  `searchableText` as a string leaf and one term matched the whole corpus — on an FTS backend that
  widens the match *set*, not just the ranking. Provenance is metadata by exactly the rule that
  already excludes `role` and the timestamp.

- **Two tests that asserted the clock instead of the property.** A cross-node LISTEN/NOTIFY test
  fired `subscribe` and slept 100ms; `NOTIFY` is not durable, so a listener registering after the
  publish never receives it and the wait could only time out — it now awaits the subscription,
  which the store already resolves after its LISTEN registers. A content-batching test measured
  elapsed time against a 20 x 5ms serialized floor with a 2x margin; it now asserts peak in-flight
  calls, which a serialized fallback can only ever drive to 1.

- **The prompt-boundary guard runs where prompts are actually built.**
  [ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)'s protection did not cover the
  agent: `guardRequest` ran only inside `createLlmEffect`, which had no production consumer, while
  `AgentRunner` and `ReasoningRuntime` called `provider.complete` directly. The agent path was worse
  than unguarded — `JSON.stringify` of a tool result flattened the taint envelope into ordinary
  text, so `isTainted` was false downstream and no guard added later could recover the origin.
  Evidence erased, not merely unused. Both paths now guard, and a tool result keeps its taint
  outside the serialization.

- **An agent's declared tool menu is its reachable effect set.** `resolveVerifyInput` read
  `AgentDefinition.tools` nowhere, and an `agentStep$` declares no `toolId` of its own — so a flow
  whose only step was an agent contributed NO effects, and `capability-compat`, `effect-class` and
  ADR 0084's unclassified-effects warn all passed vacuously over it. `StepDefinition.reachableTools`
  declares the menu reachable THROUGH a step; `agentStep$` populates it from the agent's tools.

- **A capability denial is terminal for the turn.** `AgentRunner` swallowed every throw into
  `{ error }` and handed it to the model, which reads "not authorized", reformulates, and probes a
  neighbouring tool — turning one denial into a search over the grant table. `EFFECT_DENIED` was
  always logged, but auditable is not the same as stopped.

- **A spawned child can be given less authority than the flow it runs.** `superviseChildren` started
  children with no principal at all, so K12.4's `DelegatedGrant` — which verifies signature, expiry,
  holder-binding and the intersection with the callee's own grants — had nothing to check.
  `awaitChild({ grants })` names the conferred subset and a supervisor wired with
  `delegation: { secret }` mints the token at start time, bound to the child's own execution id.
  The signed token is never written to the log: an append-only, archived log is the wrong place for
  a bearer credential, so the log records the subset and the mint is re-derived on recovery.

- **Envelope ids are unique too, and a re-used one is its own error**
  ([#309](https://github.com/chhetrisushil/loom/issues/309)). The sibling of #306 on the events
  table's other key: both SQL backends declare `PRIMARY KEY (id)`, `InMemoryAsyncEventStore` had no
  equivalent check, and two envelopes sharing an `id` both landed. All three backends now reject
  with `DuplicateEnvelopeIdError` — deliberately a **different type** from `DuplicateSequenceError`,
  because they are different failures: a taken sequence means another writer reached that slot (a
  lost race, retryable by re-reading and re-allocating), a taken id means the same envelope identity
  was minted twice (a bug in whatever produced it). Ids are conventionally derived from
  `${executionId}-${sequence}`, so a lost slot race trips both constraints; the sequence is
  reported, being the actionable one.

  The in-memory store keeps an id index, which has to be maintained everywhere the log changes,
  not just on append: `deleteExecution` and `truncatePrefix` free the ids of the events they drop
  (an index outliving its events makes an erased execution impossible to re-create, and leaks
  across a retention sweep), and `copyPrefix` claims the ids of the events it copies — rejecting,
  all-or-nothing, if a re-stamped id collides.

  **Uniqueness is required within an execution; cross-execution is explicitly not.**
  `ShardedEventStore` cannot provide it — separate executions live on separate backing stores and
  no shard sees another's ids — the same carve-out `appendBatch` already makes for cross-execution
  atomicity. A single-log backend gets store-wide uniqueness from its primary key and is free to be
  stricter (the in-memory store is); a caller must not depend on it.

  The new clause found one more thing: `fanout.test.ts` built its crash-residue fixture by
  renumbering sequences while keeping the original ids, so the surviving events carried ids
  belonging to sequences that were no longer theirs — a log neither SQL backend would have
  accepted. The fixture now re-stamps both.

- **`(executionId, sequence)` is unique in every backend, and the contract now says so**
  ([#306](https://github.com/chhetrisushil/loom/issues/306)). SQLite and Postgres enforce
  `UNIQUE (execution_id, sequence)`; `InMemoryAsyncEventStore` — which is not a test double but
  `defineConfig`'s `kind: "memory"` backend, the one an app gets when no store plugin is wired —
  accepted both writes and interleaved them into the log. Not covered by fencing: fencing engages
  only once a token has been *acquired*, while sequences are allocated per-process from folded
  state (`ExecutionJournal` seeds from `vm.getState().sequence` and increments locally), so two
  unfenced writers recovering the same execution allocate the same next sequence with neither one
  a zombie. `appendBatch` additionally validates the batch against **itself** — two envelopes
  claiming one slot conflict only with each other, so a check against stored rows alone admits the
  pair.

  All three backends now reject with a shared `DuplicateSequenceError`, so a caller need not know
  which store it is talking to (or match driver text) to recognise a lost sequence race. The
  mapping is narrowed by constraint, since both tables also key `id` and a re-used envelope id is
  a different bug.

  The gap was never a missing suite — `runEventStoreConformance` exists (ADR 0033) and all three
  stores already ran it. It was a missing **clause**: the portable contract said nothing about
  uniqueness, so a backend could omit the check and still conform. Three cases added there, which
  is what makes every backend (including a third-party one) agree. Two pre-existing tests named
  "rejects duplicate (executionId, sequence)" were rewritten: both built their two envelopes with
  the same derived id, so they collided on the id primary key and never reached the constraint
  they were named for — `.rejects.toThrow()` could not tell the difference.

- **The resume ingress gate: a caller-supplied `eventType` no longer writes kernel state, and a
  resume must name the gate it answers** ([#304](https://github.com/chhetrisushil/loom/issues/304),
  [#305](https://github.com/chhetrisushil/loom/issues/305)). `eventType` travels from an ingress
  adapter — A2A `provideInput` and the wire-ABI `execution.resume` both forward a network-supplied
  `ResumeEvent` — into the log verbatim, and the fold dispatches by NAME. A resume typed
  `STEP_COMPLETED` therefore forged a step outcome that the completed short-circuit served
  *without running the effect*; `EXECUTION_MIGRATED` rewrote the K11 code pin and `_input` (and
  could wedge an execution permanently); `APPROVAL_GRANTED` wrote the K12.2 evidence the
  authenticator exists to produce, while the authenticator was rejecting the honest attempt.
  Separately, `suspendedOn.on` was folded and read by nothing, so any name resumed any gate —
  which also skipped the ADR 0077 `resumeSchemas` lookup, since that keys off the caller's event
  type: a declared shape gate was evaded by renaming the event. And `resume()` refused only a
  *cancelled* execution, so a completed one was still writable.

  `resume()` now refuses, before anything is appended, an event type in the K5-governed
  `knownEventTypes()` set, an execution that is not `suspended`, and an event type that is not the
  parked gate. Refusal is **fold-identical for every legitimate log** (G2): a non-kernel event type
  already folded to a no-op. `TIMER_FIRED` remains allowed as the kernel's own wake, and a *timed*
  suspend is wakeable by it whatever its gate is called; `EXECUTION_RECOVERED` remains the
  dispatcher's re-drive of a crashed execution and is now refused on a parked one. `resumeAs`
  enforces the kernel-namespace rule only — the recorded gate belongs to the code being migrated
  away from. New `ResumeRefusedError` carries a machine-readable `reason`; `@loom/orchestration`
  retries the one transient reason (`not-suspended`, a parent whose suspend is not yet readable on
  an async store) instead of matching message text. `KERNEL_ABI`/`EVENT_SCHEMA` unchanged.

  **Behavioural tightening, not a pure fix:** an app resuming with a name that does not match its
  `suspend({ on })` was succeeding by accident and will now be refused.

### Added

- **The verify tier stops needing hand-plumbed source, and gains a front door.** The compiler
  transform now emits all three per-flow source analyses into `loom-manifest.json` —
  `loopIdentity` ([ADR 0061](docs/adr/0061-step-identity-interpreter-guardrails.md)),
  `nonDeterministic`, and `runnerReach` ([ADR 0086](docs/adr/0086-runner-body-reach-analysis.md)) —
  and `loom verify` auto-injects them from a discovered manifest, so `determinism`,
  `capability-compat`, `effect-class` and `suspension-safety` are on whenever you build with the
  Loom compiler rather than requiring a developer to feed their own runner source to a linter.
  New **`loom doctor`** runs every pre-flight check whose input it can discover and **names the
  ones it skipped and why** — "all checks passed" and "passed, but N check(s) could not run —
  coverage is partial" are deliberately different strings. Whole-module analysis skips memoized
  `handler$` bodies (`{ skipMemoized: true }`): a handler's result is served from the log on
  replay, so non-determinism inside one is safe by construction.
- **Runner-body reach analysis, and two `suspension-safety` checks it proved wrong**
  ([ADR 0086](docs/adr/0086-runner-body-reach-analysis.md)). `capability-compat`, `effect-class`
  and `suspension-safety` previously defined "what a flow reaches" as its *declared* steps, so a
  step invoked through `ctx.run` was invisible and `FlowSpec.suspends` had no producer at all.
  `analyzeRunnerReach` resolves `ctx.run` targets by shape and **reports what it could not
  resolve** as a `warn` on each rule. Populating the input showed the blanket `correlationKey`
  error was wrong (`resume` routes by `executionId`) — removed — and that the `wakeAt` check must
  be conditional on a wired `TimerStore`. `KERNEL_ABI`/`EVENT_SCHEMA` unchanged.
- **The integrity axis: untrusted content as a value, refused at the prompt boundary**
  ([ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)). `tainted()`/`unwrapTainted()`
  in `@loom/classify` wrap third-party bytes in plain JSON that survives the log verbatim, so a
  replay hands back a value that is *still* tainted. `@loom/llm`'s `guardRequest` runs inside
  every `createLlmEffect` and throws `UntrustedContentError` if tainted content reaches a system
  message, an assistant turn, or a tool name/description; in a `user` message it is fenced as
  `<untrusted-input origin="…">`. Two opt-in producers ship: `registerMcpInvoke(…, {
  taintResults: true })` and `new A2APeerClient({ …, taintResults: true })`.
- **Effect classes — a static ceiling beside K2's runtime floor**
  ([ADR 0084](docs/adr/0084-effect-classes-static-ceiling-k2-floor.md)). An eighth `@loom/verify`
  rule: a flow may not reach an effect whose declared class exceeds its own, composed
  conservatively as the max over everything reachable. The class *vocabulary* is app-supplied
  (`checks: { verify: { effectClasses } }`) — loom checks the ordering it is given rather than
  defining one. A **granted** capability can still bust the class, and K2 will not stop it; the
  finding says so.
- **`@loom/learning` — the substrate for continuous learning, not the learner**
  (ADRs [0078](docs/adr/0078-exploration-in-the-routing-seam.md)–[0080](docs/adr/0080-learning-substrate.md)).
  `context` and `policy` (including `propensity`) now ride `DECISION_RECORDED`
  (**EVENT_SCHEMA 1.18.0**; `KERNEL_ABI` untouched), which is what makes off-policy evaluation
  possible at all — propensity cannot be reconstructed after the fact. Ships trajectory
  extraction, SNIPS evaluation with unit-level ESS and a cluster-robust estimate for pooling
  across units, a promotion gate, the third-party `Policy` SPI (the one seam consumed from flow
  code rather than `defineConfig`), and `loom learn report` / `loom learn eval`. The router's
  greedy collapse onto one lucky arm is fixed with `ucb1`/`epsilonGreedy`. Pooled reports never
  name a unit — asserted by an invariant test that injects a leak.
- **Storage scale-out as composable decorators** (ADRs
  [0074](docs/adr/0074-storage-scale-out-decorators.md)–[0075](docs/adr/0075-shard-rebalancing.md))
  — sharding, batching and rebalancing (virtual buckets, lazy drain, no coordinator) layered over
  any `EventStore` rather than built into one backend. `EVENT_STORE_SPI_VERSION` → 1.3.0.
  Measured ceilings and the method are written up in [`docs/scaling.md`](docs/scaling.md).
- **Two boundaries that looked enforced and were not.** Array crossings in classification paths
  now expand late and walk once ([ADR 0076](docs/adr/0076-wildcard-classification-paths.md)),
  and resume payloads get per-gate contracts enforced **before** the append —
  `flow$({ resumeSchemas })` plus a generic `ctx.suspend<T>`
  ([ADR 0077](docs/adr/0077-typed-resume-payloads.md), `ResumePayloadValidationError`).
- **`@loom/replay-inspector` — read-only replay** ([ADR 0071](docs/adr/0071-read-only-replay-inspector.md),
  IX series): inspect an execution's replay without a live runtime, bounded by an explicit budget
  (`InspectorBudgetError`).
- **MCP Apps (SEP-1865) placement** ([ADR 0072](docs/adr/0072-mcp-apps-ui-extension-placement.md)):
  ingress fidelity plus `createMcpServer`, and `ui://` egress as one static, content-pinned
  surface-host template in `@loom/plugin-mcp-app` (`TemplateDriftError`). The **host** role is
  where a third party belongs, not a reason for loom to build one.
- **Effect mode — `journaled` vs `ambient`** ([ADR 0073](docs/adr/0073-effect-mode-journaled-vs-ambient.md)):
  a declaration plus a boundary check (`EffectModeViolationError`) that keeps user-driven
  enrichment reads out of the durable log.
- **The second-consumer rule** ([ADR 0083](docs/adr/0083-second-consumer-rule.md)) — before a
  workload-derived requirement becomes a first-party package, verify rule, seam, or exported
  vocabulary, name a second unrelated consumer. Recorded because this repo had a strong antibody
  against kernel growth and none against first-party surface growth.
- **Two kernel promotions refused, with evidence gates recorded rather than scheduled**:
  long-lived suspensions need a benchmark, not a promotion
  ([ADR 0081](docs/adr/0081-long-lived-suspensions-no-promotion.md)), and substitutive replay is
  deferred until branch-from-prefix is eliminated
  ([ADR 0082](docs/adr/0082-substitutive-replay-deferred.md)).

- **A2UI `callFunction` (bidirectional RPC) in `@loom/plugin-a2ui`.** The A2UI adapter now covers the
  agent→client `callFunction` leg (the agent invokes a named catalog function; the client answers with a
  `functionResponse`), promoting the surface deferred in ADR 0069. Two composition grains on
  transport-agnostic primitives: **grain A** — a read via a `ctx.suspend` gate
  (`bridge.callFunction` → `ingestFunctionResponse` → `runtime.resume`); **grain B** — a side-effecting
  call via a delegated effect (`registerA2UICallFunction`, `idempotent: false` so a crash mid-call parks at
  `EFFECT_INDOUBT`). Determinism rests on **result-as-recorded-fact + a deterministic, call-site-unique
  `callId`** — no client-side effect runtime, no new event types (`EVENT_SCHEMA`/`KERNEL_ABI` unchanged).
  Inbound replies are correlation-checked (`ingestFunctionResponse(msg, expectedCallId)` and an effect-side
  `callId`/`surfaceId` match), and `registerA2UICallFunction` accepts a `requestTimeoutMs`. New
  `examples/a2ui-callfunction` demonstrates both grains + a crash→in-doubt recovery. See
  [ADR 0070](docs/adr/0070-a2ui-callfunction-bidirectional-rpc.md).
- **`loom appgen` — natural-language → Loom app.** New `@loom/cli` subcommand that turns a
  natural-language intent into a Loom app following the **folder convention** (the same shape
  `create-loom-app` / `loom new` / `loom gen` produce), wiring the pure `@loom/appgen` library
  (`parseIntent` → `generateProject` / `generateFlows`) into the CLI. Output is plain, static,
  inspectable TypeScript with `TODO` handlers; parsing and code generation are deterministic and
  offline (no model call at generate time, none in the output).
  - **Adapts to the target `dir` (the project root, default `.`):** a new/empty dir gets a full
    runnable project (`package.json`, `tsconfig.json`, `app/config.ts` with `defineConfig({
    flowModules })`, `app/main.ts`, `app/loom.gen.ts`, and one `app/flows/<id>/flow.ts` per
    capability) so `pnpm install && pnpm start` works out of the box; an existing Loom app gets
    just the `app/flows/<id>/flow.ts` files, then `app/loom.gen.ts` is regenerated from the
    filesystem (the `loom gen` step) so pre-existing flows stay wired.
  - Reuses `@loom/scaffold` (`appFiles` / `generateRegistration`) rather than hand-rolling, so
    appgen output now matches every other generator. Flows export a `RegisteredFlow` (the older
    `capability$` / `CapabilityCatalog` composition root is gone). The one value-add over
    `loom new` is the NL-derived flow body (reasoning ladder, approval suspend gate, UI surface).
  - Intent is supplied as a quoted positional string or via `--from <file>`.
  - Writes each file directly when the target path is free; on a collision it prompts
    interactively per file — `[r]ename / [s]kip / [o]verwrite` — backed by a stdin line-queue
    reader that works for both TTYs and piped input.
  - `cmdAppgen` is exported from `@loom/cli` for programmatic use, with an injectable IO seam.
  - Docs: new section in [`docs/usage-cli.md`](docs/usage-cli.md) and the CLI overview in
    [`docs/user-guide.md`](docs/user-guide.md).

- **`loom appgen` — brownfield-aware, four-stage pipeline (foundation for AI-driven appgen).**
  `appgen` now *scans the existing app* and applies a **delta** rather than only scaffolding from
  scratch. Four stages, all deterministic and offline: **scan** (`scanApp(dir) → AppModel`,
  a compact TS-AST summary of flows/steps/gates — never raw file dumps), **plan**
  (`planChangesDeterministic(intent, appModel) → ChangeSpec`, tagging each capability/step
  `create` / `extend` / `modify`), **apply** (`applyChanges` → creates via the existing templates,
  surgical formatting-preserving edits to existing flows), and **validate** (in-process `tsc`).
  The plan stage is the single seam where NL understanding lives and it emits a structured
  `ChangeSpec` — a local model can be swapped in here later without touching codegen.
  - **Plan → diff → confirm DX.** `--dry-run` renders a terraform-style plan (creates / edits /
    skips) and writes nothing; omit it to apply. `--check` typechecks the app after applying.
  - **Safety gate.** appgen only overwrites a handler body that still hashes to the generated
    `TODO` stub; any human-edited handler is **insert-only**, never clobbered (`FlowEditor`,
    content-hash gate). Brownfield edits add step consts, register them in the flow's `steps: []`
    array, and insert approval / UI gates into the runner while preserving surrounding code.
  - **Replayable spec lockfile.** Each apply records the accepted `ChangeSpec` to
    `.loom/appgen/<timestamp>.spec.json`; `loom appgen --from-spec <file>` reproduces it
    byte-for-byte with no model — the appgen equivalent of a golden log.
  - `@loom/appgen` stays zero-dependency and offline (only `typescript` promoted to a runtime
    dep for the AST scan/edit); the framework kernel is untouched. New exports: `scanApp`,
    `planChangesDeterministic`, `applyChanges`, `FlowEditor`, `typecheck`, lockfile helpers.

- **`@loom/appgen-model` — optional local-Gemma planner (truly AI-driven appgen).** A new,
  **optional** package that swaps a small on-device Gemma model into appgen's single NL stage.
  `loom appgen --model <gguf>` plans the `ChangeSpec` with the model instead of the grammar
  parser — real language understanding, no token cost, minimal footprint. Everything downstream
  is unchanged, because the model still emits only a `ChangeSpec`.
  - **Grammar-constrained JSON.** Output is constrained to the `ChangeSpec` JSON schema via
    node-llama-cpp, so a compact model reliably produces valid, on-schema plans.
  - **Reasoning-ladder-on-itself.** Planning runs through `@loom/reasoning`'s cheap-first
    elevation ladder with a *validator* confidence signal ("does it parse into a usable
    ChangeSpec?"); a weak tier that emits junk elevates to a stronger one, and each elevation is
    logged (P9) and recorded in the spec lockfile. Recommended tiers: Gemma **E4B** 4-bit QAT
    default (~5 GB), E2B floor (~4 GB), 12B ceiling (~8 GB), selectable via `--model-tier` /
    `--model-big`.
  - **Deterministic fallback / footprint discipline.** Falls back to the deterministic parser
    when the model or `node-llama-cpp` is unavailable or every tier fails (same as `--offline`);
    loads/disposes the model per invocation (transient, not resident); prompts carry only the
    compact scanned `AppModel` summary, never raw file contents.
  - `node-llama-cpp` is an `optionalDependency`, lazily imported; `@loom/cli` loads
    `@loom/appgen-model` only when `--model` is passed, so neither the framework nor default CLI
    users carry the native runtime. Kernel and existing packages untouched.
  - **Verified end-to-end against a real Gemma GGUF (node-llama-cpp 3.19, Metal), which fixed four
    bugs that previously made `--model` silently fall back every time:** (1) `tsc` under
    `module: CommonJS` down-levelled dynamic `import()` to `require()`, which cannot load the
    ESM-only, top-level-await node-llama-cpp (`ERR_REQUIRE_ASYNC_MODULE`) — now a genuine dynamic
    import is preserved via `new Function` in both `GemmaProvider` and the CLI; (2) the v3 grammar is
    built with `llama.createGrammarForJsonSchema(schema)`, not the `LlamaJsonSchemaGrammar`
    constructor; (3) the CLI now resolves the optional `@loom/appgen-model` peer **from the target
    project dir** (`pnpm add @loom/appgen-model node-llama-cpp` in your app), not from the CLI itself;
    (4) the JSON-schema `minItems` constraint crashed node-llama-cpp's native sampler and was removed
    (an empty plan is rejected by the ladder validator instead). Generation is now bounded
    (`maxTokens` 512, `contextSize` 2048) for footprint and native stability. The package README
    documents environment requirements: a Node 20/22 LTS (bleeding-edge Node majors show intermittent
    native segfaults) and enough RAM for the tier (the E4B default is ~5 GB; a 2B model that fits 8 GB
    is often too weak and degrades to the deterministic parser).

- **`loom appgen` completeness — delete/grant ops, runner wiring, self-repair, real diffs, confirm.**
  Closes the remaining gaps against the requirement (captured in
  [`docs/requirements/2026-07-12-ai-native-brownfield-appgen.md`](docs/requirements/2026-07-12-ai-native-brownfield-appgen.md)
  + evaluation, and [ADR 0042](docs/adr/0042-ai-native-brownfield-appgen.md)):
  - **`delete` op.** New grammar `delete <name>` / `delete step <s> from <flow>`; deletes generated
    flow files and removes steps (const + `steps: []` entry + runner call). Refuses to delete a flow or
    step that carries hand-written code. Tracked in `FilePlan.deletes`, honored by `--dry-run`.
  - **New steps are wired into the runner.** `FlowEditor.addStep` now inserts a `ctx.run(<step>, …)`
    call before the runner's `return`, not just a "wire it yourself" note.
  - **`wireGrants` → `app/config.ts`.** New grammar `grant <tool>[, <tool>] to <cap>` (and a model
    schema field) insert a `GrantTable` authorizer (and its import) into `defineConfig` via a
    formatting-preserving `ConfigEditor`; it declines to guess a merge if an authorizer already exists.
  - **Model self-repair loop.** `@loom/appgen-model` now runs `validateChangeSpec` (does the plan
    reference real flows/steps with the right ops?) after the ladder and re-prompts the model with the
    exact issues (bounded retries) before falling back to the deterministic parser.
  - **Real `--dry-run` diffs.** Edits render as a dependency-free unified line diff instead of a summary.
  - **Interactive confirm.** On a TTY (and without `--yes`), appgen shows the plan and asks before
    writing; the CLI surfaces the planner (deterministic vs model) and any ladder elevations.
  - Docs: `docs/usage-cli.md` rewritten for the full surface; a brownfield walkthrough at
    `examples/appgen-brownfield/README.md`. `@loom/appgen` stays offline; kernel untouched.
  - **Planner provenance surfaced + loud model fallback.** The plan header and `--dry-run` output are
    tagged `[deterministic]` / `[model]` (with any `[model, elevated e4b→12b]` ladder steps), matching
    the spec lockfile's `changeSpec.planner`. When `--model` is passed but the model can't produce a
    usable plan, `appgen` now prints a **loud warning** and falls back — so a silent, wrong-looking
    generation no longer masquerades as a model result. Also fixed `--model` failing in-repo with
    "Cannot find package '@loom/appgen-model'": the CLI now resolves the optional peer as a sibling of
    `@loom/appgen` (works in `packages/*` and `node_modules/@loom/*` alike).
