import { sensitive } from "@loom/classify";
import { flow$, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { verify } from "@loom/verify";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveVerifyInput } from "./verifyAdapter";

// End-to-end: the marks are derived from the REAL step schemas inside the adapter, so the
// check cannot be skipped by forgetting to wire it. A mark under a container the dot-path
// sinks cannot address is silently inert — masked nowhere, encrypted nowhere, externalized
// nowhere — and this is what says so. Arrays ARE addressable (#260), so they must not fire.

function runtimeWith(inputSchema: z.ZodTypeAny, outputSchema: z.ZodTypeAny): WorkflowRuntime {
  const effects = new EffectRuntime();
  effects.register("t", new ToolEffect(async () => ({})));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const step = step$({ id: "collect", name: "collect", toolId: "t", inputSchema, outputSchema });
  const definition = flow$({
    id: "intake",
    name: "intake",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    steps: [step],
  });
  runtime.registerFlow(definition, (async () => ({})) as FlowRunner<unknown, unknown>);
  return runtime;
}

const findings = (runtime: WorkflowRuntime) =>
  verify(resolveVerifyInput(runtime), { rules: ["classification-reachability"] });

describe("classification-reachability (K10-R1) end to end", () => {
  it("fails an app whose sensitive field sits inside a record", () => {
    const runtime = runtimeWith(
      z.object({ byId: z.record(z.object({ ssn: sensitive(z.string()) })) }),
      z.object({})
    );
    const report = findings(runtime);
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    const [f] = report.findings;
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("byId.<record>.ssn");
    expect(f?.message).toContain("`record`");
    // Points at the step that declared it, so the fix is locatable.
    expect(f?.location).toBe("intake:collect");
  });

  it("does NOT fire for marks under arrays — those reach the sinks (#260)", () => {
    const report = findings(
      runtimeWith(
        z.object({ people: z.array(z.object({ ssn: sensitive(z.string()) })) }),
        z.object({})
      )
    );
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("checks output schemas too — egress is the whole point", () => {
    const report = findings(
      runtimeWith(
        z.object({}),
        z.object({ rows: z.record(z.object({ email: sensitive(z.string()) })) })
      )
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toContain("rows.<record>.email");
  });

  it("passes the supported spelling — marking the record itself", () => {
    const report = findings(
      runtimeWith(
        z.object({ byId: sensitive(z.record(z.object({ ssn: z.string() }))) }),
        z.object({})
      )
    );
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("is inert for an app with no stranded marks (G2)", () => {
    const report = findings(
      runtimeWith(z.object({ ssn: sensitive(z.string()), id: z.string() }), z.object({}))
    );
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("runs as part of the default rule set, not only when asked for", () => {
    const runtime = runtimeWith(
      z.object({ byId: z.record(z.object({ ssn: sensitive(z.string()) })) }),
      z.object({})
    );
    const report = verify(resolveVerifyInput(runtime));
    expect(report.checked).toContain("classification-reachability");
    expect(report.findings.some((f) => f.rule === "classification-reachability")).toBe(true);
  });
});
