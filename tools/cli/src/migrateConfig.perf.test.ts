import { GROUPED_OPTIONS } from "@loom/app";
import { describe, expect, it } from "vitest";
import { analyzeConfig } from "./migrateConfig";

// Wall-clock scaling: excluded from `pnpm test` (see vitest.shared.ts), run with `pnpm test:perf`.
describe("migrate-config analysis scales linearly", () => {
  const options = GROUPED_OPTIONS.flatMap(([, list]) => [...(list as readonly string[])]);
  const config = (n: number) => {
    let body = "";
    for (let i = 0; i < n; i++)
      body += `  ${options[i % options.length]}: {\n    n: ${i},\n  },\n  custom${i}: ${i},\n`;
    return `import { defineConfig } from "@loom/app";\n\nexport default defineConfig({\n${body}});\n`;
  };
  const time = (n: number) => {
    const src = config(n);
    const t = performance.now();
    const a = analyzeConfig(src);
    const ms = performance.now() - t;
    expect(a.refusal).toBeUndefined();
    return ms;
  };

  it("doubling the entries does not quadruple the time", () => {
    time(2000); // warm up
    const small = Math.max(time(20000), 1);
    const large = time(40000);
    expect(large / small).toBeLessThan(3.2);
  }, 60000);
});
