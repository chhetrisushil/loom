# @loomwork/task-authority — authority scoped to the task

Today an agent's authority is the sum of what its principal may do, so a prompt-injected agent can use all
of it. This package narrows authority to the task: a signed per-task grant names the effects an execution
may run, side-effect leases count attempts and pause the run for renewal when exhausted, and a child's
lease is carved from its parent's by reservation. The kernel is untouched; everything sits behind the
existing authorizer and metering seams.

Slice 1 is in progress; this package currently exports only a version marker.

Design: [ADR 0150 — task-scoped authority](../../docs/adr/0150-task-scoped-authority.md).
