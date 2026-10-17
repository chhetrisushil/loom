import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  type EncryptingSnapshotStore,
  type InMemoryKeyStore,
  shredSubject,
} from "@loom/plugin-crypto";
import { SqliteEventStore, SqliteLeaseStore, SqliteTimerStore } from "@loom/plugin-sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import {
  cancelExecution,
  conclude,
  idempotentExecutionId,
  readJsonInput,
  resumeExecution,
  startExecution,
} from "./lifecycle";
import { loadLoomApp } from "./stores";

// ── The lifecycle verbs act ONLY through the app's own runtime ────────────────────────────────
//
// Every refusal below asserts the LOG: the verbs must be unable to write around the app's
// resume authenticator, execution authorizer, resumeSchemas and leases. The one thing an
// authorizer denial may add is the app's OWN audit fact (`EXECUTION_DENIED`), exactly as when
// the app's code is the caller - never a state change.
//
// The temp modules live INSIDE the package so `import "@loom/app"` resolves through the
// workspace's node_modules. Each load needs a FRESH file: an ES module is cached per path,
// and a cached module hands back an app whose stores were already closed.

const PKG = resolve(__dirname, "..");
const SCRATCH = join(PKG, ".tmp-lifecycle-test");
const MIDDLEWARE = pathToFileURL(resolve(PKG, "../../packages/middleware/dist/index.js")).href;

interface AppOpts {
  /** Register the `count` effect the `div` flow's steps run. Default true. */
  effects?: boolean;
  /** The `div` flow's body: v1 runs A, B and parks on "go"; v2 asks for a step never recorded. */
  body?: "v1" | "v2";
  validateInput?: boolean;
  /** "local" = an in-memory switch (admin API), "shared" = a bare registry. Default none. */
  killSwitch?: "local" | "shared" | "subclass" | "proxy" | "wrapper" | "custom";
  /** Make the runtime's loadState throw (after the app is composed) while globalThis.__lcFailLoad is set. */
  failLoad?: boolean;
  /** "off" = heartbeat disabled; "noget" = a lease store without `get`; "lie" = `get` always says free. */
  heartbeat?: "off" | "noget" | "lie";
  /** Wire a durable timer store; "start" additionally calls app.start() in the module. */
  timers?: "store" | "start";
  /** Fail every append that carries the named event type while globalThis.__lcFail is set. */
  failAppend?: string;
  /** What the query op admits (resume/cancel stay owner-scoped). */
  queryScope?: "tenant" | "any" | "deny";
}

const APP = (dir: string, o: AppOpts = {}): string => `
import { defineConfig } from "@loom/app";
import { flow$, step$ } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { SqliteTimerStore, sqliteStorage } from "@loom/plugin-sqlite";
import { executionAccessPolicy } from "@loom/workflow-runtime";
import { z } from "zod";
const { InMemoryKillSwitch: RealKillSwitch } = await import(${JSON.stringify(MIDDLEWARE)});
const SECRET = "hunter2-secret-value";

const Decision = z.object({ approved: z.boolean(), approvedBy: z.string() });
const approval = {
  definition: flow$({
    id: "approval", name: "approval", version: "1.0.0",
    inputSchema: z.object({ service: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
    steps: [],
    resumeSchemas: { ApprovalGranted: Decision, Mode: z.object({ mode: z.enum(["fast", "slow"]) }) },
  }),
  runner: async (ctx, input) => {
    const d = await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.service });
    return { done: d.approved };
  },
};
const forbidden = {
  definition: flow$({
    id: "forbidden", name: "forbidden", version: "1.0.0",
    inputSchema: z.object({}), outputSchema: z.object({}), steps: [],
  }),
  runner: async () => ({}),
};
const io = { inputSchema: z.any(), outputSchema: z.any() };
const E1 = step$({ id: "E1", name: "E1", toolId: "boom", ...io });
const E2 = step$({ id: "E2", name: "E2", toolId: "zt", ...io });
const boom = {
  definition: flow$({ id: "boom", name: "boom", version: "1.0.0", ...io, steps: [E1] }),
  runner: async (ctx) => { await ctx.run(E1, {}); return {}; },
};
const zerr = {
  definition: flow$({ id: "zerr", name: "zerr", version: "1.0.0", ...io, steps: [E2] }),
  runner: async (ctx) => { await ctx.run(E2, {}); return {}; },
};
const A = step$({ id: "A", name: "A", toolId: "count", ...io });
const B = step$({ id: "B", name: "B", toolId: "count", ...io });
const C = step$({ id: "C", name: "C", toolId: "count", ...io });
const div = {
  definition: flow$({ id: "div", name: "div", version: "1.0.0", ...io, steps: [A, B] }),
  runner: ${
    (o.body ?? "v1") === "v1"
      ? `async (ctx) => {
    await ctx.run(A, { id: "A" });
    await ctx.run(B, { id: "B" });
    await ctx.suspend({ on: "go" });
    return { done: true };
  }`
      : `async (ctx) => {
    await ctx.run(C, { id: "C" });
    return { done: true };
  }`
  },
};

const late = {
  definition: flow$({ id: "late", name: "late", version: "1.0.0", ...io, steps: [A, B] }),
  runner: async (ctx) => {
    await ctx.run(A, { id: "A" });
    await ctx.suspend({ on: "go" });
    await ctx.run(B, { id: "B" });
    return { done: true };
  },
};

class InMemoryKillSwitch { check() { return undefined; } stopTenant() {} status() { return {}; } }
const APPROVERS = new Set(["alice"]);

const storage = sqliteStorage({ dir: ${JSON.stringify(dir)} });
${
  o.failAppend !== undefined
    ? `{
  const real = storage.eventStore;
  const hits = (a) => JSON.stringify(a).includes(${JSON.stringify(`"${o.failAppend}"`)});
  storage.eventStore = new Proxy(real, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== "function") return v;
      if ((p === "append" || p === "appendMany") && globalThis.__lcFail === true) {
        return (...a) => hits(a) ? Promise.reject(new Error("disk full (simulated)")) : v.apply(t, a);
      }
      return v.bind(t);
    },
  });
}`
    : ""
}
${
  o.heartbeat === "noget" || o.heartbeat === "lie"
    ? `const realLeases = storage.leaseStore;
