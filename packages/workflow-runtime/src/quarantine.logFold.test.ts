import { unwrapTainted } from "@loom/classify";
import { EncryptingSnapshotStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import {
  OP,
  SECRET,
  consumedOf,
  eventsByKind,
  keyOf,
  kindsOf,
  put,
  sealingStore,
} from "./__tests__/quarantineHarness";
import { inboxBackends } from "./__tests__/r2Backends";
import { build, echo, flow, until } from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { isSealedUnreadable } from "./sealGuard";
import { ExecutionDeniedError, InboxQuarantineRefusedError } from "./types";

// ADR 0130 D9, slice S5b - an INCAPABLE node's quarantine verbs when the checkpoint is SEALED (a
// `sealState` snapshot store on the capable node's keys). The incapable node shares the snapshot
// table, cannot open the checkpoint, and so used to be refused as an unknown owner on the very verb
// built for it. The verbs now fold the owner from the LOG when (and only when) the log is complete;
// a compacted log is a typed refusal; the general fold/replay on that node still refuses (D7).

const [memory] = inboxBackends("quarantine-logfold");

async function scene(opts: { warm?: boolean } = {}) {
  const raw = memory.make();
  const keys = new InMemoryKeyStore();
  const sealing = sealingStore(raw.eventStore, keys);
  const sealedSnaps = new EncryptingSnapshotStore(raw.snapshotStore, keys, { sealState: true });
  const a = build(
    { inboxAutoRelease: false },
    { ...raw, eventStore: sealing, snapshotStore: sealedSnaps }
  );
  // The INCAPABLE node: no crypto at all, but it shares the (sealed) snapshot table with `a`.
  const b = build({}, { ...raw });
  // `warm` runs two plaintext steps first, so the log has events between the start and the park
  // to compact away (the inbox kinds are the only sealed ones in this fleet).
  const f = flow("lf", async (ctx) => {
    if (opts.warm === true) {
      await ctx.run(echo, {});
      await ctx.run(echo, {});
    }
    const got: Array<[string, unknown]> = [];
    while (got.length < 3) {
      const r = await ctx.select<unknown>([{ inbox: "a" }, { inbox: "b" }]);
      got.push([r.arm === 0 ? "a" : "b", unwrapTainted(r.value)]);
    }
    return got;
  });
  a.rt.registerFlow(f.definition, f.runner);
  b.rt.registerFlow(f.definition, f.runner);
  const e = `logfold-${Math.random().toString(36).slice(2, 8)}`;
  await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
  await until(async () => (await a.rt.loadState(e))?.status === "suspended");
  await a.rt.notifyInbox(e);
  await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: { ssn: SECRET } });
  await put(raw.eventStore, e, { topic: "a", messageId: "a2", payload: "plain-a2" });
  await put(raw.eventStore, e, { topic: "b", messageId: "b1", payload: "plain-b1" });
  return { raw, keys, a, b, e, f };
}

