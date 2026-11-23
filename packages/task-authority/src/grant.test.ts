import {
  CUSTOM_DIMENSION_CEILING,
  CUSTOM_DIMENSION_MAX,
  CUSTOM_DIMENSION_PATTERN,
} from "@loomwork/replay-vm";
import { describe, expect, it } from "vitest";
import {
  type TaskGrant,
  TaskGrantShapeError,
  type UnsignedTaskGrant,
  signTaskGrant,
  taskGrantDigest,
  validateGrantShape,
  verifyTaskGrant,
} from "./index";

const S = "secret-one";
const base = (): UnsignedTaskGrant => ({
  taskId: "t-child",
  rootId: "t-root",
  parentId: "t-parent",
  issuedTo: "agent-1",
  effects: ["email.send", "db.write", "db.read"],
  leases: {
    emails: { ceiling: 5, effects: ["email.send"] },
    writes: { ceiling: 9, effects: ["db.write", "db.read"] },
  },
  exp: 2_000_000,
  epoch: 3,
});
const rootBase = (id: string): UnsignedTaskGrant => {
  const { parentId: _p, ...rest } = base();
  return { ...rest, taskId: id, rootId: id };
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Every path (including nested lease fields) of a real signed grant.
function paths(v: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (typeof v !== "object" || v === null) return [prefix];
  return Object.entries(v).flatMap(([k, c]) =>
    paths(c, [...prefix, Array.isArray(v) ? Number(k) : k])
  );
}
function mutate(g: TaskGrant, path: (string | number)[]): TaskGrant {
  const c = clone(g) as unknown as Record<string | number, unknown>;
  let o: Record<string | number, unknown> = c;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  const v = o[last];
  o[last] = typeof v === "number" ? v + 1 : typeof v === "string" ? `${v}x` : v;
  return c as unknown as TaskGrant;
}

describe("task grant token", () => {
  it("round-trips", () => {
    const g = signTaskGrant(S, base());
    expect(g.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyTaskGrant(S, g)).toBeDefined();
    expect(verifyTaskGrant(S, clone(g))).toBeDefined();
  });

  it("wrong secret fails", () => {
    expect(verifyTaskGrant("other", signTaskGrant(S, base()))).toBeUndefined();
  });

  it("changing ANY field (derived from the real object) fails verification", () => {
    const g = signTaskGrant(S, base());
    const all = paths(g);
    expect(all.length).toBeGreaterThan(10);
    const flat = all.map((p) => p.join("."));
    for (const f of [
      "taskId",
      "rootId",
      "parentId",
      "issuedTo",
      "effects.0",
      "effects.1",
      "effects.2",
      "exp",
      "epoch",
      "sig",
      "leases.emails.ceiling",
      "leases.emails.effects.0",
      "leases.writes.effects.1",
    ])
      expect(flat).toContain(f);
    for (const p of all) {
      const t = mutate(g, p);
      expect(verifyTaskGrant(S, t), `tampering ${p.join(".")}`).toBeUndefined();
    }
    // adding / removing / renaming fields
    const extraLease = clone(g);
    extraLease.leases.more = { ceiling: 1, effects: ["db.write"] };
    expect(verifyTaskGrant(S, extraLease)).toBeUndefined();
    const { parentId: _pid, ...noParent } = clone(g);
    expect(verifyTaskGrant(S, noParent as TaskGrant)).toBeUndefined();
    const root = signTaskGrant(S, rootBase("t-root"));
    expect(verifyTaskGrant(S, { ...root, parentId: "t-parent" })).toBeUndefined();
  });

  it("shape-preserving tampers (shape stays valid, signature must fail)", () => {
    const g = signTaskGrant(S, base());
    const tampers: Record<string, (c: TaskGrant) => void> = {
      "append unreferenced effect": (c) => {
        c.effects.push("admin.drop");
      },
      "lease effects -> other valid subset": (c) => {
        (c.leases.writes as unknown as { effects: string[] }).effects = ["db.write"];
      },
      "rename a lease": (c) => {
        c.leases.mails = c.leases.emails as never;
        Reflect.deleteProperty(c.leases, "emails");
      },
      "swap lease ceilings": (c) => {
        const a = (c.leases.emails as { ceiling: number }).ceiling;
        (c.leases.emails as { ceiling: number }).ceiling = (
          c.leases.writes as { ceiling: number }
        ).ceiling;
        (c.leases.writes as { ceiling: number }).ceiling = a;
      },
    };
    for (const [name, f] of Object.entries(tampers)) {
      const c = clone(g);
      f(c);
      const { sig: _s, ...body } = c;
      expect(() => validateGrantShape(body), name).not.toThrow();
      expect(verifyTaskGrant(S, c), name).toBeUndefined();
    }
  });

  it("refuses keys it never signed (top level, lease spec, symbol)", () => {
    const g = signTaskGrant(S, base());
    expect(
      verifyTaskGrant(S, { ...g, reads: ["x"], ambient: true } as unknown as TaskGrant)
    ).toBeUndefined();
    const lease = clone(g);
    (lease.leases.emails as unknown as Record<string, unknown>).extra = 1;
    expect(verifyTaskGrant(S, lease)).toBeUndefined();
    const sym = { ...clone(g), [Symbol("x")]: 1 };
    expect(verifyTaskGrant(S, sym as TaskGrant)?.effects).not.toContain("*");
    expect(() => validateGrantShape({ ...base(), [Symbol("x")]: 1 })).toThrow(TaskGrantShapeError);
    expect(() => validateGrantShape({ ...base(), sig: "a" })).toThrow(TaskGrantShapeError);
  });

  it("TOCTOU: the returned copy is what was signed and is frozen", () => {
    const g = signTaskGrant(S, base());
    let reads = 0;
    const getter = clone(g);
    Object.defineProperty(getter, "effects", {
      enumerable: true,
      get: () => (++reads === 1 ? g.effects : ["*"]),
    });
    const a = verifyTaskGrant(S, getter);
    if (a) expect(a.effects).toEqual([...g.effects]);
    expect(a?.effects).not.toContain("*");

    const iter = clone(g);
    Object.defineProperty(iter.effects, Symbol.iterator, {
      value: function* () {
        yield* g.effects;
      },
    });
    iter.effects[0] = "*";
    expect(verifyTaskGrant(S, iter)).toBeUndefined();

    const hidden = clone(g);
    Object.defineProperty(hidden.leases, "emails", {
      enumerable: false,
      value: hidden.leases.emails,
    });
    expect(verifyTaskGrant(S, hidden)).toBeUndefined();

    const ok = verifyTaskGrant(S, g) as TaskGrant;
    expect(Object.isFrozen(ok)).toBe(true);
    expect(Object.isFrozen(ok.effects)).toBe(true);
    expect(Object.isFrozen(ok.leases.emails)).toBe(true);
    expect(ok).not.toBe(g);
    expect(ok.effects).not.toContain("admin.drop");
  });

  it("empty secret: sign throws, verify returns undefined", () => {
    expect(() => signTaskGrant("", base())).toThrow(TaskGrantShapeError);
    expect(verifyTaskGrant("", signTaskGrant(S, base()))).toBeUndefined();
  });

  it("digest: computed from a validated snapshot; malformed input throws TaskGrantShapeError", () => {
    expect(() => taskGrantDigest(null as unknown as TaskGrant)).toThrow(TaskGrantShapeError);
    expect(() =>
      taskGrantDigest({ ...signTaskGrant(S, base()), extra: 1 } as unknown as TaskGrant)
    ).toThrow(TaskGrantShapeError);
  });

  it("a huge lease object is rejected", () => {
    const leases = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`l${i}`, 1]));
    expect(() => validateGrantShape({ ...base(), leases })).toThrow(TaskGrantShapeError);
  });

  it("lease names: no dots, so no collision with reservation dimensions", () => {
    for (const name of ["a.reserved", "A", "1a", "__proto__", "constructor".toUpperCase()]) {
      const g = base();
      g.leases = { [name]: { ceiling: 1, effects: ["db.write"] } };
      expect(() => validateGrantShape(g), name).toThrow(TaskGrantShapeError);
    }
  });

  it("input key / array order changes neither signature nor digest", () => {
    const a = signTaskGrant(S, base());
    const b = signTaskGrant(S, {
      epoch: 3,
      exp: 2_000_000,
      leases: {
        writes: { effects: ["db.read", "db.write"], ceiling: 9 },
        emails: { effects: ["email.send"], ceiling: 5 },
      },
      effects: ["db.write", "db.read", "email.send"],
      issuedTo: "agent-1",
      parentId: "t-parent",
      rootId: "t-root",
      taskId: "t-child",
    });
    expect(b.sig).toBe(a.sig);
    expect(taskGrantDigest(b)).toBe(taskGrantDigest(a));
    expect(taskGrantDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(taskGrantDigest({ ...a, sig: "0".repeat(64) })).not.toBe(taskGrantDigest(a));
  });

  it("a root grant has no parent and rootId === taskId", () => {
    const g = signTaskGrant(S, rootBase("r"));
    expect("parentId" in g).toBe(false);
    expect(verifyTaskGrant(S, g)).toBeDefined();
  });

  describe("shape bounds", () => {
    const bad = (mut: (g: Record<string, unknown>) => void): void => {
      const g = clone(base()) as unknown as Record<string, unknown>;
      mut(g);
      expect(() => validateGrantShape(g)).toThrow(TaskGrantShapeError);
      expect(() => signTaskGrant(S, g as unknown as UnsignedTaskGrant)).toThrow(
        TaskGrantShapeError
      );
    };
    const leases = (g: Record<string, unknown>) =>
      g.leases as Record<string, { ceiling: unknown; effects: unknown }>;
    it("refuses an effect listed in two leases (overlap, R21a)", () => {
      bad((g) => {
        leases(g).writes!.effects = ["db.write", "email.send"];
      });
    });
    it("refuses a resource-qualified lease effect (R21b)", () => {
      bad((g) => {
        (g.effects as string[]).push("db.write:orders");
        leases(g).writes!.effects = ["db.write:orders"];
      });
    });
    it("accepts the base grant", () => {
      expect(() => validateGrantShape(base())).not.toThrow();
    });
    it("ids", () => {
      bad((g) => {
        g.taskId = "";
      });
      bad((g) => {
        g.issuedTo = "x".repeat(257);
      });
      bad((g) => {
        g.rootId = 5;
      });
      bad((g) => {
        g.parentId = "";
      });
    });
    it("root/child consistency", () => {
      bad((g) => {
        g.rootId = g.taskId;
      }); // parent with root === task
      bad((g) => {
        g.parentId = undefined;
      }); // root !== task, no parent
    });
    it("effects", () => {
      bad((g) => {
        g.effects = Array.from({ length: 257 }, (_, i) => `e${i}`);
      });
      bad((g) => {
        g.effects = [""];
      });
      bad((g) => {
        g.effects = ["x".repeat(513)];
      });
      bad((g) => {
        g.effects = ["*"];
      });
      bad((g) => {
        g.effects = [1];
      });
    });
    it("leases", () => {
      bad((g) => {
        g.leases = Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [`l${i}`, { ceiling: 1, effects: ["db.write"] }])
        );
      });
      bad((g) => {
        leases(g)["Bad Name"] = { ceiling: 1, effects: ["db.write"] };
      });
      bad((g) => {
        leases(g)["a".repeat(50)] = { ceiling: 1, effects: ["db.write"] };
      }); // .reserved overflows 64
      bad((g) => {
        g.leases = JSON.parse('{"__proto__":{"ceiling":1,"effects":["db.write"]}}');
      });
      for (const c of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e15 + 2, "5"])
        bad((g) => {
          (leases(g).emails as { ceiling: unknown }).ceiling = c;
        });
      bad((g) => {
        (leases(g).emails as { effects: unknown }).effects = [];
      });
      bad((g) => {
        (leases(g).emails as { effects: unknown }).effects = ["not.granted"];
      });
      bad((g) => {
        g.leases = [];
      });
    });
    it("exp and epoch", () => {
      for (const v of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
        bad((g) => {
          g.exp = v;
        });
        bad((g) => {
          g.epoch = v;
        });
      }
    });
    it("lease ceiling max boundary and name boundary are accepted", () => {
      const g = base();
      g.leases = { [`a${"b".repeat(48)}`]: { ceiling: 1e15, effects: ["db.write"] } };
      expect(() => validateGrantShape(g)).not.toThrow();
    });
  });

  it("malformed inputs verify false without throwing", () => {
    const g = signTaskGrant(S, base());
    const { sig: _s, ...noSig } = g;
    const inputs: unknown[] = [
      null,
      undefined,
      5,
      "str",
      [],
      {},
      noSig,
      { ...g, sig: "abcd" },
      { ...g, sig: "z".repeat(64) },
      { ...g, sig: 7 },
      { ...g, sig: "a".repeat(65) },
      { ...g, leases: null },
      { ...g, effects: "x" },
      { ...g, leases: { emails: null } },
      Object.create(g), // inherited fields only
    ];
    for (const i of inputs) expect(verifyTaskGrant(S, i as TaskGrant)).toBeUndefined();
  });

  it("mirrors the kernel's custom-dimension rules", () => {
    expect(CUSTOM_DIMENSION_PATTERN.source).toBe("^[a-z][a-z0-9._-]{0,63}$");
    expect(CUSTOM_DIMENSION_CEILING).toBe(1e15);
    expect(CUSTOM_DIMENSION_MAX).toBe(32);
  });
});
