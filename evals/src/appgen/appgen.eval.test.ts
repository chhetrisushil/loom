import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CassetteMissError, CassetteProvider, reportDigest } from "@loom/eval";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serializeCassette } from "../cassetteFiles";
import { failingMetrics, toRows } from "../gate";
import { buildScoreboard, serializeScoreboard } from "../scoreboard";
import { APPGEN_CASES, type AppgenCase } from "./cases";
import { type SuiteRun, authorAppgenCassette, runAppgenSuite, store } from "./measure";
import { type Arm, buildFixture, coverage, runCase } from "./subject";
import { APPGEN_THRESHOLDS } from "./thresholds";
import { createTypechecker } from "./typecheck";

// ADR 0131 S3 (appgen). The REAL `planChangesModel` + `applyChanges` + a tight `tsc --noEmit` over the committed
// cassettes must clear the committed floors; each DEGRADATION must fall outside them and the failure must NAME the
// metric (and, for an invalid plan, the underlying error). Every degraded test sits beside the real run clearing the
// same gate, so the failure is the degradation. The typecheck is real compiler work: the timeouts are raised.

const T = 180_000; // timing-bound: a cold TypeScript program over the lib + @loom/core declarations is a few seconds

const kase = (id: string): AppgenCase => {
  const c = APPGEN_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const gate = (run: SuiteRun) => failingMetrics(run.scores, APPGEN_THRESHOLDS[run.arm]);
/** The committed cassettes, with one case's replaced. */
const swap = (id: string, data: ReturnType<typeof store.load>) => (c: AppgenCase) =>
  c.id === id ? data : store.load(c.id);

describe("appgen plan eval (@loom/appgen + @loom/appgen-model, hand-authored cassettes)", () => {
  const typechecker = createTypechecker();
  let model: SuiteRun;
  let reference: SuiteRun;
  const fetchSpy = vi.fn(() => {
    throw new Error("network call during a replay eval");
  });

  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchSpy);
    model = await runAppgenSuite({ arm: "model", typechecker });
    reference = await runAppgenSuite({ arm: "deterministic", typechecker });
  }, T);
  afterAll(() => vi.unstubAllGlobals());

  it("sweep: at least 10 intents, a cassette for each and none orphaned, both fixtures and every behaviour class", () => {
    expect(APPGEN_CASES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(APPGEN_CASES.map((c) => c.id)).size).toBe(APPGEN_CASES.length);
    const files = readdirSync(store.dir).filter((f) => !f.startsWith("."));
    expect(files.sort()).toEqual(APPGEN_CASES.map((c) => `${c.id}.json`).sort());
    expect(new Set(APPGEN_CASES.map((c) => c.fixture))).toEqual(new Set(["none", "support-desk"]));
    const tags = new Set(APPGEN_CASES.flatMap((c) => c.tags));
    for (const t of ["net-new", "brownfield", "approval", "ui", "repair", "delete", "multi-flow"]) {
      expect(tags.has(t), t).toBe(true);
    }
    for (const c of APPGEN_CASES) {
      expect(c.expected.present.length + c.expected.absent.length, c.id).toBeGreaterThan(0);
    }
  });

  it(
    "the cassettes are exactly what the hand-written scripts produce (no hand-edited or stale file)",
    async () => {
      for (const c of APPGEN_CASES) {
        expect(serializeCassette(await authorAppgenCassette(c, typechecker)), c.id).toBe(
          serializeCassette(store.load(c.id))
        );
      }
    },
    T
  );

  it("the model arm plans every intent itself (no silent fallback), and the plans are valid", () => {
    for (const [id, o] of model.outcomes) {
      expect(o.reasons, id).toEqual([]);
      expect(o.valid, id).toBe(true);
      expect(o.spec?.planner, id).toBe("model");
    }
    expect(model.outcomes.size).toBe(APPGEN_CASES.length);
    expect(model.report.summary.errored).toBe(0);
    // the one intent that needs a repair round really made two model calls
    expect(model.outcomes.get("edit-refunds-ui")?.replies.length).toBe(2);
  });

  it("the model arm clears its floors; the deterministic reference arm clears its own", () => {
    expect(model.scores.validity).toBe(1);
    expect(gate(model)).toEqual([]);
    expect(gate(reference)).toEqual([]);
    expect(reference.scores.validity).toBe(1);
  });

  it("the delete gap is closed: the model arm plans the delete, as the deterministic arm does", () => {
    expect(
      coverage(
        kase("edit-remove-digest").expected,
        model.outcomes.get("edit-remove-digest")?.observed ?? []
      )
    ).toBe(1);
    expect(
      coverage(
        kase("edit-remove-digest").expected,
        reference.outcomes.get("edit-remove-digest")?.observed ?? []
      )
    ).toBe(1);
    expect(model.scores.coverage).toBeCloseTo(1, 10);
    expect(reference.scores.coverage).toBeCloseTo(0.4, 10);
  });

  it(
    "the typecheck is a real gate: the fixture is clean, and a broken flow is reported with its TS code",
    () => {
      const root = buildFixture("support-desk");
      try {
        expect(typechecker.check(root, ["app/flows/triage/flow.ts"])).toEqual([]);
        const broken = join(root, "app", "flows", "triage", "flow.ts");
        writeFileSync(
          broken,
          `${readFileSync(broken, "utf8")}\nconst oops: number = "not a number";\n`
        );
        const diags = typechecker.check(root, ["app/flows/triage/flow.ts"]);
        expect(diags.map((d) => d.code)).toEqual([2322]);
        expect(diags[0]?.file).toBe(join("app", "flows", "triage", "flow.ts"));
        expect(JSON.stringify(diags)).not.toContain(root); // never an absolute temp path
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    T
  );

  it(
    "the compiler host is shared: a second pass over every case parses nothing outside the fixtures",
    async () => {
      const parsesBefore = typechecker.sharedParses;
      const programsBefore = typechecker.programs;
      expect(programsBefore).toBeGreaterThanOrEqual(2 * APPGEN_CASES.length);
      const again = await runAppgenSuite({ arm: "model", typechecker });
      expect(again.scores).toEqual(model.scores);
      expect(typechecker.sharedParses).toBe(parsesBefore);
      expect(typechecker.programs).toBe(programsBefore + APPGEN_CASES.length);
    },
    T
  );

  describe("fail-proofs", () => {
    it(
      "(a1) a cassette whose plan cannot be used is reported INVALID with the underlying reason, and validity falls below the gate",
      async () => {
        const bad = await authorAppgenCassette(kase("edit-triage-approval"), typechecker, () => ({
          content: "I am sorry, I cannot produce a plan for that.",
          stopReason: "end_turn",
        }));
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("edit-triage-approval", bad),
        });
        const o = run.outcomes.get("edit-triage-approval");
        expect(o?.valid).toBe(false);
        expect(o?.reasons.join(" ")).toMatch(/model plan rejected/);
        expect(o?.reasons.join(" ")).toMatch(/not a usable ChangeSpec/);
        expect(o?.spec?.planner).toBe("deterministic"); // what the silent fallback would have scored as the model's
        expect(run.scores.validity).toBeCloseTo(0.9, 10);
        expect(gate(run)).toContain("validity");
        // the report carries the reason on the failing grader
        const g = run.report.cases
          .find((c) => c.id === "edit-triage-approval")
          ?.graders.find((x) => x.grader === "validity");
        expect(g?.pass).toBe(false);
        expect(g?.detail).toMatch(/not a usable ChangeSpec/);
        // beside it: the real arm clears the same gate
        expect(gate(model)).toEqual([]);
      },
      T
    );

    it(
      "(a2) a semantically invalid plan (an existing flow created again) is reported invalid with the validator's issue, after the repair round",
      async () => {
        const wrong = {
          content: JSON.stringify({
            name: "triage",
            capabilities: [
              {
                id: "triage",
                name: "Triage",
                intent: "x",
                op: "create",
                steps: [{ id: "run", op: "create" }],
              },
            ],
          }),
          stopReason: "end_turn" as const,
        };
        const bad = await authorAppgenCassette(
          kase("edit-triage-approval"),
          typechecker,
          () => wrong
        );
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("edit-triage-approval", bad),
        });
        const o = run.outcomes.get("edit-triage-approval");
        expect(o?.valid).toBe(false);
        expect(o?.reasons.join(" ")).toMatch(/flow "triage" already exists/);
        expect(o?.replies.length).toBe(2); // asked, repaired once, still wrong
        expect(gate(run)).toContain("validity");
      },
      T
    );

    it(
      "(a3) a plan with a duplicate step id is rejected by the validator (fixed 2026-10-17), after the repair round",
      async () => {
        const dup = {
          content: JSON.stringify({
            name: "ticket-router",
            capabilities: [
              {
                id: "ticket-router",
                name: "Ticket Router",
                intent: "x",
                op: "create",
                steps: [
                  { id: "classify", op: "create" },
                  { id: "classify", op: "create" },
                ],
              },
            ],
          }),
          stopReason: "end_turn" as const,
        };
        const bad = await authorAppgenCassette(kase("new-ticket-router"), typechecker, () => dup);
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("new-ticket-router", bad),
        });
        const o = run.outcomes.get("new-ticket-router");
        expect(o?.valid).toBe(false);
        expect(o?.reasons.join(" ")).toMatch(
          /flow "ticket-router" declares step id "classify" more than once/
        );
        expect(o?.replies.length).toBe(2); // asked, repaired once, still wrong
        expect(gate(run)).toContain("validity");
        expect(gate(model)).toEqual([]);
      },
      T
    );

    it(
      "(a3b) a plan the validator accepts whose generated code does not typecheck is reported invalid with the compiler error",
      async () => {
        // The old pin on the `intent` -> `//`-comment injection channel is gone (that channel is
        // closed, see (a3d)). The compiler-error reporting path is covered by corrupting the
        // generated flow.ts inside the harness, between `applyChanges` and the typecheck.
        const c = kase("new-ticket-router");
        const out = await runCase({
          intent: c.intent,
          fixture: c.fixture,
          arm: "model",
          typechecker,
          provider: new CassetteProvider({ mode: "replay", data: store.load(c.id) }),
          tamper: (root) => {
            const file = join(root, "app", "flows", "ticket-router", "flow.ts");
            writeFileSync(file, `${readFileSync(file, "utf8")}\nthis is not typescript\n`);
          },
        });
        expect(out.spec?.planner).toBe("model"); // accepted as a plan ...
        expect(out.valid).toBe(false); // ... and still invalid
        expect(out.reasons.join(" ")).toMatch(
          /typecheck: TS\d+ app\/flows\/ticket-router\/flow\.ts\(\d+\)/
        );
        // the same case untouched is valid: the failure is the corruption
        const clean = await runCase({
          intent: c.intent,
          fixture: c.fixture,
          arm: "model",
          typechecker,
          provider: new CassetteProvider({ mode: "replay", data: store.load(c.id) }),
        });
        expect(clean.valid).toBe(true);
      },
      T
    );

    it(
      "(a3d) a newline in an intent is refused by the validator (repair round, then the deterministic fallback), not left to tsc",
      async () => {
        // Before the codegen-injection fix the validator ignored `intent`, generate.ts spliced it into
        // a `//` comment, and a newline made the rest of the line CODE (a TS syntax error at best).
        // Now the validator names the character class, the model gets one repair round, and a model
        // that keeps it is not trusted: the plan falls back to the deterministic planner, which is
        // scored invalid for the arm (`planner !== "model"`).
        const broken = {
          content: JSON.stringify({
            name: "ticket-router",
            capabilities: [
              {
                id: "ticket-router",
                name: "Ticket Router",
                intent: "route tickets\nthis is not typescript",
                op: "create",
                steps: [{ id: "classify", op: "create" }],
              },
            ],
          }),
          stopReason: "end_turn" as const,
        };
        const bad = await authorAppgenCassette(
          kase("new-ticket-router"),
          typechecker,
          () => broken
        );
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("new-ticket-router", bad),
        });
        const o = run.outcomes.get("new-ticket-router");
        expect(o?.spec?.planner).toBe("deterministic"); // fell back
        expect(o?.valid).toBe(false);
        expect(o?.reasons.join(" ")).toMatch(
          /model plan rejected .*intent of "ticket-router" contains a control, line-break or invisible\/bidi character/
        );
        expect(o?.replies.length).toBe(2); // asked, repaired once, still wrong
        expect(gate(run)).toContain("validity");
        expect(gate(model)).toEqual([]);
      },
      T
    );

    it(
      "(a3c) two step ids that generate one const name (a-b / a--b) are rejected by the validator, not left to tsc",
      async () => {
        const clash = {
          content: JSON.stringify({
            name: "ticket-router",
            capabilities: [
              {
                id: "ticket-router",
                name: "Ticket Router",
                intent: "x",
                op: "create",
                steps: [
                  { id: "a-b", op: "create" },
                  { id: "a--b", op: "create" },
                ],
              },
            ],
          }),
          stopReason: "end_turn" as const,
        };
        const bad = await authorAppgenCassette(kase("new-ticket-router"), typechecker, () => clash);
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("new-ticket-router", bad),
        });
        const o = run.outcomes.get("new-ticket-router");
        expect(o?.valid).toBe(false);
        expect(o?.reasons.join(" ")).toMatch(
          /step id "a--b" in "ticket-router" must be kebab-case/
        );
        expect(o?.reasons.join(" ")).not.toMatch(/typecheck:/);
        expect(o?.replies.length).toBe(2); // asked, repaired once, still wrong
        expect(gate(run)).toContain("validity");
        expect(gate(model)).toEqual([]);
      },
      T
    );

    it(
      "(b) a plan missing a required element (approval, UI and a step) lowers coverage below the floor, naming coverage",
      async () => {
        const lazy = {
          content: JSON.stringify({
            name: "refund-reviewer",
            capabilities: [
              {
                id: "refund-reviewer",
                name: "Refund Reviewer",
                intent: "x",
                op: "create",
                steps: [{ id: "check-policy", op: "create" }],
              },
            ],
          }),
          stopReason: "end_turn" as const,
        };
        const bad = await authorAppgenCassette(
          kase("new-refund-reviewer"),
          typechecker,
          () => lazy
        );
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("new-refund-reviewer", bad),
        });
        expect(run.outcomes.get("new-refund-reviewer")?.valid).toBe(true); // valid, just incomplete
        expect(run.scores.validity).toBe(1);
        expect(run.scores.coverage).toBeCloseTo(1 - 0.6 / 10, 10);
        expect(run.scores.coverage).toBeLessThan(model.scores.coverage as number);
        expect(gate(run)).toEqual(["coverage"]);
        expect(gate(model)).toEqual([]);
      },
      T
    );

    it(
      "(b2) losing ONE expected item anywhere falls below the coverage floor (the margin is under one item)",
      async () => {
        // new-refund-reviewer minus only its UI surface: 4 of 5 items.
        const noUi = {
          content: JSON.stringify({
            name: "refund-reviewer",
            capabilities: [
              {
                id: "refund-reviewer",
                name: "Refund Reviewer",
                intent: "x",
                op: "create",
                steps: [
                  { id: "check-policy", op: "create" },
                  { id: "draft-decision", op: "create" },
                ],
                addApproval: true,
              },
            ],
          }),
          stopReason: "end_turn" as const,
        };
        const c = await authorAppgenCassette(kase("new-refund-reviewer"), typechecker, () => noUi);
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("new-refund-reviewer", c),
        });
        expect(run.scores.coverage).toBeCloseTo(1 - 0.02, 10);
        expect(gate(run)).toEqual(["coverage"]);
      },
      T
    );

    it(
      "(b3) a model that ignores a requested delete (the old no-op extend) falls below the coverage floor",
      async () => {
        const ignoresDelete = {
          content: JSON.stringify({
            name: "digest",
            capabilities: [{ id: "digest", name: "Digest", intent: "x", op: "extend", steps: [] }],
          }),
          stopReason: "end_turn" as const,
        };
        const c = await authorAppgenCassette(
          kase("edit-remove-digest"),
          typechecker,
          () => ignoresDelete
        );
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("edit-remove-digest", c),
        });
        expect(run.outcomes.get("edit-remove-digest")?.valid).toBe(true); // valid, just incomplete
        expect(run.scores.coverage).toBeCloseTo(1 - 0.1, 10);
        expect(gate(run)).toEqual(["coverage"]);
        expect(gate(model)).toEqual([]);
      },
      T
    );

    it(
      "(c) removing one cassette entry fails with CassetteMissError and never falls back silently or calls live",
      async () => {
        const data = store.load("edit-refunds-ui"); // two exchanges: the answer and the repair
        const [first] = Object.keys(data);
        const holed = { ...data };
        delete holed[first as string];
        const run = await runAppgenSuite({
          arm: "model",
          typechecker,
          cassette: swap("edit-refunds-ui", holed),
        });
        const c = run.report.cases.find((x) => x.id === "edit-refunds-ui");
        expect(c?.status).toBe("errored");
        expect(c?.error).toMatch(/no recorded response for request/);
        expect(run.outcomes.has("edit-refunds-ui")).toBe(false);
        expect(run.scores.validity).toBeCloseTo(0.9, 10);
        expect(gate(run)).toContain("validity");
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(new CassetteMissError("k")).toBeInstanceOf(Error);
      },
      T
    );

    it(
      "(d) two consecutive replays are byte-identical (scoreboard rows and report digest, both arms)",
      async () => {
        for (const arm of ["model", "deterministic"] as Arm[]) {
          const a = arm === "model" ? model : reference;
          const b = await runAppgenSuite({ arm, typechecker });
          const board = (r: SuiteRun) =>
            serializeScoreboard(
              buildScoreboard(toRows(`appgen/${arm}`, r.scores, APPGEN_THRESHOLDS[arm]))
            );
          expect(board(b)).toBe(board(a));
          expect(reportDigest(b.report)).toBe(reportDigest(a.report));
        }
      },
      T
    );

    it("the floors sit where the thresholds file says (derived from the real run)", () => {
      expect(APPGEN_THRESHOLDS.model.validity).toBe(1);
      expect(APPGEN_THRESHOLDS.model.coverage as number).toBeGreaterThan(
        (model.scores.coverage as number) - 0.02
      );
      expect(APPGEN_THRESHOLDS.model.coverage as number).toBeLessThanOrEqual(
        model.scores.coverage as number
      );
      expect(APPGEN_THRESHOLDS.deterministic.coverage as number).toBeGreaterThan(
        (reference.scores.coverage as number) - 0.02
      );
      expect(APPGEN_THRESHOLDS.deterministic.coverage as number).toBeLessThanOrEqual(
        reference.scores.coverage as number
      );
    });
  });
});
