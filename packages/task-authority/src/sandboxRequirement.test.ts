import { describe, expect, it } from "vitest";
import { TASK_GRANT_DENIAL } from "./authorizer";
import { checkTaskAuthorityConformance } from "./conformance";
import type { ConformanceSubject } from "./conformanceKit";
import { SECRET, mintReq, task } from "./conformanceKit";
import { rig, sandboxIsolated } from "./conformanceRuntime";
import { InMemoryGrantBroker } from "./renew";

const NOW = 1_000_000;
const subject: ConformanceSubject = {
  makeBroker: (o) => new InMemoryGrantBroker({ secret: o.secret, now: o.now, policy: o.policy }),
};
const BACKEND = { language: "js", wallClock: "hard", memory: true, cpu: true };

// A real runtime and a fake sandbox backend that declares caps. Every tool the flow calls is leased and granted.
async function outcome(
  effects: Record<string, object>,
  calls: string[],
  o: { sandbox?: "isolated"; wired?: boolean; between?: () => void } = {}
) {
  const c = { t: NOW, now: () => NOW };
  const b = new InMemoryGrantBroker({ secret: SECRET, now: c.now });
  const g = await b.mint({
    ...mintReq("t", 9),
    effects: Object.keys(effects),
    leases: { w: { ceiling: 9, effects: Object.keys(effects) } },
    ...(o.sandbox !== undefined && { sandbox: o.sandbox }),
  });
  const reasons: string[] = [];
  const h = rig(
    b,
    c,
    {
      f: async (ctx) => {
        const r: boolean[] = [];
        for (const tool of calls) {
          if (r.length === 1) o.between?.();
          r.push(
            await ctx.run(task(`s-${tool}-${r.length}`, tool), {}).then(
              () => true,
              (e: { reason?: string }) => {
                reasons.push(e.reason ?? "");
                return false;
              }
            )
          );
        }
        return r;
      },
    },
    { sandbox: { wired: o.wired !== false, effects } }
  );
  const out = await (await h.start("f", "t", g)).waitForCompletion();
  return { ran: out.variables._output as boolean[], reasons, h };
}
const ISO = { sandbox: "isolated" as const };

describe("sandboxRequirement (ADR 0150 D10, S-R6)", () => {
  // kills: a middleware that refuses every sandbox effect (the safe backend must still run)
  it("isolated grant + network none + freshPerRun: allowed", async () => {
    const r = await outcome(
      { ok: { ...BACKEND, network: "none", freshPerRun: true } },
      ["ok"],
      ISO
    );
    expect(r.ran).toEqual([true]);
  });

  // kills: a check that ignores `network`, or tests only `!== "open"` (allowlist is not network-less)
  it.each(["open", "allowlist"])(
    "isolated grant + network %s: denied, task-grant:sandbox",
    async (network) => {
      const r = await outcome({ net: { ...BACKEND, network, freshPerRun: true } }, ["net"], ISO);
      expect(r.ran).toEqual([false]);
      expect(r.reasons[0]).toMatch(new RegExp(`^${TASK_GRANT_DENIAL.sandbox}:`));
      expect(r.h.ran.sbx).toBe(0);
    }
  );

  // kills: a check that ignores `freshPerRun`
  it("isolated grant + network none but not freshPerRun: denied", async () => {
    const r = await outcome(
      { reuse: { ...BACKEND, network: "none", freshPerRun: false } },
      ["reuse"],
      ISO
    );
    expect(r.ran).toEqual([false]);
  });

  // kills: a check that passes when a field is undefined (fail open on a partial declaration)
  it("isolated grant + a partial declaration (no freshPerRun): denied", async () => {
    const r = await outcome({ part: { language: "js", network: "none" } }, ["part"], ISO);
    expect(r.ran).toEqual([false]);
  });

  // kills: an own-key-only detection (`Object.hasOwn`): caps that inherit network/freshPerRun (getters on a class
  // prototype) must still be read as a sandbox declaration
  it("isolated grant + caps inherited from a prototype (open network): denied", async () => {
    class Caps {
      get network() {
        return "open";
      }
      get freshPerRun() {
        return true;
      }
    }
    const r = await outcome({ proto: new Caps() }, ["proto"], ISO);
    expect(r.ran).toEqual([false]);
  });

  // kills: a middleware that applies to every grant
  it("no sandbox on the grant: a network-capable backend is allowed (behaviour unchanged)", async () => {
    const r = await outcome({ net: { ...BACKEND, network: "open", freshPerRun: false } }, ["net"]);
    expect(r.ran).toEqual([true]);
  });

  // kills: "has capabilities" as the sandbox test (S6's read marker would be refused: it has no network/freshPerRun)
  it("an effect with only capabilities { read: true } is not a sandbox", async () => {
    const r = await outcome({ rd: { read: true }, plain: {} }, ["plain"], ISO);
    expect(r.ran).toEqual([true]);
  });

  // kills: a middleware that refuses every non-sandbox (ambient) effect, which D10 / S-R6 do not say
  it("an unmarked effect with no capabilities at all is not governed", async () => {
    const c = { t: NOW, now: () => NOW };
    const b = new InMemoryGrantBroker({ secret: SECRET, now: c.now });
    const g = await b.mint({ ...mintReq("t", 5), sandbox: "isolated" });
    const h = rig(
      b,
      c,
      { f: async (ctx) => ctx.run(task("a"), {}).then(() => true) },
      { sandbox: { wired: true } }
    );
    expect((await (await h.start("f", "t", g)).waitForCompletion()).variables._output).toBe(true);
  });

  // kills: reading the live caps object on every call (a backend flipping to network none after the first call)
  it("caps mutated after the first call cannot weaken the check", async () => {
    const live = { ...BACKEND, network: "open", freshPerRun: true };
    const r = await outcome({ net: live }, ["net", "net"], {
      ...ISO,
      between: () => {
        live.network = "none";
      },
    });
    expect(r.ran).toEqual([false, false]);
  });

  // kills: no middleware at all (the broken stack the kit must catch)
  it("the kit check passes the wired stack and fails an unwired one, naming the leak", async () => {
    await expect(sandboxIsolated(subject, true)).resolves.toBeUndefined();
    await expect(sandboxIsolated(subject, false)).rejects.toThrow(
      /ran a network-capable sandbox effect/
    );
  }, 30_000);

  // kills: a child that does not inherit isolation (S4 forces it; this is the end-to-end proof, in the kit check)
  it("the full kit reports sandbox.isolated as passed", async () => {
    const r = await checkTaskAuthorityConformance(subject);
    expect(r.results.find((x) => x.id === "sandbox.isolated")?.status).toBe("passed");
  }, 120_000);
});
