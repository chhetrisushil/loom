import { runSandboxBackendConformance } from "@loom/conformance";
import { QuickJsSandboxBackend } from "./QuickJsSandboxBackend";

// ── ADR 0144 D5 — QuickJS passes the same kit every third-party backend must pass ──
//
// Both modes: the kit proves the composition (effect + backend) a user deploys. Worker mode needs
// the package BUILT (the worker entry is compiled output).

runSandboxBackendConformance(() => new QuickJsSandboxBackend(), { label: "QuickJS in-process" });

runSandboxBackendConformance(() => new QuickJsSandboxBackend({ workers: { count: 1 } }), {
  label: "QuickJS worker pool",
});
