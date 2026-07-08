import type { ExecutionPolicy, ExecutionState } from "@loom/core";
import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { LocalDispatcher } from "./LocalDispatcher";
import { PlacementDispatcher } from "./PlacementDispatcher";
import { defaultPlacementPolicy, dispatchMetadataFromPolicy } from "./placement";

function resultStub(executionId: string): ExecutionResult {
  const state: ExecutionState = {
    executionId,
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status: "completed",
    frames: {},
    variables: { _output: { ok: true } },
    sequence: 1,
    startedAt: 0,
    updatedAt: 0,
  };
  return { executionId, status: "completed", state, output: { ok: true }, lastSequence: 1 };
}

/** A fake WorkerRuntime that tags each run with its target name so routing is observable. */
class TaggedWorker implements WorkerRuntime {
  ran: string[] = [];
  constructor(private readonly name: string) {}
  async allocate(req: WorkerRequest): Promise<WorkerLease> {
    return { leaseId: `${this.name}-${req.executionId}` };
  }
  async execute(_lease: WorkerLease, pkg: ExecutionPackage): Promise<ExecutionResult> {
    this.ran.push(pkg.executionId);
    return resultStub(pkg.executionId);
  }
  async release(): Promise<void> {}
}

function pkg(executionId = "e1"): ExecutionPackage {
  return { executionId, workflowId: "wf", flowId: "wf", input: {} };
}

function makeTargets() {
  const localWorker = new TaggedWorker("local");
  const cloudWorker = new TaggedWorker("cloud");
  const dispatcher = new PlacementDispatcher({
    targets: {
      local: new LocalDispatcher(localWorker),
      cloudrun: new LocalDispatcher(cloudWorker),
    },
    default: "local",
  });
  return { dispatcher, localWorker, cloudWorker };
}

describe("PlacementDispatcher — routing", () => {
  it("routes to the target named by meta.target", async () => {
    const { dispatcher, localWorker, cloudWorker } = makeTargets();
    await dispatcher.dispatch(pkg("a"), { target: "cloudrun" });
    expect(cloudWorker.ran).toEqual(["a"]);
    expect(localWorker.ran).toEqual([]);
  });

  it("falls back to the default target when no target is given", async () => {
    const { dispatcher, localWorker, cloudWorker } = makeTargets();
    await dispatcher.dispatch(pkg("b"));
    expect(localWorker.ran).toEqual(["b"]);
    expect(cloudWorker.ran).toEqual([]);
  });

  it("falls back to the default target when the named target is unknown", async () => {
    const { dispatcher, localWorker } = makeTargets();
    await dispatcher.dispatch(pkg("c"), { target: "mars" });
    expect(localWorker.ran).toEqual(["c"]);
  });

  it("routes by an ExecutionPolicy via dispatchMetadataFromPolicy", async () => {
    const { dispatcher, cloudWorker } = makeTargets();
    const policy: ExecutionPolicy = {
      computeTarget: "cloudrun",
      priority: 1,
      resources: { cpu: 2, memoryMb: 512 },
      affinity: "gpu",
    };
    const meta = dispatchMetadataFromPolicy(policy);
    expect(meta).toEqual({
      target: "cloudrun",
      priority: 1,
      lane: "gpu",
      estimatedCpu: 2,
      estimatedMemory: 512,
    });
    await dispatcher.dispatch(pkg("d"), meta);
    expect(cloudWorker.ran).toEqual(["d"]);
  });

  it("supports a custom, resource-aware placement policy", async () => {
    const local = new TaggedWorker("local");
    const cloud = new TaggedWorker("cloud");
    const dispatcher = new PlacementDispatcher({
      targets: { local: new LocalDispatcher(local), cloudrun: new LocalDispatcher(cloud) },
      default: "local",
      // Big jobs go to the cloud; small jobs stay local.
      policy: (_p, meta, targets) =>
        (meta?.estimatedMemory ?? 0) > 256 && targets.includes("cloudrun") ? "cloudrun" : "local",
    });
    await dispatcher.dispatch(pkg("small"), { estimatedMemory: 128 });
    await dispatcher.dispatch(pkg("big"), { estimatedMemory: 1024 });
    expect(local.ran).toEqual(["small"]);
    expect(cloud.ran).toEqual(["big"]);
  });
});

describe("PlacementDispatcher — lifecycle", () => {
  it("routes cancel to the target that handled the execution", async () => {
    const local = new LocalDispatcher(new TaggedWorker("local"));
    const cloud = new LocalDispatcher(new TaggedWorker("cloud"));
    const localCancel = vi.spyOn(local, "cancel");
    const cloudCancel = vi.spyOn(cloud, "cancel");
    const dispatcher = new PlacementDispatcher({
      targets: { local, cloudrun: cloud },
      default: "local",
    });

    await dispatcher.dispatch(pkg("x"), { target: "cloudrun" });
    await dispatcher.cancel("x");

    expect(cloudCancel).toHaveBeenCalledWith("x");
    expect(localCancel).not.toHaveBeenCalled();
  });

  it("broadcasts cancel when placement is unknown", async () => {
    const local = new LocalDispatcher(new TaggedWorker("local"));
    const cloud = new LocalDispatcher(new TaggedWorker("cloud"));
    const localCancel = vi.spyOn(local, "cancel");
    const cloudCancel = vi.spyOn(cloud, "cancel");
    const dispatcher = new PlacementDispatcher({
      targets: { local, cloudrun: cloud },
      default: "local",
    });

    await dispatcher.cancel("never-dispatched");
    expect(localCancel).toHaveBeenCalledWith("never-dispatched");
    expect(cloudCancel).toHaveBeenCalledWith("never-dispatched");
  });

  it("aggregates health across targets", async () => {
    const { dispatcher } = makeTargets();
    const health = await dispatcher.health();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain("local:");
    expect(health.detail).toContain("cloudrun:");
  });

  it("with a single target, behaves like that target (existing dispatch unchanged)", async () => {
    const worker = new TaggedWorker("only");
    const dispatcher = new PlacementDispatcher({
      targets: { only: new LocalDispatcher(worker) },
      default: "only",
    });
    const result = await dispatcher.dispatch(pkg("solo"), { target: "ignored" });
    expect(result.status).toBe("completed");
    expect(worker.ran).toEqual(["solo"]);
  });

  it("rejects a default target that is not registered", () => {
    expect(
      () =>
        new PlacementDispatcher({
          targets: { local: new LocalDispatcher(new TaggedWorker("local")) },
          default: "cloudrun",
        })
    ).toThrow(/default target/);
  });
});

describe("defaultPlacementPolicy", () => {
  it("honours a registered target, else returns the default", () => {
    const policy = defaultPlacementPolicy("local");
    expect(policy(pkg(), { target: "cloudrun" }, ["local", "cloudrun"])).toBe("cloudrun");
    expect(policy(pkg(), { target: "mars" }, ["local", "cloudrun"])).toBe("local");
    expect(policy(pkg(), undefined, ["local", "cloudrun"])).toBe("local");
  });
});
