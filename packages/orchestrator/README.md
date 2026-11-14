# @loomwork/orchestrator — a small approval policy and a plan-dispatch loop

Two plain functions that an app's own "conductor" calls: `decideApproval` (auto-approve a low-risk
action when the goal text allows it, otherwise wait for a human) and `dispatchPlan` (route, plan, then
dispatch each step in order, stopping early on request). It is composition, not a base class: your code
keeps every side effect and passes it in as a callback.

This is **not** `@loomwork/orchestration`, which awaits child executions durably. Nothing here is recorded
in the event log; it is ordinary async control flow, so a crash mid-loop does not resume it. For durable
approval gates use a flow that suspends and resumes.

```ts
import { decideApproval, dispatchPlan } from "@loomwork/orchestrator";

type Step = { capabilityId: string };

const goal = "restart the cache and then flush the queue"; // no auto-approval wording: a human decides
let rejected = false;

const steps = await dispatchPlan<Step>({
  goal,
  plan: async () => ({
    steps: [{ capabilityId: "restart-cache" }, { capabilityId: "flush-queue" }],
  }),
  dispatch: async (step) => {
    const decision = await decideApproval(
      { goal, riskLevel: "low" },
      { waitForManual: async () => ({ approved: false, approvedBy: "operator" }) }
    );
    if (!decision.approved) rejected = true;
    return { status: decision.approved ? "done" : "rejected", artifact: step.capabilityId };
  },
  isTerminal: () => rejected, // checked after each step
});
```

## Surface

- **`decideApproval(input, handlers)`** resolves `{ approved, approvedBy }`. It auto-approves, as
  `"risk-policy"`, when `riskLevel === "low"` and `autoApprovalAllowed(goal)`; otherwise it calls
  `waitForManual`. `onAutoApprove` and `onManualRequired` are optional hooks.
- **`autoApprovalAllowed(goal)`** is the goal-text check on its own.
- **`dispatchPlan(config)`** runs `route` (optional, observation only), `plan`, then `dispatch` for each
  step in order, calling `onRouted`, `onPlanned` and `onResult`, and returns the planned steps.

## Behaviour that surprises people

- **The policy is a regex over free text.** `autoApprovalAllowed` matches `low risk`, `automatically`,
  `auto-fix`, `autofix` or the bare substring `auto`, case-insensitively, anywhere in the goal. A goal
  containing "automation" or "do not auto-fix" also matches. If the goal can come from an untrusted
  source, do not treat this as an authorization check.
- **Only `riskLevel: "low"` can auto-approve.** Any other string goes to the human.
- **Errors propagate.** `dispatchPlan` does not catch a throwing `dispatch` and does not retry.
- **`isTerminal` is checked after each step**, so the step that triggered it has already run.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- API reference: section "`@loomwork/orchestrator` — composable orchestration" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Durable fan-out and gates: [ADR 0040](../../docs/adr/0040-live-query-and-orchestration.md)
  (`@loomwork/orchestration`).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
