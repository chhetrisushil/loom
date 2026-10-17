import { afterEach, describe, expect, it, vi } from "vitest";
import { defineConfig } from "./defineConfig";

// `LOOM_QUIET=1` mutes defineConfig's DEFAULT `[loom] …` warn sink (the `loom` CLI sets it while
// importing a config). It must not touch an explicit `onWarn`, and it is read at call time.

const compose = (observability?: { onWarn: (m: string) => void }) =>
  defineConfig({
    storage: { kind: "memory" },
    // redrive with no timers store: a guaranteed boot-time notice
    kernel: { features: { redrive: true } },
    ...(observability !== undefined && { observability }),
  });

describe("LOOM_QUIET", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "LOOM_QUIET");
    vi.restoreAllMocks();
  });

  it("without it the default sink prints a [loom] notice (the control)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compose();
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[loom] "))).toBe(true);
  });

  it("=1 silences the default sink", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.LOOM_QUIET = "1";
    compose();
    expect(warn).not.toHaveBeenCalled();
  });

  it("=1 never silences an explicit onWarn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.LOOM_QUIET = "1";
    const seen: string[] = [];
    compose({ onWarn: (m) => seen.push(m) });
    expect(seen.some((m) => /redrive/.test(m))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
