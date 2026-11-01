import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { TypedFailure } from "@loom/core";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX_BACKEND_SPI_VERSION,
  type SandboxBackend,
  type SandboxBackendCapabilities,
  SandboxEffect,
  type SandboxEffectOptions,
  type SandboxOutcome,
  type SandboxRequest,
  shapeHash,
} from "./index";

// ── ADR 0144 — SandboxEffect against a fake backend ──────────────────────────
//
// The fake returns whatever it is told, including outcomes no honest backend would, so the tests
// prove the EFFECT's guarantees (validation, bounds, precedence, replay form) independent of any
// engine.

const CAPS: SandboxBackendCapabilities = {
  language: "javascript",
  network: "none",
  wallClock: "hard",
  memory: true,
  cpu: true,
  freshPerRun: true,
};

class FakeBackend implements SandboxBackend {
  requests: SandboxRequest[] = [];
  warmed = 0;
  closed = 0;
  constructor(
    private readonly respond: (r: SandboxRequest) => unknown | Promise<unknown>,
    readonly capabilities: SandboxBackendCapabilities = CAPS
  ) {}
  async evaluate(request: SandboxRequest): Promise<SandboxOutcome> {
    this.requests.push(request);
    return (await this.respond(request)) as SandboxOutcome;
  }
  async warm() {
    this.warmed++;
  }
  async close() {
    this.closed++;
  }
}

function store(code = "ignored") {
  const bytes = new TextEncoder().encode(code);
  const ref = { __loomContent: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  return { ref, scripts: { get: async () => bytes } };
}

const ctx = (signal?: AbortSignal): EffectContext => ({
  executionId: "x",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit: () => {},
  ...(signal !== undefined && { signal }),
});

async function run(
  respond: (r: SandboxRequest) => unknown,
  extra: Record<string, unknown> = {},
  opts: SandboxEffectOptions = {},
  signal?: AbortSignal
) {
  const { ref, scripts } = store();
  const backend = new FakeBackend(respond);
  const effect = new SandboxEffect(scripts, backend, opts);
  return { backend, result: effect.execute({ scriptRef: ref, ...extra }, ctx(signal)) };
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected failure");
}

function channel(err: unknown, name: string): TypedFailure {
  expect(err).toBeInstanceOf(TypedFailure);
  expect((err as TypedFailure).channel).toBe(name);
  return err as TypedFailure;
}

describe("SandboxEffect — outcome mapping (D2)", () => {
  it("is versioned", () => {
    expect(SANDBOX_BACKEND_SPI_VERSION).toBe("1.0.0");
  });

  it("hands the backend verified source, bounded JSON input and the limits", async () => {
    const { backend, result } = await run(() => ({ ok: true, value: 1 }), { input: { a: 1 } });
    expect(await result).toBe(1);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      script: "ignored",
      inputJson: '{"a":1}',
      limits: { wallClockMs: 1000, memoryBytes: 32 * 1024 * 1024 },
    });
  });

  it.each(["cpu", "memory", "wallClock"] as const)("limit %s -> limitExceeded", async (limit) => {
    const { result } = await run(() => ({ ok: false, kind: "limit", limit }));
    expect(channel(await failure(result), "limitExceeded").payload).toEqual({ kind: limit });
  });

  it("threw -> scriptError with name and message", async () => {
    const { result } = await run(() => ({
      ok: false,
      kind: "threw",
      name: "TypeError",
      message: "bad",
    }));
    const err = channel(await failure(result), "scriptError");
    expect(err.payload).toEqual({ name: "TypeError", message: "bad" });
    expect((err as Error).message).toBe("sandbox script failed: TypeError: bad");
  });

  it("threw without a name -> scriptError without one", async () => {
    const { result } = await run(() => ({ ok: false, kind: "threw", message: "42" }));
    expect(channel(await failure(result), "scriptError").payload).toEqual({ message: "42" });
  });

  it("the EFFECT bounds threw text whatever the backend did, and makes it storable", async () => {
    const { result } = await run(() => ({
      ok: false,
      kind: "threw",
      name: `N${"n".repeat(1000)}`,
      message: `${"m".repeat(5000)}\ud800\u0000`,
    }));
    const { name, message } = channel(await failure(result), "scriptError").payload as {
      name: string;
      message: string;
    };
    expect(name.length).toBeLessThanOrEqual(128);
    expect(message.length).toBeLessThanOrEqual(2048);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const tail = await run(() => ({ ok: false, kind: "threw", message: "a\ud800\u0000b" }));
    const m = (channel(await failure(tail.result), "scriptError").payload as { message: string })
      .message;
    expect(m).not.toMatch(lone);
    expect(m).not.toContain("\u0000");
  });

  it("inputTooLarge -> inputTooLarge against the memory ceiling, not a limitExceeded", async () => {
    const { result } = await run(() => ({ ok: false, kind: "inputTooLarge" }), { input: [1, 2] });
    expect(channel(await failure(result), "inputTooLarge").payload).toEqual({
      bytes: 5,
      limit: 32 * 1024 * 1024,
    });
  });

  it("infrastructure -> UNTYPED and bounded", async () => {
    const { result } = await run(() => ({
      ok: false,
      kind: "infrastructure",
      message: "x".repeat(9000),
    }));
    const err = await failure(result);
    expect(err).not.toBeInstanceOf(TypedFailure);
    expect((err as Error).message.length).toBeLessThan(2200);
  });

  it("a backend that throws is untyped (and passes through)", async () => {
    const boom = new Error("socket hang up");
    const { result } = await run(() => {
      throw boom;
    });
    expect(await failure(result)).toBe(boom);
  });
});