describe("quarantineInbox / releaseInbox on an incapable node with a SEALED checkpoint (S5b)", () => {
  it("precondition: the checkpoint really is sealed and the incapable node's general fold refuses it (D7 unchanged)", async () => {
    const s = await scene();
    const raw = await s.raw.snapshotStore.loadLatest(s.e);
    expect(raw).not.toBeNull();
    expect(JSON.stringify(raw?.state)).toContain("__loomEnc");
    const refusal = await s.b.rt.loadState(s.e).catch((x) => x);
    expect(isSealedUnreadable(refusal)).toBe(true);
  });

  it("quarantines the sealed head by folding the owner from the log; the general fold on that node still refuses", async () => {
    const s = await scene();
    const res = await s.b.rt.quarantineInbox(
      s.e,
      { topic: "a", reason: "no key" },
      { principal: OP }
    );
    expect(res).toMatchObject({ executionId: s.e, topic: "a", messageId: "a1", inboxSeq: 0 });
    expect(await eventsByKind(s.raw.eventStore, s.e, "INBOX_QUARANTINED")).toHaveLength(1);
    // D7 unchanged: loadState / notify on b are still refused, never served from the log.
    expect(isSealedUnreadable(await s.b.rt.loadState(s.e).catch((x) => x))).toBe(true);
    // the capable node folds the hold and delivers the other topic
    await s.a.rt.notifyInbox(s.e).catch(() => undefined);
    await until(async () =>
      consumedOf(await s.raw.eventStore.read(s.e)).some((c) => c.messageId === keyOf("b1"))
    );
    const held = (await s.a.rt.loadState(s.e))?.variables._quarantined as Record<string, unknown[]>;
    expect(held.a).toHaveLength(1);
  });

  it("release DELIVER of a sealed message is still refused on the incapable node (the copy is unopenable there), appends nothing; the capable node then delivers in order", async () => {
    const s = await scene();
    await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    const before = await kindsOf(s.raw.eventStore, s.e);
    const refused = await s.b.rt
      .releaseInbox(s.e, { topic: "a", messageId: "a1", disposition: "deliver" }, { principal: OP })
      .catch((x) => x);
    expect(isSealedUnreadable(refused)).toBe(true);
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
    const r = await s.a.rt.releaseInbox(
      s.e,
      { topic: "a", messageId: "a1", disposition: "deliver" },
      { principal: OP }
    );
    expect(r).toMatchObject({ disposition: "deliver", changed: true });
    await until(async () => (await s.a.rt.loadState(s.e))?.status === "completed", 15_000);
    expect((await s.a.rt.loadState(s.e))?.variables._output).toEqual([
      ["a", { ssn: SECRET }],
      ["a", "plain-a2"],
      ["b", "plain-b1"],
    ]);
  });

  it("releases (discard) the held message from the incapable node", async () => {
    const s = await scene();
    await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    const r = await s.b.rt.releaseInbox(
      s.e,
      { topic: "a", messageId: "a1", disposition: "discard" },
      { principal: OP }
    );
    expect(r).toMatchObject({ disposition: "discard", changed: true });
    const [rel] = await eventsByKind(s.raw.eventStore, s.e, "INBOX_RELEASED");
    expect(rel?.payload).toMatchObject({ disposition: "discard", operator: OP });
  });

  it("a COMPACTED log (gap after sequence 0) is a typed refusal that names the fix, and appends nothing", async () => {
    const s = await scene({ warm: true });
    const before = await kindsOf(s.raw.eventStore, s.e);
    expect(before.length).toBeGreaterThan(2);
    await s.raw.eventStore.truncatePrefix?.(s.e, 1);
    const kinds = await kindsOf(s.raw.eventStore, s.e);
    const err = await s.b.rt
      .quarantineInbox(s.e, { topic: "a" }, { principal: OP })
      .catch((x) => x);
    expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(err.reason).toBe("checkpoint-unreadable-log-compacted");
    expect(err.retryable).toBe(false);
    expect(String(err.message)).toMatch(/capable node/);
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(kinds);
    const rel = await s.b.rt
      .releaseInbox(s.e, { topic: "a", messageId: "a1" }, { principal: OP })
      .catch((x) => x);
    expect(rel).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(rel.reason).toBe("checkpoint-unreadable-log-compacted");
    // the capable node is unaffected by the refusal
    expect(await eventsByKind(s.raw.eventStore, s.e, "INBOX_QUARANTINED")).toHaveLength(0);
  });

  it("a log compacted all the way to [0] (checkpoint above the tip) is refused too", async () => {
    const s = await scene({ warm: true });
    const tip = (await s.raw.eventStore.read(s.e)).at(-1)?.sequence as number;
    await s.raw.eventStore.truncatePrefix?.(s.e, tip);
    expect(await kindsOf(s.raw.eventStore, s.e)).toHaveLength(1);
    const err = await s.b.rt
      .quarantineInbox(s.e, { topic: "a" }, { principal: OP })
      .catch((x) => x);
    expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(err.reason).toBe("checkpoint-unreadable-log-compacted");
  });

  it("authz is unchanged: a stranger gets the ordinary denial before any fold, the tenant's operator is served from the log", async () => {
    const raw = memory.make();
    const keys = new InMemoryKeyStore();
    const sealing = sealingStore(raw.eventStore, keys);
    const snaps = new EncryptingSnapshotStore(raw.snapshotStore, keys, { sealState: true });
    const deps = {
      executionAuthorizer: executionAccessPolicy({
        rules: { quarantine: "tenant", release: "tenant" },
      }),
      executionAuthz: { requirePrincipal: true },
    };
    const a = build(
      { ...deps, inboxAutoRelease: false },
      { ...raw, eventStore: sealing, snapshotStore: snaps }
    );
    const b = build(deps, { ...raw });
    const f = flow("lf-authz", async (ctx) => unwrapTainted(await ctx.receive<unknown>("a")));
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = "logfold-authz";
    const owner = { actor: "alice", tenant: "t1" };
    await (await a.rt.start(f, {}, { executionId: e, principal: owner })).waitForSuspend();
    await until(async () => (await raw.snapshotStore.loadLatest(e)) !== null);
    await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: { ssn: SECRET } });
    const before = await kindsOf(raw.eventStore, e);
    const err = await b.rt
      .quarantineInbox(e, { topic: "a" }, { principal: { actor: "mallory", tenant: "t2" } })
      .catch((x) => x);
    expect(err).toBeInstanceOf(ExecutionDeniedError);
    expect(err).not.toBeInstanceOf(InboxQuarantineRefusedError);
    expect(await kindsOf(raw.eventStore, e)).toEqual(before);
    const ok = await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    expect(ok.messageId).toBe("a1");
  });

  it("a capable node is unaffected (it folds the sealed checkpoint as before)", async () => {
    const s = await scene();
    // a is capable but the message is openable: not-sealed, nothing appended
    const err = await s.a.rt
      .quarantineInbox(s.e, { topic: "a" }, { principal: OP })
      .catch((x) => x);
    expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(err.reason).toBe("not-sealed");
  });
});