const leaseStore = new Proxy(realLeases, {
  get(t, p) {
    if (p === "get") return ${o.heartbeat === "lie" ? "async () => null" : "undefined"};
    const v = t[p];
    return typeof v === "function" ? v.bind(t) : v;
  },
});`
    : ""
}

const app = defineConfig({
  storage,
  flows: [approval, forbidden, div, late, boom, zerr],
  ${o.timers !== undefined ? `timers: { pollMs: 5, store: new SqliteTimerStore(${JSON.stringify(`${dir}/events.db`)}) },` : ""}
  ${o.heartbeat === "off" ? "durability: { heartbeat: { enabled: false } }," : ""}
  ${o.heartbeat === "noget" || o.heartbeat === "lie" ? "durability: { heartbeat: { store: leaseStore } }," : ""}
  execution: {
    registerEffects: (fx) => {
      ${(o.effects ?? true) ? `fx.register("count", new ToolEffect(async (i) => i));` : ""}
      fx.register("boom", new ToolEffect(async () => { throw new Error("db password " + SECRET); }));
      fx.register("zt", new ToolEffect(async () => z.enum(["x"]).parse(SECRET)));
    },
    ${o.validateInput === true ? "validateInput: true," : ""}
  },
  kernel: { divergence: "fail" },
  security: {
    ${o.killSwitch === "local" ? "killSwitch: new InMemoryKillSwitch()," : ""}
    ${o.killSwitch === "shared" ? 'killSwitch: { scope: "shared", check() { return undefined; } },' : ""}
    ${o.killSwitch === "custom" ? "killSwitch: { check() { return undefined; } }," : ""}
    ${o.killSwitch === "subclass" ? "killSwitch: new (class extends RealKillSwitch {})()," : ""}
    ${o.killSwitch === "proxy" ? "killSwitch: new Proxy(new RealKillSwitch(), { get(t, p) { const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } })," : ""}
    ${o.killSwitch === "wrapper" ? 'killSwitch: (() => { const inner = { scope: "shared", check() { return undefined; } }; return { check: (c) => inner.check(c) }; })(),' : ""}
    resumeAuthenticator: {
      verify(event) {
        if (event.eventType !== "ApprovalGranted") return { status: "not-applicable" };
        const by = event.payload && event.payload.approvedBy;
        return typeof by === "string" && APPROVERS.has(by)
          ? { status: "verified", actor: by, verifiedBy: "test" }
          : { status: "rejected", reason: "not an approver" };
      },
    },
    executionAuthorizer: executionAccessPolicy({
      allowWorkflows: ["approval", "div", "late", "boom", "zerr"],
      rules: { resume: "owner", cancel: "owner", query: ${JSON.stringify(o.queryScope ?? "tenant")} },
    }),
  },
});
${
  o.failLoad === true
    ? `{
  const realLoad = app.runtime.loadState.bind(app.runtime);
  app.runtime.loadState = async (...a) => {
    if (globalThis.__lcFailLoad === true) throw new Error("disk read failed (simulated)");
    return realLoad(...a);
  };
}`
    : ""
}
${o.timers === "start" ? "app.start();" : ""}
export default app;
`;

interface Shred {
  inner: InMemoryAsyncEventStore;
  keys: InMemoryKeyStore;
  snaps: EncryptingSnapshotStore;
}

/** An app over ENCRYPTING in-memory stores kept on globalThis, so a test can shred between loads. */
const SHRED_APP = `
import { defineConfig } from "@loom/app";
import { flow$, step$ } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, EncryptingSnapshotStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { executionAccessPolicy } from "@loom/workflow-runtime";
import { z } from "zod";

const g = (globalThis.__lcShred ??= (() => {
  const inner = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const events = new EncryptingEventStore(inner, keys, { sensitive: { STEP_COMPLETED: ["output"] } });
  const snaps = new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, { sealState: true, events: inner });
  // The app closes its stores on exit; these must outlive each load (an in-memory close clears them).
  events.close = async () => {};
  snaps.close = async () => {};
  return { inner, keys, events, snaps };
})());
const io = { inputSchema: z.any(), outputSchema: z.any() };
const echo = step$({ id: "echo", name: "echo", toolId: "echo", ...io });
const shredMe = {
  definition: flow$({ id: "shred-me", name: "shred-me", version: "1.0.0", ...io, steps: [echo] }),
  runner: async (ctx) => {
    await ctx.run(echo, { ssn: "123-45-6789" });
    await ctx.suspend({ on: "Go" });
    return null;
  },
};
export default defineConfig({
  storage: { kind: "custom", eventStore: g.events, snapshotStore: g.snaps },
  flows: [shredMe],
  durability: { snapshotEvery: 1 },
  execution: { registerEffects: (fx) => fx.register("echo", new ToolEffect(async (i) => i)) },
  security: {
    executionAuthorizer: executionAccessPolicy({ rules: { cancel: "owner", query: "tenant" }, resolveOwner: () => ({ actor: "starter", tenant: "acme" }) }),
  },
});
`;

let dir = "";
let n = 0;
const OWNER = ["--as", "starter", "--tenant", "acme"];

/** A fresh copy of the app module over the same storage dir (see the header). */
function cfg(o: AppOpts = {}): string {
  const file = join(SCRATCH, `app-${n++}.mjs`);
  writeFileSync(file, APP(dir, o));
  return file;
}

/** Start `approval` as the owner and leave it parked on its gate. */
async function seedParked(id: string): Promise<void> {
  const app = await loadLoomApp(cfg());
  try {
    const h = await app.runtime?.start(
      "approval",
      { service: "s1" },
      { executionId: id, principal: { actor: "starter", tenant: "acme" } }
    );
    await h?.waitForSuspend();
  } finally {
    await app.close?.();
  }
}

/** Start the `div` flow (steps A, B, then a park on "go") as the owner. */
async function seedDiv(id: string): Promise<void> {
  const app = await loadLoomApp(cfg({ body: "v1" }));
  try {
    const h = await app.runtime?.start(
      "div",
      {},
      { executionId: id, principal: { actor: "starter", tenant: "acme" } }
    );
    await h?.waitForSuspend();
  } finally {
    await app.close?.();
  }
}

/** Start `late` (step A, a park on "go", then step B) as the owner. */
async function seedLate(id: string): Promise<void> {
  const app = await loadLoomApp(cfg());
  try {
    const h = await app.runtime?.start(
      "late",
      {},
      { executionId: id, principal: { actor: "starter", tenant: "acme" } }
    );
    await h?.waitForSuspend();
  } finally {
    await app.close?.();
  }
}