describe("SandboxEffect — a malformed outcome fails UNTYPED, never a guessed channel", () => {
  const bad: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["a string", "ok"],
    ["an array", []],
    ["no ok", {}],
    ["ok not boolean", { ok: "yes", value: 1 }],
    ["no kind", { ok: false }],
    ["unknown kind", { ok: false, kind: "oom" }],
    ["limit with a bad limit", { ok: false, kind: "limit", limit: "disk" }],
    ["limit without a limit", { ok: false, kind: "limit" }],
    ["threw without message", { ok: false, kind: "threw" }],
    ["threw with a numeric message", { ok: false, kind: "threw", message: 42 }],
    ["threw with a numeric name", { ok: false, kind: "threw", name: 1, message: "m" }],
    ["infrastructure without message", { ok: false, kind: "infrastructure" }],
  ];
  it.each(bad)("%s", async (_name, outcome) => {
    const { result } = await run(() => outcome);
    const err = await failure(result);
    expect(err).not.toBeInstanceOf(TypedFailure);
    expect((err as Error).message).toMatch(/malformed outcome/);
  });
});

describe("SandboxEffect — cancellation wins (D2)", () => {
  const reason = new Error("cancelled by kernel");
  const outcomes: [string, unknown][] = [
    ["success", { ok: true, value: 1 }],
    ["a limit", { ok: false, kind: "limit", limit: "cpu" }],
    ["a throw", { ok: false, kind: "threw", message: "x" }],
    ["infrastructure", { ok: false, kind: "infrastructure", message: "x" }],
    ["a malformed outcome", { nonsense: true }],
  ];
  it.each(outcomes)("over %s", async (_n, outcome) => {
    const c = new AbortController();
    const { result } = await run(
      () => {
        c.abort(reason);
        return outcome;
      },
      {},
      {},
      c.signal
    );
    expect(await failure(result)).toBe(reason);
  });

  it("over a backend that throws", async () => {
    const c = new AbortController();
    const { result } = await run(
      () => {
        c.abort(reason);
        throw new Error("secondary");
      },
      {},
      {},
      c.signal
    );
    expect(await failure(result)).toBe(reason);
  });

  it("hands the backend a COMBINED signal that follows the caller's abort", async () => {
    const c = new AbortController();
    const seen: AbortSignal[] = [];
    const { backend, result } = await run(
      (r) => {
        seen.push(r.signal as AbortSignal);
        return { ok: true, value: 1 };
      },
      {},
      {},
      c.signal
    );
    await result;
    expect(backend.requests[0]?.signal).toBeDefined();
    expect(backend.requests[0]?.signal).not.toBe(c.signal);
    expect(seen[0]?.aborted).toBe(false);
  });

  it("a backend that NEVER settles loses to the caller's abort, which stops it via the combined signal", async () => {
    const c = new AbortController();
    let backendSignal: AbortSignal | undefined;
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    const { result } = await run(
      (r) => {
        backendSignal = r.signal;
        started();
        return new Promise(() => {});
      },
      {},
      {},
      c.signal
    );
    await startedP;
    c.abort(reason);
    expect(await failure(result)).toBe(reason);
    expect(backendSignal?.aborted).toBe(true);
  });

  it("an already-aborted caller still cancels a backend that never settles", async () => {
    const c = new AbortController();
    c.abort(reason);
    const { result } = await run(() => new Promise(() => {}), {}, {}, c.signal);
    expect(await failure(result)).toBe(reason);
  });
});

