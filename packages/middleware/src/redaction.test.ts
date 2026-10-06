import { secret } from "@loom/classify";
import { step$ } from "@loom/core";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  InMemorySecretResolver,
  isSecretRef,
  redactOutputFrom,
  redactionMiddleware,
  secretOutputPathsByStep,
  secretRef,
} from "./redaction";

function ctx(emit = vi.fn()): EffectContext {
  return { executionId: "e1", workflowId: "wf", stepId: "charge", attempt: 1, emit };
}

describe("K10.3 — redaction markers (secrets never enter the log)", () => {
  it("resolves input secret references to the real value the tool sees — the ref is what was logged", async () => {
    const resolver = new InMemorySecretResolver(new Map([["stripe-key", "sk_live_REAL"]]));
    const mw = redactionMiddleware({ resolver });

    // What the flow passed as input (and what STEP_STARTED logged): a REFERENCE.
    const loggedInput = { amount: 42, apiKey: secretRef("stripe-key") };
    let toolSaw: unknown;
    const result = await mw(ctx(), loggedInput, async (resolved) => {
      toolSaw = resolved;
      return { ok: true };
    });

    // The tool received the resolved secret…
    expect((toolSaw as { apiKey: string }).apiKey).toBe("sk_live_REAL");
    expect((toolSaw as { amount: number }).amount).toBe(42);
    // …but the logged input object was NOT mutated — it still holds the reference.
    expect(isSecretRef(loggedInput.apiKey)).toBe(true);
    expect(loggedInput.apiKey).toEqual({ __loomSecret: "stripe-key" });
    expect(result).toEqual({ ok: true });
  });

  it("resolves references nested in arrays/objects", async () => {
    const resolver = new InMemorySecretResolver(
      new Map([
        ["a", "secretA"],
        ["b", "secretB"],
      ])
    );
    const mw = redactionMiddleware({ resolver });
    let seen: unknown;
    await mw(ctx(), { creds: [secretRef("a"), { token: secretRef("b") }] }, async (r) => {
      seen = r;
      return {};
    });
    expect(seen).toEqual({ creds: ["secretA", { token: "secretB" }] });
  });

  it("redacts marked OUTPUT fields into deterministic references — the secret never reaches the log", async () => {
    const resolver = new InMemorySecretResolver();
    const mw = redactionMiddleware({
      resolver,
      redactOutput: () => ["credentials.password"],
    });

    // The tool returns a freshly-minted secret; the LOGGED output must not contain it.
    const logged = await mw(ctx(), {}, async () => ({
      user: "svc",
      credentials: { username: "svc", password: "generated-secret-99" },
    }));

    const ref = (logged as { credentials: { password: unknown } }).credentials.password;
    expect(isSecretRef(ref)).toBe(true);
    expect((ref as { __loomSecret: string }).__loomSecret).toBe("e1:charge:credentials.password");
    // The real value lives only in the resolver, addressed by the deterministic ref.
    expect(resolver.resolve("e1:charge:credentials.password")).toBe("generated-secret-99");
    // Unmarked fields pass through untouched.
    expect((logged as { user: string }).user).toBe("svc");
  });

  it("output redaction requires a writable resolver", async () => {
    const readOnly = { resolve: () => "x" };
    const mw = redactionMiddleware({ resolver: readOnly, redactOutput: () => ["secret"] });
    await expect(mw(ctx(), {}, async () => ({ secret: "v" }))).rejects.toThrow(/requires.*store/);
  });

  it("G2 — no references and no redactOutput ⇒ a transparent pass-through", async () => {
    const mw = redactionMiddleware({ resolver: new InMemorySecretResolver() });
    let seen: unknown;
    const out = await mw(ctx(), { plain: 1 }, async (r) => {
      seen = r;
      return { done: true };
    });
    expect(seen).toEqual({ plain: 1 });
    expect(out).toEqual({ done: true });
  });
});

describe("K10-R2 — derive output redaction from secret() marks", () => {
  it("builds a stepId → secret-output-paths map, skipping unmarked steps", () => {
    const charge = step$({
      id: "charge",
      inputSchema: z.object({ amount: z.number() }),
      outputSchema: z.object({ token: secret(z.string()), ok: z.boolean() }),
    });
    const log = step$({
      id: "log",
      inputSchema: z.object({}),
      outputSchema: z.object({ line: z.string() }),
    });
    const byStep = secretOutputPathsByStep([charge, log]);
    expect(byStep.get("charge")).toEqual(["token"]);
    expect(byStep.has("log")).toBe(false); // no secret field → omitted (G2)

    const redactOutput = redactOutputFrom(byStep);
    expect(redactOutput({ stepId: "charge" })).toEqual(["token"]);
    expect(redactOutput({ stepId: "log" })).toEqual([]); // unknown/unmarked → no paths
  });

  it("drives redactionMiddleware end-to-end: a secret() output field is logged as a ref", async () => {
    const charge = step$({
      id: "charge",
      inputSchema: z.object({}),
      outputSchema: z.object({ token: secret(z.string()), ok: z.boolean() }),
    });
    const resolver = new InMemorySecretResolver();
    const mw = redactionMiddleware({
      resolver,
      redactOutput: redactOutputFrom(secretOutputPathsByStep([charge])),
    });

    const logged = await mw(ctx(), {}, async () => ({ token: "sk_live_MINTED", ok: true }));
    const ref = (logged as { token: unknown }).token;
    expect(isSecretRef(ref)).toBe(true);
    expect(resolver.resolve("e1:charge:token")).toBe("sk_live_MINTED");
    expect((logged as { ok: boolean }).ok).toBe(true);
  });
});

describe("ADR 0119 — output redaction declares inspectsOutput", () => {
  it("is marked when redactOutput is configured (deltas would bypass the mask) and not otherwise", () => {
    const resolver = new InMemorySecretResolver();
    expect(redactionMiddleware({ resolver, redactOutput: () => ["token"] }).inspectsOutput).toBe(
      true
    );
    expect(redactionMiddleware({ resolver }).inspectsOutput).toBeUndefined();
  });
});
