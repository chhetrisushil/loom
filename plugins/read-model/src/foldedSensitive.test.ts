import { projection$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import { evt } from "./foldedFixtures";
import { sensitiveMapFromCovers } from "./sensitiveConfig";
import { SensitiveStateError } from "./sensitiveState";

const EMAIL = "alice@example.com";
const SENSITIVE = { STEP_COMPLETED: ["email"] };
const X = "u1:wf:ingest-d1";

interface S {
  steps: number;
  owner?: string | undefined; // exactOptionalPropertyTypes: the handler may return `undefined`
}
/** Copies ONE payload field into `owner`: the sealed `email`, its plain duplicate `mirror`, or the harmless `step`. */
const proj = (id: string, field: "email" | "mirror" | "step") =>
  projection$<S>({
    id,
    name: id,
    version: "1",
    initialState: { steps: 0 },
    handlers: {
      STEP_COMPLETED: (s, e) => ({
        ...s,
        steps: s.steps + 1,
        owner: (e.payload as Record<string, string>)[field],
      }),
    },
  });

async function logs() {
  const raw = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const enc = new EncryptingEventStore(raw, keys, {
    sensitive: SENSITIVE,
    subjectOf: (e) => e.executionId.split(":")[0] as string,
  });
  const events: EventEnvelope[] = [0, 1].map((i) =>
    evt(X, i, "STEP_COMPLETED", { step: `s${i}`, email: EMAIL, mirror: EMAIL })
  );
  for (const e of events) await enc.append(e);
  return { raw, enc, events };
}
const stateOf = async (s: ReadModelService, id: string) => (await s.getMany(id, [X])).get(X)?.state;

describe("sensitive-state guard — every feed presents the same masked input (D11)", () => {
  it("live, catch-up through the encrypting store, catch-up from the sealed raw log, refresh and rebuild agree, and none holds the secret", async () => {
    const { raw, enc, events } = await logs();
    const covers = enc.sealingCapability?.()?.covers ?? [];
    expect(covers).toContain("STEP_COMPLETED.email"); // the derivation path is real, not assumed
    const sensitive = sensitiveMapFromCovers(covers);
    const mk = async () => {
      const s = new ReadModelService(new InMemoryReadModelStore(), { sensitive });
      await s.registerFolded({ projection: proj("owner-email", "email") });
      return s;
    };
    const live = await mk();
    for (const e of events) live.handleEvent(e); // the runtime's plaintext events: no seal marker
    await live.drain();
    const viaEnc = await mk();
    await viaEnc.catchUp([enc]);
    const viaRaw = await mk(); // sealed at rest: envelopes + metadata.seal
    await viaRaw.catchUp([raw]);
    const refreshed = await mk();
    await refreshed.refresh("owner-email", [X], [enc]);
    const rebuilt = await mk(); // only rebuild: its own masking is load-bearing
    await rebuilt.rebuild("owner-email", [raw]);

    const expected = { steps: 2, owner: "[redacted]" };
    for (const s of [live, viaEnc, viaRaw, refreshed, rebuilt]) {
      expect(await stateOf(s, "owner-email")).toEqual(expected);
    }
  });

  it("a decrypted feed needs no declared map: the event's own seal marker is the only protection", async () => {
    const { enc } = await logs();
    const s = new ReadModelService(new InMemoryReadModelStore()); // NO declared map
    await s.registerFolded({ projection: proj("owner-email", "email") });
    await s.catchUp([enc]);
    expect(await stateOf(s, "owner-email")).toEqual({ steps: 2, owner: "[redacted]" });
  });

  it("ciphertext whose marker was stripped is still never handed to the fold", async () => {
    const { raw } = await logs();
    const stripped = {
      listExecutions: async () => (await raw.listExecutions?.()) ?? [],
      readFrom: async (id: string, from: number) =>
        (await raw.readFrom(id, from)).map(({ metadata: _m, ...e }) => e as EventEnvelope),
    };
    const s = new ReadModelService(new InMemoryReadModelStore());
    await s.registerFolded({ projection: proj("owner-email", "email") });
    await s.catchUp([stripped]);
    expect(await stateOf(s, "owner-email")).toEqual({ steps: 2, owner: "[redacted]" });
  });

  it("documented boundary (D11 f/g): live, no declared map, no seal marker -> the field reaches the handler as delivered", async () => {
    const { events } = await logs(); // plaintext live events carry no marker
    const s = new ReadModelService(new InMemoryReadModelStore()); // NO declared map: declare it to protect this
    await s.registerFolded({ projection: proj("owner-email", "email") });
    for (const e of events) s.handleEvent(e);
    await s.drain();
    expect(await stateOf(s, "owner-email")).toEqual({ steps: 2, owner: EMAIL });
  });
});

describe("sensitive-state guard — a lifted copy fails loudly on decrypted and live feeds (D11)", () => {
  it("catch-up throws, the live path reports, nothing is stored, and the message carries no value", async () => {
    const { enc, events } = await logs();
    const errs: unknown[] = [];
    const seen: EventEnvelope[] = [];
    const s = new ReadModelService(new InMemoryReadModelStore(), {
      sensitive: SENSITIVE,
      onError: (e, ev) => {
        errs.push(e);
        seen.push(ev);
      },
    });
    await s.registerFolded({ projection: proj("owner-mirror", "mirror") }); // copies the PLAIN duplicate

    const thrown = await s.catchUp([enc]).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(SensitiveStateError);
    for (const e of events) s.handleEvent(e);
    await s.drain();
    expect(errs[0]).toBeInstanceOf(SensitiveStateError);
    for (const e of [thrown, errs[0]] as SensitiveStateError[]) {
      expect(e).toMatchObject({ reason: "lifted-value", statePath: "$.owner" });
      expect(e.message).toContain("owner-mirror");
      expect(e.message).not.toContain(EMAIL);
      expect(JSON.stringify({ ...e, message: e.message, stack: e.stack })).not.toContain(EMAIL);
    }
    // onError's event argument withholds payload and metadata
    expect(seen.length).toBeGreaterThan(0);
    for (const ev of seen) {
      expect(JSON.stringify(ev)).not.toContain(EMAIL);
      expect(ev.payload).toBeNull();
    }
    expect((await s.getMany("owner-mirror", [X])).size).toBe(0); // the watermark never advanced
  });

  it("pinned limit (D11 f): an at-rest source cannot detect a lifted copy; the next live event is refused", async () => {
    // On the raw log the sealed `email` is an envelope, so there is no plaintext to compare a copy
    // against: catch-up stores the plain `mirror` duplicate. Masking still applies to the sealed field.
    // The live event carries the plaintext, so it IS caught and refused (watermark unchanged).
    const { raw } = await logs();
    const errs: unknown[] = [];
    const s = new ReadModelService(new InMemoryReadModelStore(), {
      sensitive: SENSITIVE,
      onError: (e) => errs.push(e),
    });
    await s.registerFolded({ projection: proj("owner-mirror", "mirror") });
    await s.catchUp([raw]); // succeeds
    expect(await stateOf(s, "owner-mirror")).toEqual({ steps: 2, owner: EMAIL });
    s.handleEvent(evt(X, 2, "STEP_COMPLETED", { step: "s2", email: EMAIL, mirror: EMAIL }));
    await s.drain();
    expect(errs[0]).toBeInstanceOf(SensitiveStateError);
    expect(await stateOf(s, "owner-mirror")).toEqual({ steps: 2, owner: EMAIL }); // unchanged
  });

  it("a safe fold over the same log is untouched (the guard has no false positive on plain fields)", async () => {
    const { enc } = await logs();
    const s = new ReadModelService(new InMemoryReadModelStore(), { sensitive: SENSITIVE });
    await s.registerFolded({ projection: proj("owner-step", "step") });
    await s.catchUp([enc]);
    expect(await stateOf(s, "owner-step")).toEqual({ steps: 2, owner: "s1" });
  });

  it("changing the declared sensitive paths rebuilds the model on the next registration", async () => {
    const store = new InMemoryReadModelStore();
    const first = new ReadModelService(store, { sensitive: SENSITIVE });
    expect(await first.registerFolded({ projection: proj("owner-step", "step") })).toEqual({
      rebuilt: false,
    });
    const second = new ReadModelService(store, {
      sensitive: { STEP_COMPLETED: ["email", "phone"] },
    });
    expect(await second.registerFolded({ projection: proj("owner-step", "step") })).toEqual({
      rebuilt: true,
    });
  });
});