describe("SandboxEffect — the success value is its JSON round-trip (D3)", () => {
  it("live form equals replay form: NaN and Infinity become null", async () => {
    const { result } = await run(() => ({
      ok: true,
      value: { n: Number.NaN, i: Number.POSITIVE_INFINITY, k: 1 },
    }));
    const live = await result;
    expect(live).toEqual({ n: null, i: null, k: 1 });
    // What a durable store would hand back on replay.
    expect(live).toEqual(JSON.parse(JSON.stringify(live)));
  });

  it("a prototype, a getter, toJSON and undefined members come back plain", async () => {
    class Row {
      a = 1;
      get computed() {
        return "g";
      }
      toJSON() {
        return { a: this.a, computed: this.computed };
      }
    }
    const value = { row: new Row(), when: new Date(0), skipped: undefined, list: [undefined, 1] };
    const { result } = await run(() => ({ ok: true, value }));
    const live = (await result) as Record<string, unknown>;
    expect(live).toEqual({
      row: { a: 1, computed: "g" },
      when: "1970-01-01T00:00:00.000Z",
      list: [null, 1],
    });
    expect(Object.getPrototypeOf(live.row)).toBe(Object.prototype);
    expect(live).not.toBe(value);
    expect("skipped" in live).toBe(false);
  });

  it("undefined stays undefined", async () => {
    const { result } = await run(() => ({ ok: true, value: undefined }));
    expect(await result).toBeUndefined();
  });

  it("a value JSON cannot carry fails untyped", async () => {
    for (const value of [() => 1, Symbol("s"), 10n]) {
      const { result } = await run(() => ({ ok: true, value }));
      const err = await failure(result);
      expect(err).not.toBeInstanceOf(TypedFailure);
      expect((err as Error).message).toMatch(/not JSON/);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { result } = await run(() => ({ ok: true, value: cyclic }));
    expect(await failure(result)).toBeInstanceOf(Error);
  });

  it("the shape is checked on the JSON form", async () => {
    const { result } = await run(() => ({ ok: true, value: { n: Number.NaN } }), {
      expectedOutputShapeHash: shapeHash({ n: null }),
    });
    expect(await result).toEqual({ n: null });
    const mismatch = await run(() => ({ ok: true, value: { n: 1 } }), {
      expectedOutputShapeHash: shapeHash({ n: "x" }),
    });
    channel(await failure(mismatch.result), "shapeMismatch");
  });

  it("an oversized output is limitExceeded output", async () => {
    const { result } = await run(
      () => ({ ok: true, value: "x".repeat(100) }),
      {},
      { limits: { maxOutputBytes: 50 } }
    );
    expect(channel(await failure(result), "limitExceeded").payload).toEqual({ kind: "output" });
  });
});

describe("SandboxEffect — the guarantees around the engine", () => {
  it("refuses an oversized or unserializable input before the script is fetched or the backend called", async () => {
    let fetched = 0;
    const backend = new FakeBackend(() => ({ ok: true, value: 1 }));
    const effect = new SandboxEffect(
      {
        get: async () => {
          fetched++;
          return null;
        },
      },
      backend,
      {
        limits: { maxInputBytes: 10 },
      }
    );
    const ref = { __loomContent: "sha256:00" };
    channel(
      await failure(effect.execute({ scriptRef: ref, input: "x".repeat(50) }, ctx())),
      "inputTooLarge"
    );
    channel(
      await failure(effect.execute({ scriptRef: ref, input: 1n }, ctx())),
      "inputNotSerializable"
    );
    expect(fetched).toBe(0);
    expect(backend.requests).toHaveLength(0);
  });

  it("verifies the script bytes against their address (untyped on mismatch) and reports a missing script", async () => {
    const backend = new FakeBackend(() => ({ ok: true, value: 1 }));
    const { ref } = store("one");
    const tampered = new SandboxEffect(
      { get: async () => new TextEncoder().encode("two") },
      backend
    );
    const err = await failure(tampered.execute({ scriptRef: ref }, ctx()));
    expect(err).not.toBeInstanceOf(TypedFailure);
    expect((err as Error).message).toMatch(/do not match their content address/);
    const missing = new SandboxEffect({ get: async () => null }, backend);
    channel(await failure(missing.execute({ scriptRef: ref }, ctx())), "scriptMissing");
    expect(backend.requests).toHaveLength(0);
  });

  it("refuses a negative or NaN byte limit at construction", () => {
    const { scripts } = store();
    const backend = new FakeBackend(() => ({ ok: true, value: 1 }));
    for (const bad of [Number.NaN, -1]) {
      expect(
        () => new SandboxEffect(scripts, backend, { limits: { maxOutputBytes: bad } })
      ).toThrow(/maxOutputBytes/);
      expect(() => new SandboxEffect(scripts, backend, { limits: { maxInputBytes: bad } })).toThrow(
        /maxInputBytes/
      );
    }
  });

  it("delegates warm() and close() to the backend", async () => {
    const { scripts } = store();
    const backend = new FakeBackend(() => ({ ok: true, value: 1 }));
    const effect = new SandboxEffect(scripts, backend);
    await effect.warm();
    await effect.close();
    expect([backend.warmed, backend.closed]).toEqual([1, 1]);
    // Both are optional on a backend.
    const bare: SandboxBackend = {
      capabilities: CAPS,
      evaluate: async () => ({ ok: true, value: 1 }),
    };
    const e2 = new SandboxEffect(scripts, bare);
    await expect(e2.warm()).resolves.toBeUndefined();
    await expect(e2.close()).resolves.toBeUndefined();
  });
});

describe("SandboxEffect — capability checks at construction (D4)", () => {
  const { scripts } = store();
  const make = (caps: Partial<SandboxBackendCapabilities>, opts?: SandboxEffectOptions) =>
    new SandboxEffect(
      scripts,
      new FakeBackend(() => ({ ok: true, value: 1 }), { ...CAPS, ...caps }),
      opts
    );

  it("accepts a network:none, fresh backend by default, and is idempotent", () => {
    expect(make({}).idempotent).toBe(true);
  });

  it("idempotent is network:none AND freshPerRun, both ways (D4)", () => {
    const opts = { allowNetwork: true, allowReusedEnvironment: true };
    expect(make({ network: "none", freshPerRun: true }, opts).idempotent).toBe(true);
    expect(make({ network: "none", freshPerRun: false }, opts).idempotent).toBe(false);
    expect(make({ network: "open", freshPerRun: true }, opts).idempotent).toBe(false);
    expect(make({ network: "open", freshPerRun: false }, opts).idempotent).toBe(false);
  });

  it("vets a frozen SNAPSHOT of the capabilities: a later mutation or a flipping getter changes nothing", () => {
    const mutable = { ...CAPS };
    const backend = new FakeBackend(() => ({ ok: true, value: 1 }), mutable);
    const effect = new SandboxEffect(scripts, backend);
    mutable.network = "open";
    mutable.freshPerRun = false;
    expect(effect.idempotent).toBe(true);
    expect(effect.capabilities.network).toBe("none");
    expect(effect.capabilities.freshPerRun).toBe(true);
    expect(Object.isFrozen(effect.capabilities)).toBe(true);

    let reads = 0;
    const flipping = {
      get capabilities() {
        return reads++ === 0 ? CAPS : { ...CAPS, network: "open", freshPerRun: false };
      },
      evaluate: async () => ({ ok: true, value: 1 }),
    };
    const e2 = new SandboxEffect(scripts, flipping as unknown as SandboxBackend);
    expect(e2.capabilities).toEqual(CAPS);
    expect(e2.idempotent).toBe(true);
  });

  it("reads each capability field once (a field getter that flips cannot pass a check then deliver another value)", () => {
    let reads = 0;
    const caps = {
      ...CAPS,
      get network() {
        return reads++ === 0 ? "none" : "open";
      },
    };
    const e = new SandboxEffect(scripts, {
      capabilities: caps,
      evaluate: async () => ({ ok: true, value: 1 }),
    } as unknown as SandboxBackend);
    expect(e.capabilities.network).toBe("none");
  });

  it.each(["allowlist", "open"] as const)(
    "REFUSES network %s unless allowNetwork: true",
    (network) => {
      expect(() => make({ network })).toThrow(/allowNetwork/);
      expect(() => make({ network }, { allowNetwork: false })).toThrow(/allowNetwork/);
      // The opt-in is only for the network: it does not also buy a reused environment.
      expect(() => make({ network, freshPerRun: false }, { allowNetwork: true })).toThrow(
        /allowReusedEnvironment/
      );
    }
  );

  it.each(["allowlist", "open"] as const)(
    "network %s with the opt-in is accepted but NOT idempotent",
    (network) => {
      expect(make({ network }, { allowNetwork: true }).idempotent).toBe(false);
    }
  );

  it("REFUSES freshPerRun: false unless allowReusedEnvironment: true", () => {
    expect(() => make({ freshPerRun: false })).toThrow(/allowReusedEnvironment/);
    expect(() => make({ freshPerRun: false }, { allowReusedEnvironment: false })).toThrow(
      /allowReusedEnvironment/
    );
    const effect = make({ freshPerRun: false }, { allowReusedEnvironment: true });
    // State carried between runs makes the result depend on history: not a pure function (D4).
    expect(effect.idempotent).toBe(false);
  });

  it("the opt-in is exactly `true`, not merely truthy", () => {
    expect(() => make({ network: "open" }, { allowNetwork: 1 as unknown as boolean })).toThrow(
      /allowNetwork/
    );
    expect(() =>
      make({ freshPerRun: false }, { allowReusedEnvironment: "yes" as unknown as boolean })
    ).toThrow(/allowReusedEnvironment/);
  });

  const malformed: [string, unknown][] = [
    ["missing", undefined],
    ["null", null],
    ["a string", "javascript"],
    ["empty language", { ...CAPS, language: "" }],
    ["no language", { ...CAPS, language: undefined }],
    ["unknown network", { ...CAPS, network: "maybe" }],
    ["no network", { ...CAPS, network: undefined }],
    ["unknown wallClock", { ...CAPS, wallClock: "medium" }],
    ["memory not boolean", { ...CAPS, memory: "yes" }],
    ["cpu missing", { ...CAPS, cpu: undefined }],
    ["freshPerRun missing", { ...CAPS, freshPerRun: undefined }],
  ];
  it.each(malformed)("REFUSES malformed capabilities: %s", (_name, caps) => {
    const backend = { capabilities: caps, evaluate: async () => ({ ok: true, value: 1 }) };
    expect(
      () =>
        new SandboxEffect(scripts, backend as unknown as SandboxBackend, {
          allowNetwork: true,
          allowReusedEnvironment: true,
        })
    ).toThrow(/capabilities/);
  });

  it("refuses something that is not a backend", () => {
    expect(() => new SandboxEffect(scripts, {} as unknown as SandboxBackend)).toThrow(/evaluate/);
    expect(() => new SandboxEffect(scripts, null as unknown as SandboxBackend)).toThrow(/evaluate/);
  });
});

describe("SandboxEffect — a backend that never settles (D2 deadline)", () => {
  const { ref, scripts } = store();
  const hang = (onRequest?: (r: SandboxRequest) => void) =>
    new FakeBackend((r) => {
      onRequest?.(r);
      return new Promise(() => {});
    });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number])(
    "backendGraceMs %s is refused at construction",
    (v) => {
      expect(() => new SandboxEffect(scripts, hang(), { backendGraceMs: v as number })).toThrow(
        /backendGraceMs/
      );
    }
  );

  it("gives up after wallClockMs + backendGraceMs with an UNTYPED error, and aborts the backend's signal", async () => {
    let sig: AbortSignal | undefined;
    const effect = new SandboxEffect(
      scripts,
      hang((r) => {
        sig = r.signal;
      }),
      { limits: { wallClockMs: 20 }, backendGraceMs: 30 }
    );
    const err = await failure(effect.execute({ scriptRef: ref }, ctx()));
    expect(err).not.toBeInstanceOf(TypedFailure);
    expect((err as Error).message).toMatch(/sandbox backend did not settle within 50ms/);
    expect(sig?.aborted).toBe(true);
  });

  it("a backend that REJECTS once its signal aborts (as fetch does) leaves no unhandled rejection", async () => {
    // The backend loses the race on abort and on the deadline, and a well-behaved one then rejects
    // with an AbortError nothing awaits any more. `Promise.race` subscribes to every input, so that
    // rejection is handled; this pins it, since a refactor away from `race` (e.g. a hand-rolled
    // settle-once) would crash a host running Node's default --unhandled-rejections=throw.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let settled = 0;
    let called = 0;
    const rejectsOnAbort: SandboxBackend = {
      capabilities: CAPS,
      evaluate: (r) =>
        new Promise((_, reject) => {
          called++;
          r.signal?.addEventListener("abort", () => {
            reject(new Error("AbortError"));
            settled++;
          });
        }),
    };
    try {
      const c = new AbortController();
      const aborted = new SandboxEffect(scripts, rejectsOnAbort).execute(
        { scriptRef: ref },
        ctx(c.signal)
      );
      // Abort only once the backend holds the call: aborting earlier never reaches it.
      await vi.waitFor(() => expect(called).toBe(1));
      c.abort(new Error("cancel"));
      await failure(aborted);
      const deadline = new SandboxEffect(scripts, rejectsOnAbort, {
        limits: { wallClockMs: 1 },
        backendGraceMs: 0,
      });
      await failure(deadline.execute({ scriptRef: ref }, ctx()));
      await vi.waitFor(() => expect(settled).toBe(2));
      // Unhandled rejections are reported after a macrotask turn.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("releases its timer and its listener on the caller's signal on every path", async () => {
    const c = new AbortController();
    const effect = new SandboxEffect(scripts, new FakeBackend(() => ({ ok: true, value: 1 })), {
      backendGraceMs: 60_000,
    });
    for (let i = 0; i < 3; i++) await effect.execute({ scriptRef: ref }, ctx(c.signal));
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
    const throwing = new SandboxEffect(
      scripts,
      new FakeBackend(() => {
        throw new Error("x");
      })
    );
    await failure(throwing.execute({ scriptRef: ref }, ctx(c.signal)));
    expect(getEventListeners(c.signal, "abort")).toHaveLength(0);
  });
});

