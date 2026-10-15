# Capability grants, effect classes & strict mode

> Part of the [Loom User Guide](../user-guide.md), [section 17](../user-guide.md#17-kernel-grants-quotas--supervision) (Loom 2.0 kernel hardening). The authority side of the kernel: which effects an execution may perform (the K2 protection ring), the static effect-class ceiling, the strict-mode baseline for unattended agents, and identity with delegated authority (K12).

## Capability grants (protection ring, K2)

The `EffectRuntime` is the authority boundary. Give it a least-privilege `GrantTable` and an ungranted effect is **denied** (the denial is logged as `EFFECT_DENIED`; the step fails).

```ts
import { EffectRuntime, GrantTable } from "@loom/effect-runtime";

const effectRuntime = new EffectRuntime([], {
  security: { authorizer: new GrantTable({ "incident-flow": ["metrics-tool", "logs-tool"] }) }, // grant only these
});
// …or via defineConfig({ security: { authorizer: new GrantTable({ … }) } }).
// Any other toolId this flow invokes → CapabilityDeniedError, EFFECT_DENIED logged.
```

**Declarative policies (`policy$`).** A `GrantTable` is imperative wiring; `policy$` is the declarative companion enforced through the *same* ring by a `PolicyAuthorizer`. Attach policies to a flow (`flow$({ policies: [...] })`) or app-globally (`defineConfig({ security: { policies: [...] } })`) — `defineConfig` reads them and builds the authorizer automatically.

```ts
import { policy$ } from "@loom/core";

policy$({
  id: "pii-guard",
  name: "PII guard",
  rules: {
    allow: ["metrics", "logs-*"],  // allow-list restricts to matching effects
    deny: ["external-http"],       // deny wins over allow
    match: [                       // richer matchers: glob on effect / principal.tenant / step
      { effect: "external-*", tenant: "acme", deny: true },
    ],
  },
});
```

Evaluation is **deny-wins**; a policy composes **under** the `authorizer` (both must allow — defense
in depth), so it can tighten a grant but never widen it, and a flow with no governing policy is
unaffected. Enforcement keys on `workflowId` (the flow is the unit of authority, like `GrantTable`).
Policies come from three places: each flow's `policies` (`flows` / `flowModules`), app-global
`config.policies`, and **agent-attached** `agent$({ policies })` — a capability-bound agent runs a
flow (via `capabilityAgents`), so its policies bind to that flow's `workflowId` and are enforced
whenever the agent runs it. *(A flow supplied only through a `catalog` but not wired to a policy
source uses the grant model.)*

## Effect classes: a static ceiling beside the runtime floor (ADR 0084)

Grants are a **runtime floor** — may this flow invoke this tool at all. Effect classes are a
**static ceiling** — may this flow reach something *worse than it declared*. They are separate
questions, so a granted capability can still bust the class and K2 will not stop it. `@loom/verify`'s
`effect-class` rule catches that before the run starts.

The class **vocabulary is yours** — Loom checks the ordering you give it rather than defining one:

```ts
defineConfig({
  checks: {
    verify: {
      mode: "error",
      effectClasses: ["read-only", "local-write", "external-write", "irreversible"], // ascending severity
    },
  },
});
```

Then each flow declares its ceiling with `flow$({ effectClass: "local-write" })` and each step the
class of the effect it performs with `step$({ effectClass })`. A flow's effective class is the max
over everything it reaches, composed conservatively. Omit the vocabulary and the rule is a no-op; a
flow that declares a ceiling but reaches *unclassified* steps is reported as **only partially
verified** rather than passing clean. See [`loom verify`](../usage-cli.md#loom-verify---config-module---manifest-path).

## Strict mode & the autonomy envelope (R9)

The kernel's defaults are permissive — a missing authorizer allows every effect, nothing bounds a run's duration, spawn depth or spend. `defineConfig({ security: { strict: true } })` is the baseline for agents that act unattended; the full table of defaults and the reasoning behind each is in [usage.md, Step 11](../usage.md#step-11--harden-it-grants-quotas-safety-secrets--isolation).

- **What strict refuses.** `defineConfig` throws, listing every problem, without `security.authorizer` and `security.executionAuthorizer`, and if `checks.verify` is `"off"`. Not strict, you get one advisory via `observability.onWarn`; `strict: false` silences it.
- **Fail-closed execution authz (R3).** Under strict a principal-less
  `start`/`resume`/`cancel`/`loadState` is handed to `security.executionAuthorizer` with
  `principal: undefined` instead of skipping it; `executionAccessPolicy` (`@loom/workflow-runtime`)
  is the reference policy (owner/tenant/any/deny per op, workflow allow-list, `allowAnonymous`
  default false). Timers, recovery and the child supervisor present `runtime.systemOptions()`;
  `LocalWorkerRuntime` does NOT by default: a dispatched package acts as its `principal` (an
  explicit `{ system }` option is for kernel re-drive targets only, and a worker-server in front of
  one needs `authorize`). `fork`, `restoreFromState` and `acquireFence` are gated like
  `resume`/`cancel`. Ownership is the principal the kernel records on `EXECUTION_STARTED` (R3k, ADR 0111)
  and hands to the policy as `request.owner`: it survives restarts, recovery and remote workers, and
  `resolveOwner` is consulted only for a log that predates it. The flow's effects run as that owner
  on every path; `options.principal` is only the lifecycle caller. Details in
  [usage.md, Step 11](../usage.md#step-11--harden-it-grants-quotas-safety-secrets--isolation).
- **The envelope** (`execution.envelope`): `spawn: { maxDepth, maxFanOut }` (hand
  `app.envelope.spawn` to `superviseChildren({ limits })`; `boundOrchestration(limits)` gives the
  parent-side refusal before anything durable happens),
  `budget: { perExecution, perAgent, perTenant, pricing }` (via `nestedBudgetMiddleware`, which
  meters on its own — do not also install `meteringMiddleware`), and `rateLimit`
  (`rateLimitMiddleware`: a token bucket, process-local, wall-clock driven, so it lives at the
  effect layer and never in the fold).
- **Kill switch** (`security.killSwitch`, or `app.killSwitch` under strict): `InMemoryKillSwitch` has `stopAll` / `stopTenant` / `stopWorkflow` and their `resume*`; a `KillSwitchRegistry` over a shared store stops across processes. It is the outermost middleware and fails closed if the registry throws. It stops the next effect only — it does not cancel running executions or their children.
- **Closing the model-call bypasses.** `agentLoop$({ reasoning })` and `llmSkillSelector(provider)`
  call a provider directly, outside authorization, metering and the kill switch. Use
  `reasoningToolId` (with `registerReasoningRoutes(effects, reasoning)`) so each routed call is a
  journaled effect frame, and `llmSkillSelector({ toolId })` so the selection is one;
  `requireEffectRing: true` refuses the direct spellings. A skill-selection or reasoning call made
  this way is charged to the execution and served from the log on replay.
- **Refusals are typed and non-retryable**: `QuotaExceededError`, `RateLimitExceededError`,
  `KillSwitchEngagedError`, `SpawnLimitExceededError` (each also carries `retryable: false`, which
  `retryMiddleware`'s default classifier honours). They are recorded as ordinary `STEP_FAILED`, so
  do not catch-and-continue past one (replay would re-run the step live). The strict default
  deadline applies to executions *started* under strict and is not durable across a resume; tenant
  scoping and spawn caps are best-effort until R3, budget does not see
  `ctx.decide`/`invokeTransient` spend, and strict does not reach remote workers — the full list is
  in [usage.md, Step 11](../usage.md#step-11--harden-it-grants-quotas-safety-secrets--isolation).

## Identity & delegated authority (K12)

Grants keyed on `workflowId` and an unverified `approvedBy` string aren't enough for a
platform kernel. K12 adds an authenticated **principal chain**, **verified** approvals, and
**verifiable** delegation — all opt-in, all carried *opaquely* by the kernel (authorizers
interpret them, so Loom stays generic).

```ts
// K12.1 — establish a principal at the trust boundary (start / resume API); it
// flows into every effect's K2 authorization, carried opaquely:
await runtime.start(flow, input, { principal: { tenant: "acme", actor: "alice" } });
// your CapabilityAuthorizer reads req.principal.tenant / .actor to decide.

// K12.2 — verify approvals so "who approved" is evidence, not a claim. A `defineConfig`
// key as well as a WorkflowRuntime dep; pre-flight verification ERRORS on a flow that
// declares `resumeSchemas` with nothing wired here (suspension-safety, K12):
defineConfig({ …, security: { resumeAuthenticator: {
  verify: (event) => event.eventType === "ApprovalGranted" && isValid(event)
    ? { status: "verified", actor: event.payload.approvedBy, verifiedBy: "sso.acme" }
    : { status: "rejected", reason: "unverified approval" },
} } });
// a rejected/forged approval REFUSES the resume (ApprovalRejectedError); a verified
// one records a durable APPROVAL_GRANTED { actor, verifiedBy } fact.

// K12.4 — verifiable attenuated delegation (macaroon-lite), checked at the callee:
import { signDelegation, DelegationAuthorizer } from "@loom/effect-runtime";
const token = signDelegation(secret, "callee-flow", ["deploy"]); // delegator confers a subset
const authorizer = new DelegationAuthorizer({ secret, base: calleeOwnGrants });
// principal.delegation = token → authorized only for effects in BOTH the VERIFIED
// delegation AND the callee's own grants (no ambient escalation); a forged token is
// denied outright, and attenuation can only narrow.
```

**Tenant isolation (K12.5).** Wrap a shared store so each tenant physically can't address
another's data — cross-tenant reads/subscriptions are impossible *by construction*, not by a
filter:

```ts
import { TenantScopedEventStore } from "@loom/event-runtime";
import { TenantScopedSnapshotStore } from "@loom/snapshot-runtime";
const eventStore = new TenantScopedEventStore(sharedEvents, tenantId);      // key-prefixed
const snapshotStore = new TenantScopedSnapshotStore(sharedSnaps, tenantId); // fork stays in-tenant
// (Postgres row-level security is an optional hardening layer on top of prefixing, not a replacement.)
```

**Nested budgets (K12.3).** Tenant → workflow → execution admission control, most-restrictive
wins:

```ts
import { nestedBudgetMiddleware, BudgetLedger } from "@loom/middleware";
const ledger = new BudgetLedger(); // a cross-execution projection, fed from RESOURCE_METERED
new EffectRuntime([nestedBudgetMiddleware({
  ledger, pricing,
  scopesOf: (ctx) => [
    { level: "tenant",    key: `tenant:${ctx.principal?.tenant}`, budget: { maxCostUsd: 100 } },
    { level: "workflow",  key: `workflow:${ctx.workflowId}`,      budget: { maxCostUsd: 20 } },
    { level: "execution", key: "",                                budget: { maxCostUsd: 2 } }, // pure fold
  ],
})]);
```

The tenant/workflow totals are an eventually-consistent **projection** (not a replay-pure
fold — a deliberate category difference the amendment states), so a trip is `QUOTA_EXCEEDED`
attributed to its `level`; the execution level still reads the pure per-execution fold (K3).

---

Back to [User Guide section 17](../user-guide.md#17-kernel-grants-quotas--supervision).
