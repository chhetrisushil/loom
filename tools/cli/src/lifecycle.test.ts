import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SqliteEventStore, SqliteLeaseStore } from "@loom/plugin-sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import {
  cancelExecution,
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

const APP = (dir: string): string => `
import { defineConfig } from "@loom/app";
import { flow$ } from "@loom/core";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { executionAccessPolicy } from "@loom/workflow-runtime";
import { z } from "zod";

const Decision = z.object({ approved: z.boolean(), approvedBy: z.string() });
const approval = {
  definition: flow$({
    id: "approval", name: "approval", version: "1.0.0",
    inputSchema: z.object({ service: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
    steps: [],
    resumeSchemas: { ApprovalGranted: Decision },
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

const APPROVERS = new Set(["alice"]);
globalThis.__lcTimerPolls = globalThis.__lcTimerPolls ?? 0;

export default defineConfig({
  storage: sqliteStorage({ dir: ${JSON.stringify(dir)} }),
  flows: [approval, forbidden],
  security: {
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
      allowWorkflows: ["approval"],
      rules: { resume: "owner", cancel: "owner", query: "tenant" },
    }),
  },
});
`;

let dir = "";
let n = 0;
const OWNER = ["--as", "starter", "--tenant", "acme"];

/** A fresh copy of the app module over the same storage dir (see the header). */
function cfg(): string {
  const file = join(SCRATCH, `app-${n++}.mjs`);
  writeFileSync(file, APP(dir));
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

async function events(id: string): Promise<string[]> {
  const store = new SqliteEventStore(join(dir, "events.db"));
  try {
    return (await store.read(id)).map((e) => e.eventType);
  } finally {
    await store.close();
  }
}

const OK = { approved: true, approvedBy: "alice" };

function resume(id: string, over: Record<string, unknown> = {}) {
  return resumeExecution({
    config: cfg(),
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
function cancel(id: string, over: Record<string, unknown> = {}) {
  return cancelExecution({
    config: cfg(),
    as: "starter",
    tenant: "acme",
    apply: false,
    redact: [],
    executionId: id,
    ...over,
  });
}
function start(over: Record<string, unknown> = {}) {
  return startExecution({
    config: cfg(),
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

    it("loads the app with its background services switched off (LOOM_NO_AUTOSTART)", async () => {
      await seedParked("e1");
      await resume("e1", { apply: true });
      expect(process.env.LOOM_NO_AUTOSTART).toBe("1");
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
  });

  describe("start", () => {
    it("a dry run validates the input and starts nothing; --apply starts and parks", async () => {
      const bad = await start({ input: { service: 7 } });
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
      const id = idempotentExecutionId("approval", "k1");
      expect(id).toBe(idempotentExecutionId("approval", "k1"));
      expect(id).not.toBe(idempotentExecutionId("approval", "k2"));
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