async function events(id: string): Promise<string[]> {
  const store = new SqliteEventStore(join(dir, "events.db"));
  try {
    return (await store.read(id)).map((e) => e.eventType);
  } finally {
    await store.close();
  }
}

const OK = { approved: true, approvedBy: "alice" };

function resume(id: string, over: Record<string, unknown> = {}, app: AppOpts = {}) {
  return resumeExecution({
    config: cfg(app),
    as: "starter",
    tenant: "acme",
    apply: false,
    redact: [],
    executionId: id,
    event: "ApprovalGranted",
    payload: OK,
    payloadFromFile: false,
    ...over,
  });
}
function cancel(id: string, over: Record<string, unknown> = {}, app: AppOpts = {}) {
  return cancelExecution({
    config: cfg(app),
    as: "starter",
    tenant: "acme",
    apply: false,
    redact: [],
    executionId: id,
    ...over,
  });
}
function start(over: Record<string, unknown> = {}, app: AppOpts = {}) {
  return startExecution({
    config: cfg(app),
    as: "starter",
    tenant: "acme",
    apply: false,
    redact: [],
    flowId: "approval",
    input: { service: "s2" },
    inputFromFile: false,
    ...over,
  });
}

describe("loom resume / cancel / start", () => {
  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, "store-"));
  });
  afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

  describe("resume", () => {
    it("a dry run reports the gate and the parsed (stripped) payload, and changes nothing", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const res = await resume("e1", { payload: { ...OK, note: "hi" } });
      expect(res.exitCode).toBe(0);
      expect(res.dryRun).toBe(true);
      expect(res.before).toMatchObject({ status: "suspended", waitingOn: "ApprovalGranted" });
      const text = res.lines.join("\n");
      expect(text).toContain("STRIPS these keys");
      expect(text).toContain("note");
      expect(text).toContain("IN THIS PROCESS");
      expect(text).toContain("configured; verifies on --apply");
      // The shown payload is the PARSED value: the stripped key is not in it.
      expect(text).toContain('"approvedBy":"alice"');
      expect(text).not.toContain('"note"');
      expect(await events("e1")).toEqual(before);
    });

    it("--redact masks the shown payload, and a payload-file stays hidden without --show-payload", async () => {
      await seedParked("e1");
      const masked = await resume("e1", { redact: ["approvedBy"] });
      expect(masked.lines.join("\n")).not.toContain("alice");
      const hidden = await resume("e1", { payloadFromFile: true });
      expect(hidden.lines.join("\n")).toContain("not shown");
      expect(hidden.lines.join("\n")).not.toContain("alice");
      const shown = await resume("e1", { payloadFromFile: true, showPayload: true });
      expect(shown.lines.join("\n")).toContain("alice");
    });

    it("--apply resumes when the app's authenticator verifies, and records the approval", async () => {
      await seedParked("e1");
      const res = await resume("e1", { apply: true });
      expect(res.exitCode).toBe(0);
      expect(res.after?.status).toBe("completed");
      const types = await events("e1");
      expect(types).toContain("APPROVAL_GRANTED");
      expect(types.at(-1)).toBe("EXECUTION_COMPLETED");
    });

    it("an approver the authenticator rejects is refused (exit 2) and the log is untouched", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const res = await resume("e1", {
        apply: true,
        payload: { approved: true, approvedBy: "eve" },
      });
      expect(res.exitCode).toBe(2);
      expect(res.refusal).toContain("approval not verified");
      expect(await events("e1")).toEqual(before);
    });

    it("a payload failing resumeSchemas is refused in the dry run and on --apply, log untouched", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const bad = { approved: "yes", approvedBy: "alice" };
      const dry = await resume("e1", { payload: bad });
      expect(dry.exitCode).toBe(2);
      expect(dry.refusal).toContain("resumeSchemas");
      const applied = await resume("e1", { payload: bad, apply: true });
      expect(applied.exitCode).toBe(2);
      expect(applied.refusal).toContain("ResumePayloadValidationError");
      expect(await events("e1")).toEqual(before);
    });

    it("refuses a non-suspended execution, an unknown one, and the wrong event type", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const wrong = await resume("e1", { event: "Bogus", apply: true });
      expect(wrong.exitCode).toBe(2);
      expect(await resume("e1", { event: "Bogus" })).toMatchObject({ exitCode: 2 });
      expect(await events("e1")).toEqual(before);

      expect((await resume("nope", { apply: true })).exitCode).toBe(2);

      await resume("e1", { apply: true });
      const done = await events("e1");
      const again = await resume("e1", { apply: true });
      expect(again.exitCode).toBe(2);
      expect(again.refusal).toContain("not suspended");
      expect(await events("e1")).toEqual(done);
    });

    it("the app's authorizer is consulted for --as: a tenant mismatch and a non-owner are refused", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const tenant = await resume("e1", { apply: true, tenant: "evil" });
      expect(tenant.exitCode).toBe(2);
      expect(await events("e1")).toEqual(before);

      // Same tenant, so the query gate lets it look; the RESUME gate (owner-only) refuses.
      const other = await resume("e1", { apply: true, as: "mallory" });
      expect(other.exitCode).toBe(2);
      expect(other.refusal).toContain("ExecutionDeniedError");
      const after = await events("e1");
      // At most the app's own audit fact; never a state change.
      expect(after.filter((t) => t !== "EXECUTION_DENIED")).toEqual(before);
      expect(after).not.toContain("APPROVAL_GRANTED");
    });

    it("a live foreign lease refuses the resume, log unchanged", async () => {
      await seedParked("e1");
      const leases = new SqliteLeaseStore(join(dir, "events.db"));
      await leases.acquire("e1", "worker-9", 60_000);
      const before = await events("e1");
      const res = await resume("e1", { apply: true });
      expect(res.exitCode).toBe(2);
      expect(res.refusal).toContain("worker-9");
      expect((await resume("e1")).exitCode).toBe(2); // the dry run says so too
      expect(await events("e1")).toEqual(before);
      await leases.close();
    });

    it("never starts the app's timers: a due timer row is left unfired and the service is not running", async () => {
      await seedParked("e1");
      const timers = new SqliteTimerStore(join(dir, "events.db"));
      await timers.schedule({ executionId: "ghost", wakeAt: 1 });
      const loaded = await loadLoomApp(cfg({ timers: "store" }));
      try {
        expect(loaded.timerService).toBeDefined();
        expect(loaded.timerService?.running).toBe(false);
      } finally {
        await loaded.close?.();
      }
      const res = await resume("e1", { apply: true }, { timers: "store" });
      expect(res.exitCode).toBe(0);
      expect(process.env.LOOM_NO_AUTOSTART).toBe("1");
      expect((await timers.due(Date.now())).map((t) => t.executionId)).toContain("ghost");
      await timers.close();
    });

    it("a --config module that starts the timer service itself is refused (warning on stderr), log unchanged", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const applied = await resume("e1", { apply: true }, { timers: "start" });
      const dry = await resume("e1", {}, { timers: "start" });
      const shown = err.mock.calls.flat().join("\n");
      err.mockRestore();
      expect(applied.exitCode).toBe(2);
      expect(applied.refusal).toContain("timer service is RUNNING");
      expect(dry.exitCode).toBe(2);
      expect(shown).toContain("warning");
      expect(await events("e1")).toEqual(before);
    });

    it("refuses --apply when a not-yet-completed declared step needs an unregistered effect; --skip-effect-check overrides", async () => {
      await seedLate("l1");
      const before = await events("l1");
      const over = { event: "go", payload: {} };
      const dry = await resume("l1", over, { effects: false });
      expect(dry.exitCode).toBe(2);
      expect(dry.refusal).toContain("count");
      expect(dry.refusal).toContain("--skip-effect-check");
      const applied = await resume("l1", { ...over, apply: true }, { effects: false });
      expect(applied.exitCode).toBe(2);
      expect(applied.refusal).toContain("not yet run that this app has not registered: count");
      expect(await events("l1")).toEqual(before);
      // The override is explicit and printed; the missing handler then fails the run (exit 1).
      const skipDry = await resume("l1", { ...over, skipEffectCheck: true }, { effects: false });
      expect(skipDry.exitCode).toBe(0);
      expect(skipDry.lines.join("\n")).toContain("--skip-effect-check");
      const skipped = await resume(
        "l1",
        { ...over, apply: true, skipEffectCheck: true },
        { effects: false }
      );
      expect(skipped.exitCode).toBe(1);
      // With the effect registered the same resume is accepted.
      await seedLate("l2");
      const ok = await resume("l2", { ...over, apply: true });
      expect(ok.exitCode).toBe(0);
      expect(ok.after?.status).toBe("completed");
    });

    it("steps already completed in this execution are not preflighted (a missing handler for them is fine)", async () => {
      await seedDiv("d1"); // A and B completed, parked on "go"
      const res = await resume("d1", { event: "go", payload: {}, apply: true }, { effects: false });
      expect(res.exitCode).toBe(0);
      expect(res.after?.status).toBe("completed");
    });

    it("an execution pinned to a different flow version is not checked against the current one's steps (and says so)", async () => {
      await seedDiv("d1");
      // Same id and version, but a third declared step: a different content hash than d1 recorded.
      const file = cfg({ effects: false });
      const src = (await import("node:fs")).readFileSync(file, "utf8");
      writeFileSync(
        file,
        src.replace(
          'definition: flow$({ id: "div", name: "div", version: "1.0.0", ...io, steps: [A, B] })',
          'definition: flow$({ id: "div", name: "div", version: "1.0.0", ...io, steps: [A, B, C] })'
        )
      );
      const dry = await resumeExecution({
        config: file,
        as: "starter",
        tenant: "acme",
        apply: false,
        redact: [],
        executionId: "d1",
        event: "go",
        payload: {},
        payloadFromFile: false,
      });
      expect(dry.exitCode).toBe(0);
      expect(dry.lines.join("\n")).toContain("pinned to a different flow version");
    });

    it("a process-local kill switch refuses --apply unless --allow-local-controls (log unchanged); a shared registry needs no flag", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const dry = await resume("e1", {}, { killSwitch: "local" });
      expect(dry.exitCode).toBe(0);
      expect(dry.lines.join("\n")).toContain(
        "kill switch / budgets / rate limits are process-local: a stop issued in the running app does NOT apply here"
      );
      expect(dry.lines.join("\n")).toContain("--allow-local-controls");
      const refused = await resume("e1", { apply: true }, { killSwitch: "local" });
      expect(refused.exitCode).toBe(2);
      expect(refused.refusal).toContain("--allow-local-controls");
      expect(await events("e1")).toEqual(before);
      const shared = await resume("e1", {}, { killSwitch: "shared" });
      expect(shared.lines.join("\n")).toContain("shared registry");
      expect(shared.lines.join("\n")).not.toContain("--allow-local-controls");
      const allowed = await resume(
        "e1",
        { apply: true, allowLocalControls: true },
        { killSwitch: "local" }
      );
      expect(allowed.exitCode).toBe(0);
      expect(allowed.after?.status).toBe("completed");
    });

    it("FAIL-CLOSED: a subclass, a proxy, a wrapper and a bare {check} registry are all process-local (refused without the flag, log unchanged)", async () => {
      await seedParked("e1");
      const before = await events("e1");
      for (const killSwitch of ["subclass", "proxy", "wrapper", "custom"] as const) {
        const dry = await resume("e1", {}, { killSwitch });
        expect(dry.lines.join("\n"), killSwitch).toContain("process-local");
        const refused = await resume("e1", { apply: true }, { killSwitch });
        expect(refused.exitCode, killSwitch).toBe(2);
        expect(refused.refusal, killSwitch).toContain("--allow-local-controls");
        expect(await events("e1"), killSwitch).toEqual(before);
        const started = await start({ id: `k-${killSwitch}`, apply: true }, { killSwitch });
        expect(started.exitCode, killSwitch).toBe(2);
        expect(await events(`k-${killSwitch}`), killSwitch).toEqual([]);
      }
    });

    it("a shared kill switch resumes with no flag", async () => {
      await seedParked("e1");
      const res = await resume("e1", { apply: true }, { killSwitch: "shared" });
      expect(res.exitCode).toBe(0);
    });

    it("unknown lease liveness is not 'none live': resume --apply needs --force (lease store without get / heartbeat off)", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const dry = await resume("e1", {}, { heartbeat: "noget" });
      expect(dry.lines.join("\n")).toContain("unknown (lease store not readable)");
      expect(dry.lines.join("\n")).not.toContain("none live");
      const refused = await resume("e1", { apply: true }, { heartbeat: "noget" });
      expect(refused.exitCode).toBe(2);
      expect(refused.refusal).toContain("--force");
      expect(await events("e1")).toEqual(before);

      const off = await resume("e1", {}, { heartbeat: "off" });
      expect(off.lines.join("\n")).toContain("heartbeat leases off — liveness unknown");
      expect((await resume("e1", { apply: true }, { heartbeat: "off" })).exitCode).toBe(2);
      expect(await events("e1")).toEqual(before);

      const forced = await resume("e1", { apply: true, force: true }, { heartbeat: "noget" });
      expect(forced.exitCode).toBe(0);
    });

    it("a lease taken between the CLI's check and the runtime's (LeaseHeldError) is a refusal (exit 2), not a success", async () => {
      await seedParked("e1");
      const leases = new SqliteLeaseStore(join(dir, "events.db"));
      await leases.acquire("e1", "worker-9", 60_000);
      const before = await events("e1");
      // `lie`: the CLI's liveness read says "free" (as if the holder arrived a moment later).
      const res = await resume("e1", { apply: true }, { heartbeat: "lie" });
      expect(res.exitCode).toBe(2);
      expect(res.refusal).toMatch(/LeaseHeldError|worker-9|lease/i);
      expect(await events("e1")).toEqual(before);
      await leases.close();
    });

    it("tenant mismatch that the QUERY authorizer admits is still refused at the resume gate", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const res = await resume("e1", { apply: true, tenant: "evil" }, { queryScope: "any" });
      expect(res.exitCode).toBe(2);
      expect(res.refusal).toContain("ExecutionDeniedError");
      const after = await events("e1");
      expect(after.filter((t) => t !== "EXECUTION_DENIED")).toEqual(before);
    });

    it("a runtime failure is exit 1, never 'resumed' exit 0: a diverged flow body (the runtime parks it on the reserved gate)", async () => {
      await seedDiv("d1");
      const res = await resume("d1", { event: "go", payload: {}, apply: true }, { body: "v2" });
      expect(res.exitCode).toBe(1);
      expect(res.ok).toBe(false);
      expect(res.failure).toContain("diverged");
    });

    it("a storage failure while the resumed run commits is exit 1 with the cause", async () => {
      await seedParked("e1");
      (globalThis as { __lcFail?: boolean }).__lcFail = true;
      try {
        const res = await resume("e1", { apply: true }, { failAppend: "EXECUTION_COMPLETED" });
        expect(res.exitCode).toBe(1);
        expect(res.ok).toBe(false);
        expect(res.failure).not.toContain("disk full"); // a storage error's message is withheld too
        expect(res.failure).toContain("StorageWriteError");
        (globalThis as { __lcFail?: boolean }).__lcFail = false;
        await seedParked("e2");
        (globalThis as { __lcFail?: boolean }).__lcFail = true;
        const shown = await resume(
          "e2",
          { apply: true, showPayload: true },
          { failAppend: "EXECUTION_COMPLETED" }
        );
        expect(shown.failure).toContain("disk full");
      } finally {
        (globalThis as { __lcFail?: boolean }).__lcFail = false;
      }
    });

    it("egress: a rejected payload never prints the value (path + code only) unless --show-payload", async () => {
      await seedParked("e1");
      const secret = "hunter2-secret";
      const dry = await resume("e1", { event: "Mode", payload: { mode: secret } });
      expect(dry.exitCode).toBe(2);
      expect(dry.refusal).toContain("mode");
      expect(dry.refusal).not.toContain(secret);
      const applied = await resume("e1", {
        apply: true,
        payload: { approved: secret, approvedBy: "alice" },
      });
      expect(applied.exitCode).toBe(2);
      expect(applied.refusal).toContain("ResumePayloadValidationError");
      expect(applied.refusal).not.toContain(secret);
      const dryApprove = await resume("e1", { payload: { approved: secret, approvedBy: "alice" } });
      expect(dryApprove.refusal).not.toContain(secret);
    });
  });

  describe("cancel", () => {
    it("dry run changes nothing; --apply cancels; a terminal execution is refused", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const dry = await cancel("e1");
      expect(dry.exitCode).toBe(0);
      expect(dry.lines.join("\n")).toContain("runs nothing in this process");
      expect(await events("e1")).toEqual(before);

      const done = await cancel("e1", { apply: true, reason: "no longer needed" });
      expect(done.exitCode).toBe(0);
      expect(done.after?.status).toBe("cancelled");
      expect((await events("e1")).at(-1)).toBe("EXECUTION_CANCELLED");

      const again = await cancel("e1", { apply: true });
      expect(again.exitCode).toBe(2);
      expect(again.refusal).toContain("terminal");
      expect((await cancel("nope", { apply: true })).exitCode).toBe(2);
    });

    it("the authorizer refuses a non-owner; nothing is cancelled", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const res = await cancel("e1", { apply: true, as: "mallory" });
      expect(res.exitCode).toBe(2);
      expect(res.refusal).toContain("ExecutionDeniedError");
      const after = await events("e1");
      expect(after).not.toContain("EXECUTION_CANCELLED");
      expect(after.filter((t) => t !== "EXECUTION_DENIED")).toEqual(before);
      expect((await cancel("e1", { apply: true, tenant: "evil" })).exitCode).toBe(2);
    });

    it("a live foreign lease refuses the cancel unless --force", async () => {
      await seedParked("e1");
      const leases = new SqliteLeaseStore(join(dir, "events.db"));
      await leases.acquire("e1", "worker-9", 60_000);
      const before = await events("e1");
      const refused = await cancel("e1", { apply: true });
      expect(refused.exitCode).toBe(2);
      expect(refused.refusal).toContain("--force");
      expect(await events("e1")).toEqual(before);
      const forced = await cancel("e1", { apply: true, force: true });
      expect(forced.exitCode).toBe(0);
      expect(forced.after?.status).toBe("cancelled");
      await leases.close();
    });

    it("cancel is exempt from --allow-local-controls (it runs no effects); unknown liveness needs --force", async () => {
      await seedParked("e1");
      const unknown = await cancel("e1", { apply: true }, { heartbeat: "noget" });
      expect(unknown.exitCode).toBe(2);
      expect(unknown.refusal).toContain("--force");
      expect(unknown.lines.join("\n")).toContain("unknown (lease store not readable)");
      expect((await events("e1")).at(-1)).not.toBe("EXECUTION_CANCELLED");
      const off = await cancel("e1", { apply: true }, { heartbeat: "off" });
      expect(off.exitCode).toBe(2);
      expect(off.lines.join("\n")).toContain("heartbeat leases off — liveness unknown");
      const done = await cancel("e1", { apply: true, force: true }, { killSwitch: "local" });
      expect(done.exitCode).toBe(0);
      expect(done.after?.status).toBe("cancelled");
    });

    it("tenant mismatch that the QUERY authorizer admits is still refused at the cancel gate", async () => {
      await seedParked("e1");
      const before = await events("e1");
      const res = await cancel("e1", { apply: true, tenant: "evil" }, { queryScope: "any" });
      expect(res.exitCode).toBe(2);
      expect(res.refusal).toContain("ExecutionDeniedError");
      const after = await events("e1");
      expect(after).not.toContain("EXECUTION_CANCELLED");
      expect(after.filter((t) => t !== "EXECUTION_DENIED")).toEqual(before);
    });

    it("cancels a crypto-shredded parked execution (the pre-read throws PayloadShreddedError; the runtime's cancel still works)", async () => {
      const mod = join(SCRATCH, `shred-${n++}.mjs`);
      writeFileSync(mod, SHRED_APP);
      const g = (globalThis as unknown as { __lcShred?: Shred }).__lcShred;
      expect(g).toBeUndefined();
      const app = await loadLoomApp(mod);
      try {
        const h = await app.runtime?.start(
          "shred-me",
          {},
          { executionId: "x", principal: { actor: "starter", tenant: "acme" } }
        );
        await h?.waitForSuspend();
      } finally {
        await app.close?.();
      }
      const shared = (globalThis as unknown as { __lcShred: Shred }).__lcShred;
      await shredSubject(shared.keys, shared.inner, "x", { snapshotStore: shared.snaps });

      const mod2 = join(SCRATCH, `shred-${n++}.mjs`);
      writeFileSync(mod2, SHRED_APP);
      const dry = await cancelExecution({
        config: mod2,
        as: "starter",
        tenant: "acme",
        apply: false,
        force: true,
        redact: [],
        executionId: "x",
      });
      expect(dry.refusal).toBeUndefined();
      expect(dry.lines.join("\n")).toContain("state not shown");
      expect(dry.lines.join("\n")).not.toMatch(/shred|erased|unreadable/i);
      const res = await cancelExecution({
        config: mod2,
        as: "starter",
        tenant: "acme",
        apply: true,
        force: true,
        redact: [],
        executionId: "x",
      });
      expect(res.exitCode).toBe(0);
      expect(res.lines.join("\n")).toContain("cancelled");
      expect(res.lines.join("\n")).toContain("the state was unreadable");
      const types = (await shared.inner.read("x")).map((e: { eventType: string }) => e.eventType);
      expect(types.at(-1)).toBe("EXECUTION_CANCELLED");
      Reflect.deleteProperty(globalThis, "__lcShred");
    });
  });

  describe("cancel: no shred-status oracle", () => {
    it("a wrong-tenant dry run prints the same thing for a shredded execution and a denied read; the mention comes only after --apply succeeds", async () => {
      // A shredded execution "x" (encrypting in-memory stores kept on globalThis).
      const mod = join(SCRATCH, `shred-${n++}.mjs`);
      writeFileSync(mod, SHRED_APP);
      const app = await loadLoomApp(mod);
      try {
        const h = await app.runtime?.start(
          "shred-me",
          {},
          { executionId: "x", principal: { actor: "starter", tenant: "acme" } }
        );
        await h?.waitForSuspend();
      } finally {
        await app.close?.();
      }
      const g = (globalThis as unknown as { __lcShred: Shred }).__lcShred;
      await shredSubject(g.keys, g.inner, "x", { snapshotStore: g.snaps });
      const mod2 = join(SCRATCH, `shred-${n++}.mjs`);
      writeFileSync(mod2, SHRED_APP);
      const wrong = { as: "mallory", tenant: "evil", apply: false, redact: [], executionId: "x" };
      const shreddedDry = await cancelExecution({ config: mod2, ...wrong });

      // The same wrong-tenant principal against an ordinary execution whose read is DENIED.
      await seedParked("x");
      const deniedDry = await cancel("x", { as: "mallory", tenant: "evil" });

      expect(shreddedDry.lines).toEqual(deniedDry.lines);
      expect(shreddedDry.exitCode).toBe(deniedDry.exitCode);
      expect(shreddedDry.refusal).toEqual(deniedDry.refusal);
      expect(shreddedDry.lines.join("\n")).toContain("state not shown");
      expect(JSON.stringify(shreddedDry)).not.toMatch(/shred|erased|unreadable/i);

      // --apply by the wrong tenant: the runtime's cancel authorizes first and refuses; no mention.
      const wrongApply = await cancelExecution({
        config: mod2,
        ...wrong,
        apply: true,
        force: true,
      });
      expect(wrongApply.exitCode).toBe(2);
      expect(JSON.stringify(wrongApply)).not.toMatch(/shred|erased|unreadable/i);
      Reflect.deleteProperty(globalThis, "__lcShred");
    });
  });

  describe("start", () => {
    it("a dry run validates the input and starts nothing; --apply starts and parks", async () => {
      const bad = await start({ input: { service: 7 } }, { validateInput: true });
      expect(bad.exitCode).toBe(2);
      expect(bad.refusal).toContain("input schema");

      const dry = await start({ id: "s-1" });
      expect(dry.exitCode).toBe(0);
      expect(dry.lines.join("\n")).toContain("IN THIS PROCESS");
      expect(await events("s-1")).toEqual([]);

      const res = await start({ id: "s-1", apply: true });
      expect(res.exitCode).toBe(0);
      expect(res.after).toMatchObject({ status: "suspended", waitingOn: "ApprovalGranted" });

      const dup = await start({ id: "s-1", apply: true });
      expect(dup.exitCode).toBe(2);
      expect(dup.refusal).toContain("already exists");
    });

    it("an --idempotency-key derives a stable id, so a repeat start is refused", async () => {
      const id = idempotentExecutionId("approval", "k1", "acme");
      expect(id).toBe(idempotentExecutionId("approval", "k1", "acme"));
      expect(id).not.toBe(idempotentExecutionId("approval", "k2", "acme"));
      const first = await start({ idempotencyKey: "k1", apply: true });
      expect(first.executionId).toBe(id);
      expect(first.exitCode).toBe(0);
      expect((await start({ idempotencyKey: "k1", apply: true })).exitCode).toBe(2);
    });

    it("the authorizer refuses a flow the principal may not start; an unknown flow is refused", async () => {
      const denied = await start({ flowId: "forbidden", input: {}, id: "f-1", apply: true });
      expect(denied.exitCode).toBe(2);
      expect(denied.refusal).toContain("ExecutionDeniedError");
      expect(await events("f-1")).toEqual([]);
      expect((await start({ flowId: "nope" })).exitCode).toBe(2);
    });

    it("the idempotency id is scoped to the tenant: one key, two tenants, two executions", async () => {
      expect(idempotentExecutionId("approval", "k1", "acme")).not.toBe(
        idempotentExecutionId("approval", "k1", "other")
      );
      expect(idempotentExecutionId("approval", "k1", "acme")).not.toBe(
        idempotentExecutionId("approval", "k1")
      );
      // length-prefixed: shifting a delimiter between fields cannot collide
      expect(idempotentExecutionId("a", "b|c", "t")).not.toBe(
        idempotentExecutionId("a|b", "c", "t")
      );
      const one = await start({ idempotencyKey: "shared-key", apply: true });
      const two = await start({ idempotencyKey: "shared-key", apply: true, tenant: "other" });
      expect(one.exitCode).toBe(0);
      expect(two.exitCode).toBe(0);
      expect(one.executionId).not.toBe(two.executionId);
      expect((await start({ idempotencyKey: "shared-key", apply: true })).exitCode).toBe(2);
    });

    it("shows the raw input, and says so when the schema is not enforced by the app", async () => {
      const dry = await start({ input: { service: "s2", extra: "kept" } });
      const text = dry.lines.join("\n");
      expect(text).toContain("schema not enforced by the app");
      expect(text).toContain('"extra":"kept"');
      const enforced = await start({ input: { service: "s2" } }, { validateInput: true });
      expect(enforced.lines.join("\n")).toContain("enforced by the app");
    });

    it("on --apply the runtime's authorizer runs BEFORE input validation: a denied principal learns nothing of the schema", async () => {
      const denied = await start(
        { flowId: "forbidden", input: "not-an-object-secret-9", id: "f-2", apply: true },
        { validateInput: true }
      );
      expect(denied.exitCode).toBe(2);
      expect(denied.refusal).toContain("ExecutionDeniedError");
      expect(denied.refusal).not.toContain("input schema");
      expect(await events("f-2")).toEqual([]);
    });

    it("egress: a schema failure never prints the received value unless --show-payload", async () => {
      const secret = "hunter2-secret";
      const dry = await start({ input: { service: { v: secret } } }, { validateInput: true });
      expect(dry.exitCode).toBe(2);
      expect(dry.refusal).not.toContain(secret);
      const applied = await start(
        { input: { service: { v: secret } }, id: "bad-1", apply: true },
        { validateInput: true }
      );
      expect(applied.exitCode).toBe(2);
      expect(applied.refusal).toContain("InputValidationError");
      expect(applied.refusal).not.toContain(secret);
    });

    it("a process-local kill switch refuses start --apply unless --allow-local-controls", async () => {
      const refused = await start({ id: "k-1", apply: true }, { killSwitch: "local" });
      expect(refused.exitCode).toBe(2);
      expect(refused.refusal).toContain("--allow-local-controls");
      expect(await events("k-1")).toEqual([]);
      const ok = await start(
        { id: "k-1", apply: true, allowLocalControls: true },
        { killSwitch: "local" }
      );
      expect(ok.exitCode).toBe(0);
      expect((await start({ id: "k-2", apply: true }, { killSwitch: "shared" })).exitCode).toBe(0);
    });
  });

  describe("the front door", () => {
    it("--db and the other store shorthands are refused (exit 2) before anything is opened", async () => {
      await seedParked("e1");
      const before = await events("e1");
      for (const verb of [
        ["resume", "e1", "--event", "ApprovalGranted", "--payload", JSON.stringify(OK)],
        ["cancel", "e1"],
        ["start", "approval", "--input", "{}"],
      ]) {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const code = await run([...verb, "--db", join(dir, "events.db"), ...OWNER, "--apply"]);
        const shown = err.mock.calls.flat().join("\n");
        err.mockRestore();
        expect(code).toBe(2);
        expect(shown).toContain("--db is refused");
      }
      expect(await events("e1")).toEqual(before);
    });

    it("a missing --config, --as, --event or a bad JSON payload is a usage error (exit 2)", async () => {
      const cases: string[][] = [
        ["resume", "e1", "--event", "E", "--payload", "{}", ...OWNER],
        ["resume", "e1", "--config", cfg(), "--event", "E", "--payload", "{}"],
        ["resume", "e1", "--config", cfg(), ...OWNER, "--payload", "{}"],
        ["resume", "e1", "--config", cfg(), "--event", "E", "--payload", "{not json", ...OWNER],
        ["cancel", "e1", "--config", cfg()],
      ];
      for (const argv of cases) {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await run(argv)).toBe(2);
        err.mockRestore();
      }
    });

    it("a JSON parse error never echoes the (possibly secret) text", () => {
      expect(() => readJsonInput("payload", "{token: hunter2-secret", undefined, true)).toThrow(
        /not valid JSON/
      );
      try {
        readJsonInput("payload", "{token: hunter2-secret", undefined, true);
      } catch (e) {
        expect((e as Error).message).not.toContain("hunter2");
      }
    });

    it("--json emits {ok, action, dryRun, executionId, before, after?, refusal?} on stdout only", async () => {
      await seedParked("e1");
      const lines: string[] = [];
      const log = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
        lines.push(String(c));
        return true;
      });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const argv = (payload: unknown, ...more: string[]) => [
        "resume",
        "e1",
        "--config",
        cfg(),
        ...OWNER,
        "--event",
        "ApprovalGranted",
        "--payload",
        JSON.stringify(payload),
        ...more,
        "--json",
      ];
      const dryCode = await run(argv(OK));
      const dry = JSON.parse(lines.join("\n"));
      lines.length = 0;
      const bad = await run(argv({ approved: true, approvedBy: "eve" }, "--apply"));
      const refused = JSON.parse(lines.join("\n"));
      log.mockRestore();
      err.mockRestore();
      expect(dryCode).toBe(0);
      expect(dry).toMatchObject({ ok: true, action: "resume", dryRun: true, executionId: "e1" });
      expect(dry.before.status).toBe("suspended");
      expect(bad).toBe(2);
      expect(refused).toMatchObject({ ok: false, action: "resume", dryRun: false });
      expect(refused.refusal).toContain("approval not verified");
    });
  });

  describe("the built binary", () => {
    const CLI = join(PKG, "dist", "cli.js");
    beforeAll(() => {
      // The shipped CLI is CommonJS; always rebuild so this runs what this tree compiles to.
      execFileSync("npx", ["tsc", "--build", join(PKG, "tsconfig.json")], { stdio: "inherit" });
      expect(existsSync(CLI)).toBe(true);
    });

    it("never discovers ./loom.config.js for a verb that writes, and resumes with --config", async () => {
      await seedParked("e1");
      writeFileSync(join(dir, "loom.config.js"), "throw new Error('must not be imported');");
      const noConfig = spawnSync(
        process.execPath,
        [
          CLI,
          "resume",
          "e1",
          "--event",
          "ApprovalGranted",
          "--payload",
          JSON.stringify(OK),
          ...OWNER,
          "--apply",
        ],
        { cwd: dir, encoding: "utf8" }
      );
      expect(noConfig.status).toBe(2);
      expect(noConfig.stderr).toContain("--config <module> is required");
      expect(noConfig.stderr).not.toContain("must not be imported");

      const before = await events("e1");
      const dryRun = spawnSync(
        process.execPath,
        [
          CLI,
          "resume",
          "e1",
          "--config",
          cfg(),
          ...OWNER,
          "--event",
          "ApprovalGranted",
          "--payload",
          JSON.stringify(OK),
        ],
        { cwd: dir, encoding: "utf8" }
      );
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain("DRY RUN");
      expect(await events("e1")).toEqual(before);

      const applied = spawnSync(
        process.execPath,
        [
          CLI,
          "resume",
          "e1",
          "--config",
          cfg(),
          ...OWNER,
          "--event",
          "ApprovalGranted",
          "--payload",
          JSON.stringify(OK),
          "--apply",
        ],
        { cwd: dir, encoding: "utf8" }
      );
      expect(applied.status).toBe(0);
      expect((await events("e1")).at(-1)).toBe("EXECUTION_COMPLETED");
    }, 60_000);
  });

  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
});

