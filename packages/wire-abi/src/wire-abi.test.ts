import { KERNEL_SYSCALLS } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { FOLD_VECTORS, runFoldVectors } from "./foldVectors";
import { WIRE_ABI, WIRE_METHODS, deriveWireMethods } from "./protocol";

describe("T2.1/T2.2 — the wire ABI is a projection of the K1 syscalls", () => {
  it("covers every K1 syscall exactly once (no drift — generated from KERNEL_SYSCALLS)", () => {
    const syscallNames = [...KERNEL_SYSCALLS].map((s) => s.name).sort();
    const wireSyscalls = WIRE_METHODS.map((m) => m.syscall).sort();
    expect(wireSyscalls).toEqual(syscallNames);
    expect(WIRE_METHODS.every((m) => m.method === `ctx.${m.syscall}`)).toBe(true);
  });

  it("partitions syscalls into unary vs channel (stream/ui are channels)", () => {
    const channels = WIRE_METHODS.filter((m) => m.semantics === "channel").map((m) => m.syscall).sort();
    expect(channels).toEqual(["stream", "ui"]);
    // execute/emit/etc. are unary.
    expect(WIRE_METHODS.find((m) => m.syscall === "execute")?.semantics).toBe("unary");
  });

  it("the descriptor reports both the wire version and the kernel ABI version it projects", () => {
    expect(WIRE_ABI.wireVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(WIRE_ABI.kernelAbiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(WIRE_ABI.syscalls).toBe(WIRE_METHODS);
  });

  it("re-derives identically from a syscall table (the projection is a pure function)", () => {
    expect(deriveWireMethods(KERNEL_SYSCALLS)).toEqual([...WIRE_METHODS]);
  });
});

describe("T2.3 — language-agnostic fold conformance vectors", () => {
  it("the reference fold matches every vector (event-log in → expected fold out)", () => {
    const results = runFoldVectors();
    const failures = results.filter((r) => !r.passed);
    expect(failures, JSON.stringify(failures)).toEqual([]);
    expect(results.length).toBe(FOLD_VECTORS.length);
  });

  it("vectors are plain JSON any client can load (round-trips through JSON)", () => {
    const roundTripped = JSON.parse(JSON.stringify(FOLD_VECTORS));
    expect(runFoldVectors(roundTripped).every((r) => r.passed)).toBe(true);
  });

  it("a broken fold is caught (a mutated expectation fails loudly)", () => {
    const broken = [{ ...FOLD_VECTORS[0]!, expected: { ...FOLD_VECTORS[0]!.expected, status: "failed" } }];
    expect(runFoldVectors(broken)[0]?.passed).toBe(false);
  });
});
