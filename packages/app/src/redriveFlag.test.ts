import { InMemoryTimerStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { defineConfig } from "./defineConfig";

// ADR 0118 D3/D4 — the flag surface (`kernel.features.redrive`) and the supervisor seam
// (`app.supervise`) that composes the retention pin.

describe("kernel.features.redrive", () => {
  it("is OFF by default: no wiring is handed out even with timers configured", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      timers: { store: new InMemoryTimerStore() },
      autostart: false,
    });
    expect(app.redrive).toBeUndefined();
  });

  it("on + timers: hands out the store and the service that fire re-drive rows", () => {
    const timers = new InMemoryTimerStore();
    const app = defineConfig({
      storage: { kind: "memory" },
      kernel: { features: { redrive: true } },
      timers: { store: timers },
      autostart: false,
    });
    expect(app.redrive?.timers).toBe(timers);
    expect(typeof app.redrive?.service.registerRedriver).toBe("function");
  });

  it("on without timers: nothing can fire a row, so it warns instead of pretending", () => {
    const warnings: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      kernel: { features: { redrive: true } },
      observability: { onWarn: (m: string) => warnings.push(m) },
    });
    expect(app.redrive).toBeUndefined();
    expect(warnings.some((w) => /kernel\.features\.redrive/.test(w))).toBe(true);
  });
});

describe("app.supervise", () => {
  it("pins a child its parent is parked on, ORed with the app's own predicate; inert otherwise", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      durability: { retention: { pinned: (id: string) => id === "legal-hold" } },
    });
    const calls: string[] = [];
    // Without a supervisor the app's own predicate still works.
    const evaluate = (id: string) =>
      (
        app.lifecycle as unknown as { options: { pinned: (id: string) => Promise<boolean> } }
      ).options.pinned(id);
    expect(await evaluate("legal-hold")).toBe(true);
    expect(await evaluate("child")).toBe(false);
    const supervisor = app.supervise({
      parkedOnChild: async (id) => {
        calls.push(id);
        return id === "child";
      },
    });
    expect(typeof supervisor.parkedOnChild).toBe("function");
    expect(await evaluate("child")).toBe(true);
    expect(await evaluate("other")).toBe(false);
    expect(await evaluate("legal-hold")).toBe(true);
    expect(calls).toContain("child");
  });
});
