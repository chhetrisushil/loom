import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";

// F15: a dry run says it wrote nothing and how to apply; no --model says what planned instead.
describe("loom appgen notices", () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-appgen-notice-"));
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      stdout.push(a.join(" "));
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const intent = "Planner: Step fetch. Step transform.";

  it("dry run prints the re-run hint and writes nothing", async () => {
    const target = join(dir, "app");
    const code = await run(["appgen", intent, "--dir", target, "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("Re-run without --dry-run to apply");
    expect(existsSync(join(target, "package.json"))).toBe(false);
  });

  it("warns loudly on stderr when no --model is given, and not with --offline", async () => {
    await run(["appgen", intent, "--dir", join(dir, "a"), "--dry-run"]);
    expect(stderr.join("")).toMatch(/no --model given.*deterministic keyword parser/);
    stderr.length = 0;
    await run(["appgen", intent, "--dir", join(dir, "b"), "--dry-run", "--offline"]);
    expect(stderr.join("")).not.toMatch(/no --model given/);
  });
});
