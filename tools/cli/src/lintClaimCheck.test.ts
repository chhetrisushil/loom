import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdLintClaimCheck, lintClaimCheckSource } from "./lintClaimCheck";

const FLOW_HEADER = `import { flow$, step$ } from "@loom/core";\nconst f = flow$({ id: "sentinel" });\n`;

describe("lintClaimCheckSource (CC-5)", () => {
  it("flags resolveClaimCheck inside a flow-defining module", () => {
    const source = `${FLOW_HEADER}const payload = await resolveClaimCheck(store, out);\nif (payload.rows > 9) escalate();\n`;
    const findings = lintClaimCheckSource("flows/sentinel.ts", source);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "flows/sentinel.ts",
      line: 3,
      rule: "resolve-inside-flow",
    });
  });

  it("flags a forged envelope literal inside a flow-defining module", () => {
    const source = `${FLOW_HEADER}const fake = { __loomClaimCheck: true, ref: { __loomContent: "sha256:00" }, size: 1 };\n`;
    const findings = lintClaimCheckSource("flows/sentinel.ts", source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("forged-envelope");
  });

  it("does NOT flag the sanctioned patterns: isClaimCheck guard, digest branch, ref cited in a finding", () => {
    const source = `${FLOW_HEADER}
      const out = await ctx.execute(readTool, { q });
      if (isClaimCheck(out) && (out.digest as { p99: number }).p99 > 200) {
        ctx.emit("FINDING_RECORDED", { severity: "high", evidence: [out.ref] });
      }
    `;
    expect(lintClaimCheckSource("flows/sentinel.ts", source)).toEqual([]);
  });

  it("ignores non-flow modules entirely (UI/export code may resolve)", () => {
    const source =
      "export async function renderEvidence(store, envelope) {\n  return resolveClaimCheck(store, envelope);\n}\n";
    expect(lintClaimCheckSource("ui/evidence.ts", source)).toEqual([]);
  });
});

describe("cmdLintClaimCheck", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("walks a tree, skips tests/dist/node_modules, and reports findings with exit intent", () => {
    dir = mkdtempSync(join(tmpdir(), "loom-lint-"));
    mkdirSync(join(dir, "flows"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(
      join(dir, "flows", "bad.ts"),
      `${FLOW_HEADER}const v = await resolveClaimCheck(s, e);\n`
    );
    writeFileSync(join(dir, "flows", "good.ts"), `${FLOW_HEADER}// digests only here\n`);
    writeFileSync(
      join(dir, "flows", "bad.test.ts"),
      `${FLOW_HEADER}resolveClaimCheck(s, e); // tests are exempt\n`
    );
    writeFileSync(join(dir, "node_modules", "dep.ts"), `${FLOW_HEADER}resolveClaimCheck(s, e);\n`);

    const { text, findings } = cmdLintClaimCheck(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toContain("bad.ts");
    expect(text).toContain("1 finding(s)");

    rmSync(join(dir, "flows", "bad.ts"));
    const clean = cmdLintClaimCheck(dir);
    expect(clean.findings).toEqual([]);
    expect(clean.text).toContain("✓ no claim-check reach-through");
  });
});
