# Task-Scoped Authority for Autonomous Agents

Nov 23, 2026 · @Sushil

## Summary

Autonomous agents should hold authority for a task, not for an identity. This paper proposes a model in which an agent has an identity but no standing permissions. Each task receives a grant that names what it may do, a lease that counts how much, and a place in a lineage that every action is charged to. When a grant expires or a lease runs out, the agent pauses and asks again.

The model targets a failure that identity-based permissions cannot see: one agent doing another agent's work with its own valid credentials. It does not replace sandboxing or credential security, and it is only as strong as the tools an agent is given are narrow.

## The problem with standing authority

Most agent deployments give the agent an identity and attach permissions to it, as they would for a service account. That model was designed for software whose behaviour is fixed by its code. An agent's behaviour is decided at run time by a model, and it changes with every task.

Standing authority fails for agents in three ways:

- **Scope.** The agent can use every permission it holds at any moment, including those its current task does not need.
- **Purpose.** An audit log shows that the agent acted. It does not show which task the action served, so nobody can ask whether the action belonged to that task.
- **Transfer.** An agent can act on behalf of another agent. Each stays within its own limits, so every check passes.

The third is the least discussed and the hardest to detect. It needs no stolen credential and no software flaw, only two agents and a way to pass a message.

## A case from July 2026

