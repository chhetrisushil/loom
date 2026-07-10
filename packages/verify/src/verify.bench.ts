import { bench, describe } from "vitest";
import type { FlowSpec, VerifyInput } from "./types";
import { runVerification, verify } from "./verify";

/**
 * G2 (zero-overhead-when-unwired) is the load-bearing property of `verify`: with
 * `mode: "off"` the config projection must never even be built. These benches make that
 * benchmark-provable — the `off` path should be orders of magnitude cheaper than the
 * `warn`/`error` path, which pays for `buildInput()` + all six rules.
 */

function makeFlow(i: number): FlowSpec {
  return {
    id: `flow-${i}`,
    flowHash: `sha256:${i}`,
    nonDeterministicCalls: [{ callee: "Math.random", insideDecide: true }],
    suspends: [{ id: "s", correlationKey: "k", timed: true, wakeAt: true }],
    effects: [{ toolId: `tool-${i}`, capability: `cap.${i}`, kind: "step" }],
    computeTarget: "cloud-run",
    budget: { dimensions: ["tokens", "costUsd"], ceilings: { tokens: 1000, costUsd: 5 } },
  };
}

/** Simulates the non-trivial work a real adapter does to project a config into VerifyInput. */
function buildInput(): VerifyInput {
  const flows = Array.from({ length: 200 }, (_, i) => makeFlow(i));
  return {
    flows,
    grants: { grants: Object.fromEntries(flows.map((f) => [f.id, [`cap.${f.id.split("-")[1]}`]])) },
    placement: {
      targets: ["local", "cloud-run"],
      supportedKinds: { "cloud-run": ["step", "llm"] },
    },
    meteredDimensions: ["tokens", "costUsd", "ms"],
    resumeAuthenticatorWired: true,
    eventSchemaVersion: "1.7.0",
  };
}

describe("verify overhead", () => {
  bench("mode=off (unwired) — must not build input", () => {
    runVerification("off", buildInput);
  });

  const prebuilt = buildInput();
  bench("verify() over 200 flows (all rules)", () => {
    verify(prebuilt);
  });

  bench("mode=warn — build + verify 200 flows", () => {
    runVerification("warn", buildInput, undefined, () => {});
  });
});