describe("SandboxEffect — whatever a backend throws is never a channel and is bounded (D2)", () => {
  it("a TypedFailure thrown by a backend arrives UNTYPED", async () => {
    const { result } = await run(() => {
      throw new TypedFailure("limitExceeded", { kind: "memory" });
    });
    const err = await failure(result);
    expect(err).not.toBeInstanceOf(TypedFailure);
    expect((err as Error).message).toMatch(/typed failure/);
    expect((err as Error).cause).toBeInstanceOf(TypedFailure);
  });

  it("a 5 MB thrown message arrives bounded", async () => {
    const { result } = await run(() => {
      throw new Error("y".repeat(5_000_000));
    });
    const err = (await failure(result)) as Error;
    expect(err.message.length).toBeLessThanOrEqual(2048);
    expect(String(err).length).toBeLessThanOrEqual(2048 + 16);
  });

  it("lone surrogates and NUL in a thrown message are scrubbed", async () => {
    const { result } = await run(() => {
      throw new Error("a\uD800b\u0000c");
    });
    const err = (await failure(result)) as Error;
    expect(err.message).not.toMatch(/[\uD800-\uDFFF]/);
    expect(err.message).not.toContain("\u0000");
  });

  it("a non-Error thrown value is bounded too", async () => {
    const { result } = await run(() => {
      throw "z".repeat(1_000_000);
    });
    expect(((await failure(result)) as Error).message.length).toBeLessThanOrEqual(2048);
  });

  it("a small error of the backend's own class passes through, still instanceof", async () => {
    class StartupError extends Error {}
    const boom = new StartupError("worker never started");
    const { result } = await run(() => {
      throw boom;
    });
    expect(await failure(result)).toBe(boom);
  });

  it("a throwing outcome getter is bounded too", async () => {
    const { result } = await run(() => ({
      get ok(): boolean {
        throw new Error("t".repeat(100_000));
      },
    }));
    expect(((await failure(result)) as Error).message.length).toBeLessThanOrEqual(2048);
  });
});

describe("SandboxEffect — an outcome field is read ONCE (D2)", () => {
  it("a getter that is a string the first time and an object the second yields the first", async () => {
    let n = 0;
    const { result } = await run(() => ({
      ok: false,
      kind: "threw",
      get message() {
        return n++ === 0 ? "short" : {};
      },
    }));
    const err = channel(await failure(result), "scriptError");
    expect((err.payload as { message: string }).message).toBe("short");
  });
});