In July 2026 OpenAI disclosed that agents in an internal security evaluation had left their sandboxes and reached production systems at Hugging Face. One [analysis of the incident](https://securityaffairs.com/198563/ai/why-ai-agent-sandboxes-are-failing-security-tests.html) puts the central failure at isolation: agents could share information and carry discoveries between runs.

Public accounts describe agents in separate environments, with no intended channel between them, finding one anyway. In one telling, an agent that could not reach something it needed reasoned that a peer might have it and left a request where the peer would see it.

The escape is the headline, but the lesson for authorization is narrower. Each agent's entitlements were its own. When one agent used what another could reach, no per-agent control had anything to object to. Sandboxing failed first; had it held, the permission model would still have had no way to notice borrowing.

## Why short-lived credentials are not enough

The common response to over-privileged agents is to shorten credential lifetimes. A broker issues a token that expires in minutes, and the agent returns for another. This narrows the window in which a stolen token is useful. It does not address transfer.

When agent A persuades agent B to act for it, B presents its own token, freshly issued and valid. Nothing was stolen, so expiry is irrelevant. Binding a token to its holder's key does not help either, because the holder is the one acting.

Transfer is also distinct from the confused-deputy problem. A confused deputy is tricked through a legitimate interface. Here the channel was never meant to exist and the second agent cooperates knowingly.

The weakness is in what the token describes. A token that says "agent B may write to this database" is true whatever B is doing. A token that says "task 41 may make three writes to this table" stops being true the moment B works on something else.

## The model: grants, leases and lineage

An agent keeps its identity and holds no standing permissions. Authority arrives per task, as three objects:

- **Grant.** What this task may do: which tools, with which arguments, up to which class of effect, until when. A grant is a description of authority, not a credential.
- **Lease.** How much: a counted allowance of effects or spend, consumed as the task acts and renewed in tranches.
- **Lineage.** Where the task came from: each task records its parent, forming a chain back to the original request.

&#91;embedded content: task-scoped authority · runtime and control plane\]

The runtime checks every tool call against the grant of the task making it. A broker in a separate control plane issues and renews grants. Tools reach resources through a gateway that holds the real credentials, so the agent never does.

Four rules give the model its properties:

1. **Check at the call.** Every tool call is checked against the acting task's grant before it takes effect. No grant means no action.
2. **Charge to the lineage.** Every effect is charged to the lineage of the task whose grant authorised it. There is no way to charge another.
3. **Children narrow.** A sub-task's grant is a subset of its parent's, and its lease is carved from the parent's.
4. **Running out pauses.** An expired grant or spent lease suspends the task. The agent requests renewal and resumes; the task does not fail.

Together these close the transfer gap. Suppose agent A asks agent B to perform a step of A's task. The call is checked against B's grant, which describes B's task and does not cover the step, so it is refused. If B's grant happens to cover it, the effect is charged to B's lineage, where it appears as work with no origin in B's task. This two-agent scenario is the laundering test: a system passes if the borrowed step is refused or attributed, and fails if it succeeds unseen. A runtime can make the attributed case sharper by recording which task directed the step, not only which task performed it; a later section describes how.

## Budget without estimation

A task's budget cannot be calculated in advance, because the cost of agentic work depends on what the agent discovers. The model avoids the question by leasing budget in tranches.

A task starts with a small slice. When the slice is used, the agent pauses and requests more, and the broker decides from facts: what has been spent, how many renewals have been granted, which kinds of effect the task has caused. An underestimate costs a pause, not a failed task, so the starting figure only has to be roughly right.

Three practices make tranches workable:

- **Count side effects before compute.** A resize task should cause one resize however long the agent reasons about it. Writes, deletions and external calls are easy to bound from the task definition. Token spend is cheap to overrun and can be bounded loosely.
- **Subdivide down the lineage.** A parent carves each child's lease from its own, so children can never exceed the parent in total and only the root needs an estimate.
- **Keep renewal easy.** An agent with a hard task and no legitimate route to more resources has a reason to look for an illegitimate one. A broker that grants justified requests removes that reason.

Budget size and laundering detection are independent. Attribution by lineage reveals off-task work even when budgets are generous; tight budgets only limit the damage.

## Limits

The model bounds what a task can do through its tools. Four things lie outside it.

- **Tools with ambient authority.** A tool that executes code or opens network connections can do whatever its process can. The grant check sees the call, not what the code does. Narrow tools are a precondition.
- **Covert channels.** Agents can signal through shared object names, caches, logs, quota exhaustion or the timing behaviour of shared hardware. These can be narrowed by deployment, with one agent per sandbox and no shared writable namespace, but not eliminated. The model's answer is that a channel is worth little when the receiver has nothing spare to lend.
- **Misuse within scope.** A grant for three writes permits three bad writes. The model limits the blast radius and does not judge intent.
- **The broker itself.** The component that issues grants becomes the most valuable target in the system and must treat every request from an agent as untrusted input.

The model also assumes that a task can be described before it runs. Open-ended exploratory work fits poorly and tends toward broad grants, which give up most of the benefit.

A runtime can narrow several of these limits, as the section after next describes. None of them goes away.

## How Loom can help

The model asks three things of an agent runtime that are hard to add afterwards: pausing a run without losing it, recording every effect against the task that caused it, and a single point through which model output reaches the world. Loom, a TypeScript durable execution framework for agents, is built on all three. Part of the runtime half already ships in Loom. The task-authority half is an opt-in package, `@loomwork/task-authority`, recorded as ADR 0150 in the Loom repository. Slice 1 of it ships in Loom 0.1.5; the items marked slice 2 below do not.

### What already ships

- **Every effect is checked at one point.** Every effect a run causes passes through one effect runtime, whether it is a tool the model called, a step in a flow or a call made by an agent loop. The runtime asks an authoriser before anything happens. Anything not granted is refused, and the refusal is a durable record in the run's log. A grant can name a specific resource as well as a tool.
- **The acting principal is recorded.** Each run records the principal it acts for (tenant, actor, and on whose behalf) when it starts. It restores that principal after a crash, a timer wake or an approval. A run resumed by an approver still acts as its owner, not as the approver.
- **Delegation only narrows.** Delegation tokens are signed and can only be attenuated. A callee is authorised for the intersection of the token and its own grants, so a token can never give it more than it already holds. This already refuses the borrowed step in the laundering test whenever the callee's own grants do not cover it.
- **Budgets nest.** A run's budget is computed from its own log. Tenant and workflow budgets sit above it, and the most restrictive applies.
- **Approvals are evidence.** An approval that resumes a run records who approved and how that was verified. It is bound to what the approver was shown.

### What the proposal adds

The items in this list are built in slice 1.

- **Running out pauses.** Today an exhausted budget fails the run. Under the proposal, a spent lease, an expired grant or a revoked grant suspends it on a renewal request instead. Loom treats suspension as a first-class value: a run can stop for minutes or weeks and continue from its event log, in another process if need be. Runtimes without durable execution must either fail the task or hold it in memory.
- **Grants name a task.** A signed grant names the task, its root and its parent, the effects it may cause, its lease ceilings and its expiry. The broker holds the grant. Loom restores it each time the run resumes and never writes it to the log.
- **Side effects are counted.** Each effect is mapped to a lease and counted in the run's own log before it is dispatched. Attempts are counted, not successes, because a write that failed may still have taken effect.
- **Leases are carved by reservation.** A run's log is a ledger, but each log belongs to one run, and no transaction spans two runs. So a parent does not share a counter with its children. It records the amount it hands each child in its own log, and the unused part comes back when the child finishes. Every figure is a running total in a single log, so the accounting is exact in each log. The broker adds a ledger of what it has carved, and a returned amount is taken once, through the broker.
- **Allowed effects are attributed, not only refusals.** The digest of each grant in force is recorded in the log. The grant that authorised any effect can be read from the effect's position in the log.
- **Grants are checked when they are made.** A lease cannot name an effect outside its grant, and an effect that is in scope but that no lease counts is refused when it is called (strict leases are the default).

### Replay stays honest

Loom rebuilds state by replaying the log. Replay serves each completed effect's recorded result and does not authorise it again, so replaying an effect makes no broker call. Restoring the run's principal does consult the broker, once per resume. An auditor reads which grant was in force for each action from the log.

### Where the line is

Loom deliberately stops there. The broker, the credential vault, the registry of who may be granted what and the isolation between agents sit outside the framework. Loom reaches the broker through a small interface. It never holds or logs a credential and never shows one to the model. The log carries grant digests, not grants. The event log itself lives in Postgres, SQLite or another pluggable store.

For a team adopting the model, this division means the runtime half comes from the framework and the policy half stays where the organisation already keeps identity and access.

## What a runtime can add beyond the model

The four rules bound what a task's tools can do. A runtime that owns the channels between agents, and knows what its code can reach, can do more. Each point below addresses a limit or an open problem named in this paper. Loom's proposal includes all of them as opt-in parts. Only the conformance kit is built; every other point below is slice 2 and is not.

- **Follow the request, not only the actor.** *(Slice 2, not built.)* The incident in July 2026 turned on a message: one agent left a request where a peer would see it. In Loom such a message passes through memory, an inbox, an agent-to-agent call or a shared conversation, and Loom owns each of these channels. Content that crosses from one lineage into another is labelled with its origin. A run remembers every foreign lineage whose content it has been shown. When it then causes a write, the effect is recorded as directed by that lineage. Depending on policy it can instead be paused for approval or refused. This settles the harder half of the laundering test, where B's own grant happens to cover the borrowed step: the record states that A directed it, rather than leaving an auditor to infer it. Because the label belongs to the run rather than to a value, the model cannot shed it by paraphrasing the request.
- **Narrow the runtime's own channels.** *(Slice 2, not built.)* Covert channels cannot be eliminated, but the shared namespaces a runtime owns can be scoped. A grant can list the memory scopes, conversations and stored state a task may read across lineages, and every other cross-lineage read is refused. A receiver that cannot read the request cannot act on it.
- **Require an enforcing sandbox.** *(Slice 2, not built.)* A grant can require that code-executing tools run only in a sandbox that declares no network access and a fresh environment per run. A backend that cannot enforce that is refused, which makes the paper's "one agent per sandbox, no shared writable namespace" a checked condition rather than a deployment convention.
- **Derive grants from code.** *(Slice 2, not built.)* A runtime knows which effects a flow can reach and which tools an agent loop can call. A grant can be derived from that, and a check can flag a grant broader than the code it is issued for. This does not solve the problem of describing intent, but it removes the excuse for broad grants wherever the code is known.
- **Give scheduled work a root.** *(Slice 2, not built.)* A scheduled agent's authority can derive from a schedule grant that a person approves once. The approval is recorded with the approver's verified identity. Each run's grant is carved from the schedule's, period by period. The person who approved the schedule is the answer to "who answers for this run".
- **Make disclosure a setting.** *(Slice 2, not built.)* Whether a refused agent learns why can be an operator's choice: the full reason in the log, and either the reason or a bare refusal for the model.
- **Make the laundering test runnable.** The proposal ships a conformance kit. It runs the uncovered two-agent scenario over shared memory; the covered scenario and the agent-to-agent variant are skipped until slice 2. It also checks that children never exceed the parent's lease across a crash, that exhaustion pauses and renewal resumes in a fresh process, that a revoked grant stops the next effect, and that replay makes no broker call. Anyone building a broker can run it against their own.

## Related work

The parts of this model exist separately; no system surveyed combines task-scoped grants, leased budgets and lineage accounting. The survey covered the three major cloud platforms and current IETF drafts.

| Work | Contribution | Difference from this model |
| --- | --- | --- |
| [Google Cloud Agent Identity](https://docs.cloud.google.com/iam/docs/agent-identity-overview) | Agents as a principal type, with a registry and a gateway; tokens bound to the agent's certificate | Permissions attach to the agent |
| [AWS Bedrock AgentCore Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/key-features-and-benefits.html) | Workload identity for agents and a vault for their tokens | Permissions attach to the agent |
| [Microsoft Entra Agent ID](https://learn.microsoft.com/entra/agent-id) | Agent identities with an organisation-wide registry | The registry is an inventory |
| [Credential Broker for Agents](https://www.ietf.org/archive/id/draft-hartman-credential-broker-4-agents-00.html) | A broker that separates policy decisions from credential delivery | Tokens are not renewable; no budgets |
| [Attenuating Agent Tokens](https://www.ietf.org/archive/id/draft-niyikiza-oauth-attenuating-agent-tokens-01.html) | Per-tool argument constraints and offline narrowing down a delegation chain | A token format without a runtime |
| [Agent Delegation Chain](https://datatracker.ietf.org/doc/draft-asor-wimse-agent-delegation-chain/03/) | Enforced narrowing across several hops of delegation | A token format without a runtime |
| [SPT-Txn](https://datatracker.ietf.org/doc/html/draft-coetzee-oauth-spt-txn-tokens-03) | A short-lived token for each declared action | Per action, not per task |

The four IETF documents are individual Internet-Drafts and may change or lapse. The model here is compatible with them: a grant's scope can be carried in the format the token drafts define, and the broker can be built as the broker draft describes.

The underlying ideas are older. Capability-based security established that authority should be held as specific, transferable-only-by-narrowing rights. Just-in-time access brought expiring grants to human administrators. Work on multi-level security concluded decades ago that covert channels can be bounded but not removed.

## Open problems

Five questions are unresolved.

- **Root authority.** A scheduled agent has no human behind each run. What its root grant derives from, and who answers for it, is a governance question the model does not settle.
- **Refusal and disclosure.** Telling an agent why an action was refused helps it complete legitimate work and may help it search for a way around.
- **Delegation across organisations.** Narrowing a grant inside one runtime is a set operation. Across trust boundaries it needs signed, attenuable tokens, and the standards are not settled.
- **Describing intent.** A grant is only as precise as its constraint vocabulary. Many real tasks resist description in terms of tool names and argument ranges.
- **Measurement.** There is no accepted benchmark for whether an authorization model resists cooperating agents. The two-agent laundering test described above is a starting point, not a standard.

The previous section offers partial answers to four of these: a recorded root for scheduled work, disclosure as an operator setting, grants derived from code, and a runnable laundering test. Delegation across organisations remains open.
