import type { ExecutionState } from "@loom/core";
import type { ExecutionPackage, ExecutionResult } from "@loom/worker-runtime";
import { describe, expect, it } from "vitest";
import { CircuitOpenError, SupervisingDispatcher } from "./SupervisingDispatcher";
import type { DispatcherHealth, ExecutionDispatcher } from "./types";

function resultStub(executionId: string): ExecutionResult {
  const state: ExecutionState = {
    executionId,
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status: "completed",
    frames: {},
    variables: {},
    sequence: 1,
    startedAt: 0,
    updatedAt: 0,
  };
  return { executionId, status: "completed", state, lastSequence: 1 };
}

const pkg = (id = "e1"): ExecutionPackage => ({
  executionId: id,
  workflowId: "wf",
  flowId: "flaky-flow",
  input: {},
});

/** A child dispatcher whose per-call behaviour is scripted. */
class ScriptedDispatcher implements ExecutionDispatcher {
  calls = 0;
  cancelled: string[] = [];
  constructor(private readonly behavior: (call: number) => "ok" | "throw") {}
  async dispatch(p: ExecutionPackage): Promise<ExecutionResult> {
    this.calls += 1;
    if (this.behavior(this.calls) === "throw") throw new Error("dispatch boom");
    return resultStub(p.executionId);
  }
  async cancel(id: string): Promise<void> {
    this.cancelled.push(id);
  }
  async health(): Promise<DispatcherHealth> {
    return { healthy: true, inFlight: 0 };
  }
}

const noSleep = () => Promise.resolve();

describe("SupervisingDispatcher — restart", () => {
  it("passes a success straight through", async () => {
    const child = new ScriptedDispatcher(() => "ok");
    const sup = new SupervisingDispatcher(child, { sleep: noSleep });
    expect((await sup.dispatch(pkg())).status).toBe("completed");
    expect(child.calls).toBe(1);
  });

  it("restarts a throwing dispatch up to maxRestarts, then succeeds", async () => {
    const child = new ScriptedDispatcher((n) => (n === 1 ? "throw" : "ok"));
    const sup = new SupervisingDispatcher(child, {
      policy: { maxRestarts: 2, backoffMs: 10 },
      sleep: noSleep,
    });
    expect((await sup.dispatch(pkg())).status).toBe("completed");
    expect(child.calls).toBe(2); // one failed + one success
  });

  it("rethrows after exhausting restarts", async () => {
    const child = new ScriptedDispatcher(() => "throw");
    const sup = new SupervisingDispatcher(child, { policy: { maxRestarts: 1 }, sleep: noSleep });
    await expect(sup.dispatch(pkg())).rejects.toThrow(/dispatch boom/);
    expect(child.calls).toBe(2);
  });
});

describe("SupervisingDispatcher — circuit breaker", () => {
  it("opens after threshold consecutive failures and then fails fast", async () => {
    const child = new ScriptedDispatcher(() => "throw");
    const sup = new SupervisingDispatcher(child, {
      policy: { circuit: { threshold: 2, cooldownMs: 1000 } },
      now: () => 0,
      sleep: noSleep,
    });

    // Two real failures reach the child and open the circuit.
    await expect(sup.dispatch(pkg("a"))).rejects.toThrow(/dispatch boom/);
    await expect(sup.dispatch(pkg("b"))).rejects.toThrow(/dispatch boom/);
    expect(child.calls).toBe(2);

    // Circuit now open → fail fast without touching the child.
    await expect(sup.dispatch(pkg("c"))).rejects.toBeInstanceOf(CircuitOpenError);
    expect(child.calls).toBe(2);

    const health = await sup.health();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("circuits-open");
  });

  it("half-opens after the cooldown and closes on a successful trial", async () => {
    let clock = 0;
    // Fail the first 2 calls (open circuit), succeed afterwards.
    const child = new ScriptedDispatcher((n) => (n <= 2 ? "throw" : "ok"));
    const sup = new SupervisingDispatcher(child, {
      policy: { circuit: { threshold: 2, cooldownMs: 1000 } },
      now: () => clock,
      sleep: noSleep,
    });

    await expect(sup.dispatch(pkg())).rejects.toThrow(/boom/);
    await expect(sup.dispatch(pkg())).rejects.toThrow(/boom/); // circuit opens at clock=0
    await expect(sup.dispatch(pkg())).rejects.toBeInstanceOf(CircuitOpenError); // still cooling

    clock = 1000; // cooldown elapsed → half-open trial allowed
    expect((await sup.dispatch(pkg())).status).toBe("completed");
    expect(child.calls).toBe(3); // the trial reached the child

    const health = await sup.health();
    expect(health.healthy).toBe(true); // circuit closed again
  });

  it("delegates cancel to the child", async () => {
    const child = new ScriptedDispatcher(() => "ok");
    const sup = new SupervisingDispatcher(child);
    await sup.cancel("x");
    expect(child.cancelled).toEqual(["x"]);
  });
});

describe("circuit bookkeeping is bounded", () => {
  it("forgets a circuit once it succeeds, whatever the key function", async () => {
    // Every key must FAIL first — a success alone never creates an entry, so a test that
    // only dispatches happy calls proves nothing about the map. Odd calls throw, even
    // calls succeed, so each key is created by a failure and then resolved by a success.
    const child = new ScriptedDispatcher((n) => (n % 2 === 1 ? "throw" : "ok"));
    // The shape that leaks: a key with per-execution cardinality, which the policy hook
    // invites by handing the whole ExecutionPackage to the key function.
    const dispatcher = new SupervisingDispatcher(child, {
      sleep: noSleep,
      policy: { circuit: { threshold: 5, cooldownMs: 1_000, key: (p) => p.executionId } },
    });
    const circuits = (dispatcher as unknown as { circuits: Map<string, unknown> }).circuits;

    for (let i = 0; i < 200; i++) {
      await expect(dispatcher.dispatch(pkg(`x-${i}`))).rejects.toThrow("dispatch boom");
      expect(circuits.size).toBe(1); // the failure is remembered while it matters
      await dispatcher.dispatch(pkg(`x-${i}`)); // …and forgotten once resolved
      expect(circuits.size).toBe(0);
    }
  });
});

describe("SupervisingDispatcher — superseded refusals (L20)", () => {
  it("neither restarts a superseded dispatch nor counts it against the circuit", async () => {
    const superseded = Object.assign(new Error("lost"), {
      name: "ExecutionAlreadyExistsError",
      executionId: "e1",
    });
    let calls = 0;
    const child: ExecutionDispatcher = {
      async dispatch() {
        calls += 1;
        throw superseded;
      },
      async cancel() {},
      async health() {
        return { healthy: true, inFlight: 0 };
      },
    };
    const sup = new SupervisingDispatcher(child, {
      policy: { maxRestarts: 3, circuit: { threshold: 1, cooldownMs: 60_000 } },
      sleep: noSleep,
    });

    await expect(sup.dispatch(pkg())).rejects.toBe(superseded);
    await expect(sup.dispatch(pkg())).rejects.toBe(superseded); // not CircuitOpenError
    expect(calls).toBe(2);
    expect((await sup.health()).healthy).toBe(true);
  });

  it("still restarts a genuine storage failure", async () => {
    const child = new ScriptedDispatcher((n) => (n === 1 ? "throw" : "ok"));
    const sup = new SupervisingDispatcher(child, { policy: { maxRestarts: 1 }, sleep: noSleep });
    await expect(sup.dispatch(pkg())).resolves.toMatchObject({ status: "completed" });
    expect(child.calls).toBe(2);
  });
});