describe("loom resume / start: failure text, durability verification", () => {
  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, "store-"));
  });
  afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));
  const SECRET = "hunter2-secret-value";

  it("an effect's thrown message and a ZodError from a schema never print without --show-payload; they do with it", async () => {
    for (const flowId of ["boom", "zerr"]) {
      const quiet = await start({ flowId, input: {}, id: `q-${flowId}`, apply: true });
      expect(quiet.exitCode, flowId).toBe(1);
      expect(JSON.stringify(quiet), flowId).not.toContain(SECRET);
      expect(quiet.failure, flowId).toContain("the run failed:");
      expect(quiet.failure, flowId).toContain("--show-payload");
      expect(quiet.failure, flowId).toContain(`loom logs q-${flowId}`);
      expect(quiet.failure, flowId).toMatch(flowId === "boom" ? /Error/ : /ZodError/);

      const loud = await start({
        flowId,
        input: {},
        id: `l-${flowId}`,
        apply: true,
        showPayload: true,
      });
      expect(loud.exitCode, flowId).toBe(1);
      expect(loud.failure, flowId).toContain(SECRET);
    }
  });

  it("a store whose query the authorizer denies: the run proceeds, the output says durability was not verified, verified:false, exit 0", async () => {
    const res = await start({ apply: true }, { queryScope: "deny" });
    expect(res.exitCode).toBe(0);
    expect(res.verified).toBe(false);
    expect(res.lines.join("\n")).toContain(
      "durability not verified: query denied by the authorizer"
    );
    expect(res.after?.status).toBe("suspended");
  });

  it("a store read FAILURE after the run is exit 1 (not silently skipped)", async () => {
    (globalThis as { __lcFailLoad?: boolean }).__lcFailLoad = true;
    try {
      const res = await start({ apply: true }, { failLoad: true });
      expect(res.exitCode).toBe(1);
      expect(res.verified).toBe(false);
      expect(res.failure).toContain("durability not verified: store read failed");
      expect(res.lines.join("\n")).toContain("durability not verified: store read failed");
    } finally {
      (globalThis as { __lcFailLoad?: boolean }).__lcFailLoad = false;
    }
  });

  it("a verified outcome reports verified:true", async () => {
    const res = await start({ apply: true });
    expect(res.verified).toBe(true);
    expect(res.lines.join("\n")).not.toContain("not verified");
  });

  describe("conclude: settled error vs cancelled status", () => {
    const principal = { actor: "a" };
    const redactor = { scrub: (x: string) => x, mask: (x: unknown) => x } as never;
    const fake = (
      status: string,
      error: unknown,
      loaded: unknown = "ok"
    ): Parameters<typeof conclude> => {
      const state = {
        executionId: "z",
        workflowId: "w",
        workflowVersion: "1",
        status,
        frames: {},
        variables: {},
        sequence: 3,
        startedAt: 0,
        updatedAt: 0,
      };
      const runtime = {
        loadState: async () => {
          if (loaded !== "ok") throw loaded;
          return state;
        },
      };
      const handle = {
        executionId: "z",
        getState: () => state,
        waitForCompletion: () => (error === undefined ? Promise.resolve() : Promise.reject(error)),
        waitForSuspend: () => new Promise(() => {}),
      };
      return [runtime, handle, principal, redactor, false, "the run"] as never;
    };

    it("a run that failed AND was cancelled reports both and exits 1", async () => {
      const done = await conclude(...fake("cancelled", new Error(`bad ${SECRET}`)));
      expect(done.failure).toContain("failed and the execution was also cancelled");
      expect(done.failure).not.toContain(SECRET);
    });

    it("a plain cancellation (ExecutionCancelledError) with a cancelled status is not a failure", async () => {
      const err = Object.assign(new Error("execution cancelled"), {
        name: "ExecutionCancelledError",
      });
      const done = await conclude(...fake("cancelled", err));
      expect(done.failure).toBeUndefined();
      expect(done.refusal).toBeUndefined();
    });

    it("denied vs failed vs sealed re-reads", async () => {
      const named = (name: string) => Object.assign(new Error("x"), { name });
      const denied = await conclude(...fake("completed", undefined, named("ExecutionDeniedError")));
      expect(denied).toMatchObject({ verified: false, note: expect.stringContaining("denied") });
      expect(denied.failure).toBeUndefined();
      const failed = await conclude(...fake("completed", undefined, new Error("io")));
      expect(failed.failure).toContain("store read failed");
      expect(failed.verified).toBe(false);
      const sealed = await conclude(...fake("completed", undefined, named("PayloadShreddedError")));
      expect(sealed.failure).toBeUndefined();
      expect(sealed.verified).toBe(false);
    });
  });
});
