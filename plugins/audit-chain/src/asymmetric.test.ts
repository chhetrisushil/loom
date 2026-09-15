import { generateKeyPairSync } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { ed25519Signer, ed25519Verifier } from "./ed25519";
import { hashChainedEventStore } from "./hashChain";

// ── #382 — the verifier must not be able to write the log ────────────────────
//
// The HMAC chain is tamper-evident against someone without the secret. It cannot be
// third-party VERIFIABLE, because verification needs that same secret: anyone you enable to
// check the log can re-chain the hashes, re-compute the HMACs, and hand you a clean result.
// The verifier and the forger are the same role, which is precisely what an auditor is not.

const keys = () => generateKeyPairSync("ed25519");

function evt(
  executionId: string,
  sequence: number,
  payload: unknown = { n: sequence }
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    executionId,
    workflowId: "wf",
    eventType: sequence === 0 ? "EXECUTION_STARTED" : "STEP_COMPLETED",
    sequence,
    timestamp: 1_700_000_000_000 + sequence,
    payload,
  };
}

describe("#382 — an auditor can check the log without being able to author it", () => {
  it("verifies with the public key alone", async () => {
    const { privateKey, publicKey } = keys();
    const inner = new InMemoryAsyncEventStore();
    const signed = hashChainedEventStore(inner, { signer: ed25519Signer(privateKey, "k1") });
    for (let i = 0; i < 3; i++) await signed.append(evt("x", i));

    // The auditor's configuration: a verifier, and nothing else. No secret, no signer.
    const auditor = hashChainedEventStore(inner, {
      verifier: ed25519Verifier({ k1: publicKey }),
    });
    const result = await auditor.verifyChain("x");
    expect(result).toMatchObject({ ok: true, length: 3, signaturesChecked: true });
  });

  it("cannot be re-chained by someone holding only the verification key", async () => {
    // The HMAC failure, reproduced against the asymmetric chain: tamper an entry, re-chain
    // every hash after it, and re-sign — with the only key the forger has.
    const { privateKey, publicKey } = keys();
    const forger = keys(); // all an attacker can do is sign with a key nobody published
    const inner = new InMemoryAsyncEventStore();
    const signed = hashChainedEventStore(inner, { signer: ed25519Signer(privateKey, "k1") });
    for (let i = 0; i < 3; i++) await signed.append(evt("y", i));

    // Rewrite the durable rows exactly as a re-chaining attacker would.
    const rows = await inner.read("y");
    const tampered = new InMemoryAsyncEventStore();
    const rechain = hashChainedEventStore(tampered, {
      signer: ed25519Signer(forger.privateKey, "k1"), // claims to be k1; is not
    });
    for (const row of rows) {
      const { metadata: _chain, ...bare } = row;
      await rechain.append(bare.sequence === 1 ? { ...bare, payload: { n: 999 } } : bare);
    }
    // Internally consistent — the attacker did the job properly.
    const selfCheck = await rechain.verifyChain("y");
    expect(selfCheck.ok).toBe(true);

    // And worthless to anyone holding the published key.
    const auditor = hashChainedEventStore(tampered, {
      verifier: ed25519Verifier({ k1: publicKey }),
    });
    const audit = await auditor.verifyChain("y");
    expect(audit).toMatchObject({ ok: false, brokenAt: 0, signaturesChecked: true });
    expect(audit.reason).toMatch(/signature invalid/);
  });

  it("rejects an entry signed by a key it does not know, rather than skipping it", async () => {
    const { privateKey } = keys();
    const other = keys();
    const inner = new InMemoryAsyncEventStore();
    const signed = hashChainedEventStore(inner, { signer: ed25519Signer(privateKey, "k1") });
    await signed.append(evt("z", 0));

    const auditor = hashChainedEventStore(inner, {
      verifier: ed25519Verifier({ k2: other.publicKey }),
    });
    const result = await auditor.verifyChain("z");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown key/);
  });

  it("keeps history verifiable across a rotation", async () => {
    // Why revocation is not this issue's problem: an audit entry is a historical fact, so
    // verifying it against the key that signed it is correct forever.
    const a = keys();
    const b = keys();
    const inner = new InMemoryAsyncEventStore();
    await hashChainedEventStore(inner, { signer: ed25519Signer(a.privateKey, "2025") }).append(
      evt("r", 0)
    );
    await hashChainedEventStore(inner, { signer: ed25519Signer(b.privateKey, "2026") }).append(
      evt("r", 1)
    );

    const auditor = hashChainedEventStore(inner, {
      verifier: ed25519Verifier({ "2025": a.publicKey, "2026": b.publicKey }),
    });
    expect(await auditor.verifyChain("r")).toMatchObject({ ok: true, signaturesChecked: true });
  });

  it("flags an unsigned entry instead of passing it", async () => {
    const { publicKey } = keys();
    const inner = new InMemoryAsyncEventStore();
    await hashChainedEventStore(inner).append(evt("u", 0)); // hashed, not signed

    const auditor = hashChainedEventStore(inner, {
      verifier: ed25519Verifier({ k1: publicKey }),
    });
    const result = await auditor.verifyChain("u");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsigned/);
  });

  it("says when it checked no signatures at all, so `ok` cannot be over-read", async () => {
    const inner = new InMemoryAsyncEventStore();
    const plain = hashChainedEventStore(inner);
    for (let i = 0; i < 2; i++) await plain.append(evt("h", i));

    const result = await plain.verifyChain("h");
    // The hashes chain — a real result — but nothing was established about authorship.
    expect(result).toMatchObject({ ok: true, signaturesChecked: false });
  });

  it("refuses a configuration that makes two different promises", async () => {
    const { privateKey } = keys();
    expect(() =>
      hashChainedEventStore(new InMemoryAsyncEventStore(), {
        hmacSecret: "s3cret",
        signer: ed25519Signer(privateKey, "k1"),
      })
    ).toThrow(/mutually exclusive/);
  });
});
