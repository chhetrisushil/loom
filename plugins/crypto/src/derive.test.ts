import { sensitive } from "@loom/classify";
import { step$ } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { sensitivePathsFromSteps } from "./derive";
import { InMemoryKeyStore } from "./keystore";

const payoutStep = step$({
  id: "payout",
  inputSchema: z.object({ account: z.string() }),
  outputSchema: z.object({ ssn: sensitive(z.string()), ok: z.boolean() }),
});
const notifyStep = step$({
  id: "notify",
  inputSchema: z.object({ to: z.string() }),
  outputSchema: z.object({ email: sensitive(z.string()), sent: z.boolean() }),
});
const plainStep = step$({
  id: "plain",
  inputSchema: z.object({}),
  outputSchema: z.object({ count: z.number() }),
});

describe("sensitivePathsFromSteps (K10-R1)", () => {
  it("derives STEP_COMPLETED output paths from marked step schemas, unioned + deduped", () => {
    expect(sensitivePathsFromSteps([payoutStep, notifyStep, plainStep])).toEqual({
      STEP_COMPLETED: ["output.ssn", "output.email"],
    });
    // Same marked field across two steps collapses to one path.
    expect(sensitivePathsFromSteps([payoutStep, payoutStep])).toEqual({
      STEP_COMPLETED: ["output.ssn"],
    });
  });

  it("returns an empty map when nothing is marked (zero-overhead unwired path)", () => {
    expect(sensitivePathsFromSteps([plainStep])).toEqual({});
  });

  it("feeds EncryptingEventStore so a marked field is encrypted at rest end-to-end", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: sensitivePathsFromSteps([payoutStep]),
    });
    await store.append({
      id: "e0",
      workflowId: "wf",
      executionId: "x1",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      timestamp: 1,
      payload: { stepId: "payout", output: { ssn: "123-45-6789", ok: true } },
    });

    // At rest the ssn is ciphertext (an envelope), not the plaintext.
    const [raw] = await inner.read("x1");
    const rawSsn = (raw!.payload as { output: { ssn: unknown } }).output.ssn;
    expect(rawSsn).not.toBe("123-45-6789");
    // Reading back through the wrapper decrypts to the original plaintext.
    const [decrypted] = await store.read("x1");
    expect((decrypted!.payload as { output: { ssn: string } }).output.ssn).toBe("123-45-6789");
  });
});
