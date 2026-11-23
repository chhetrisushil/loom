// ADR 0152 D1 (R11, R13) - the WRITER side of `_seenOrigins`: the walk runs ONCE, at the journal commit
// (`stampSeenOrigins`, only for a tracked run), and its result is recorded on the event's metadata
// (`origins`, `originsOverflow`) for the fold to union. The same record function serves the one-time upgrade
// rescan of pre-1.27 events. A caller-supplied `origins` / `originsOverflow` is never kept.
//
// TWO walks: the COMMIT walk is over the LIVE structure (the flow is handed the live output, not its JSON image) and
// fails closed on anything it cannot walk faithfully; the JSON-view walk is for the rescan of stored events.
// CAVEATS (read before editing the journal): the live walk runs synchronously INSIDE the commit and reads descriptors,
// never accessor values, so user code is not invoked; a re-entrant commit is not supported; a value mutated after the
// commit is not rescanned (the log records what the run was shown at commit).
import type { EventEnvelope, ExecutionState } from "@loomwork/core";
import {
  isKernelWritten,
  isPlain,
  isStatusOnlyResume,
  parseWaitResume,
  safeMapKey,
} from "./eventHandlers";
import { CHANNELS, SEEN_ORIGINS_KEY, capOrigin, startKey, validKey } from "./seenOrigins";

const SEEN_SCAN_MAX_DEPTH = 64;

const isBoxed = (v: object): boolean =>
  v instanceof Number || v instanceof String || v instanceof Boolean;

/**
 * Walk the JSON VIEW of `root` (what `JSON.stringify` would serialise) for classify's wrapper
 * `{ __loomTainted: { origin }, value }`. Iterative, depth pinned at 64, cycle detection only (no shared-reference
 * dedupe: a JSON round trip changes identity), key-order independent. Returns the sorted, capped, deduped origins,
 * or `undefined` when the walk exceeded a bound (the caller keeps NO partial origins).
 */
export function scanSeenOriginsJson(root: unknown, maxNodes: number): string[] | undefined {
  if (root === null || typeof root !== "object") return [];
  const found = new Set<string>();
  const ancestors = new Set<object>();
  type Entry = { v: object; d: number; exit?: true };
  const stack: Entry[] = [{ v: root, d: 0 }];
  let nodes = 0;
  try {
    while (stack.length > 0) {
      const e = stack.pop() as Entry;
      if (e.exit === true) {
        ancestors.delete(e.v);
        continue;
      }
      let v: object = e.v;
      if (++nodes > maxNodes || e.d > SEEN_SCAN_MAX_DEPTH) return undefined;
      const toJSON = (v as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") {
        const r: unknown = toJSON.call(v);
        if (r === null || typeof r !== "object") continue;
        v = r;
      }
      if (isBoxed(v)) continue;
      if (ancestors.has(v)) return undefined;
      let children: unknown[];
      if (Array.isArray(v)) {
        children = v;
      } else {
        const mark = (v as Record<string, unknown>).__loomTainted;
        if (isPlain(mark) && typeof mark.origin === "string" && Object.hasOwn(v, "value")) {
          found.add(capOrigin(mark.origin));
        }
        children = Object.values(v);
      }
      ancestors.add(v);
      stack.push({ v, d: e.d, exit: true });
      for (const c of children) {
        if (c === null || typeof c !== "object") {
          if (++nodes > maxNodes) return undefined;
        } else stack.push({ v: c, d: e.d + 1 });
      }
    }
  } catch {
    return undefined; // a throwing getter / toJSON: not provably clean
  }
  return [...found].sort();
}

/**
 * The COMMIT walk: the LIVE structure, classify's `isTainted` predicate on every own enumerable data value BEFORE any `toJSON`,
 * plus `Map` / `Set` entries. `undefined` (the caller records overflow ONLY, no partial origins) when it cannot walk faithfully:
 * a `toJSON` other than `Date`'s, an accessor, a non-enumerable or symbol-keyed own property, a non-plain prototype, a cycle, a
 * depth over 64 or more than `maxNodes` nodes. `ArrayBuffer` and its views are skipped (as `scanTaint` does).
 */
export function scanSeenOriginsLive(root: unknown, maxNodes: number): string[] | undefined {
  if (root === null || typeof root !== "object") return [];
  const found = new Set<string>();
  const ancestors = new Set<object>();
  type Entry = { v: object; d: number; exit?: true };
  const stack: Entry[] = [{ v: root, d: 0 }];
  let nodes = 0;
  const push = (c: unknown, d: number): boolean => {
    if (c === null || typeof c !== "object") return ++nodes <= maxNodes;
    stack.push({ v: c, d });
    return true;
  };
  try {
    while (stack.length > 0) {
      const e = stack.pop() as Entry;
      if (e.exit === true) {
        ancestors.delete(e.v);
        continue;
      }
      const v = e.v;
      if (++nodes > maxNodes || e.d > SEEN_SCAN_MAX_DEPTH) return undefined;
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
      if (ancestors.has(v)) return undefined;
      const proto = Object.getPrototypeOf(v) as object | null;
      // a Date is a leaf only with no own key (an own property could hold a wrapper the flow reads)
      if (proto === Date.prototype && v instanceof Date) {
        if (Reflect.ownKeys(v).length > 0) return undefined;
        continue;
      }
      const isArr = proto === Array.prototype && Array.isArray(v);
      const isMap = proto === Map.prototype && v instanceof Map;
      const isSet = proto === Set.prototype && v instanceof Set;
      if (!isArr && !isMap && !isSet && proto !== Object.prototype && proto !== null)
        return undefined;
      ancestors.add(v);
      stack.push({ v, d: e.d, exit: true });
      let mark: unknown;
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key === "symbol") return undefined;
        if (isArr && key === "length") continue;
        const desc = Object.getOwnPropertyDescriptor(v, key) as PropertyDescriptor;
        if (desc.get !== undefined || desc.set !== undefined || desc.enumerable !== true)
          return undefined;
        if (key === "toJSON" && typeof desc.value === "function") return undefined;
        if (key === "__loomTainted") mark = desc.value;
        if (!push(desc.value, e.d + 1)) return undefined;
      }
      if (isMap)
        for (const [k, x] of v as Map<unknown, unknown>)
          if (!push(k, e.d + 1) || !push(x, e.d + 1)) return undefined;
      if (isSet) for (const x of v as Set<unknown>) if (!push(x, e.d + 1)) return undefined;
      if (typeof mark === "object" && mark !== null && "value" in v) {
        const origin = Object.getOwnPropertyDescriptor(mark, "origin")?.value;
        if (typeof origin === "string") found.add(capOrigin(origin));
      }
    }
  } catch {
    return undefined;
  }
  return [...found].sort();
}

type Meta = Record<string, unknown> | undefined;

/** What a channel feeds in: the scan root and any fixed origin the channel itself attests. `before` is the state the fold's handler sees. */
function channel(
  before: ExecutionState | undefined,
  eventType: string,
  payload: unknown,
  metadata: Meta
): { root: unknown; origin?: string } | undefined {
  const p = payload as Record<string, unknown> | undefined;
  switch (eventType) {
    case "STEP_COMPLETED":
      return { root: p?.output };
    case "EXECUTION_STARTED":
      return { root: p?.input };
    case "DECISION_RECORDED":
      return { root: p?.choice };
    case "EXECUTION_MIGRATED":
      return { root: p?.migratedInput };
    case "STEP_FAILED":
      return p?.channel !== undefined ? { root: p.payload } : undefined;
  }
  if (before === undefined) return undefined;
  const ev = { eventType, payload, metadata } as unknown as EventEnvelope;
  switch (eventType) {
    case "PARALLEL_COMPLETED":
      return isKernelWritten(ev) && isPlain(p) && safeMapKey(p.scopePath)
        ? { root: p.errorPayload }
        : undefined;
    case "MESSAGE_CONSUMED": {
      if (!isKernelWritten(ev) || !isPlain(p)) return undefined;
      if (
        !safeMapKey(p.waitId) ||
        !safeMapKey(p.topic) ||
        typeof p.messageId !== "string" ||
        !Number.isSafeInteger(p.inboxSeq) ||
        (p.inboxSeq as number) < 0
      ) {
        return undefined;
      }
      const prior = (before.variables._inbox as { dedupe?: string[] } | undefined)?.dedupe;
      return prior?.includes(p.messageId) === true
        ? undefined
        : { root: p.payload, origin: capOrigin(`inbox:${p.topic}`) };
    }
    case "EXECUTION_RESUMED": {
      const addressed = parseWaitResume(before, ev);
      if (addressed !== undefined) return addressed.answer ? { root: addressed.inner } : undefined;
      return payload !== undefined && !isStatusOnlyResume(before, payload)
        ? { root: payload }
        : undefined;
    }
    default:
      return undefined;
  }
}

export interface SeenOriginsRecord {
  origins?: string[];
  originsOverflow?: true;
}

/**
 * The record of one event, scanned against `before` (the state the event folds onto; `undefined` for the
 * sequence-0 start, whose tracking comes from its own stamp or carry). `undefined` = nothing to record: the run is untracked
 * or already overflowed, or the event is not a channel. A TRACKED run records on EVERY channel event (R13): `origins: []` when
 * the value is clean or not scanned, since the fold reads a channel event with no record as overflow. A bound exceeded, an
 * unfaithful walk, or more than `maxOrigins` distinct origins records `originsOverflow` ONLY (partial origins are dropped).
 * `view` "live" is the commit; "json" is the upgrade rescan of a stored event.
 */
export function seenOriginsRecord(
  before: ExecutionState | undefined,
  eventType: string,
  payload: unknown,
  metadata: Meta,
  view: "live" | "json" = "live"
): SeenOriginsRecord | undefined {
  if (!CHANNELS.has(eventType)) return undefined;
  const key =
    eventType === "EXECUTION_STARTED"
      ? startKey({ eventType, payload, metadata } as unknown as EventEnvelope)
      : before?.variables[SEEN_ORIGINS_KEY];
  if (!validKey(key) || key.overflow === true) return undefined;
  const ch = channel(before, eventType, payload, metadata);
  if (ch === undefined) return { origins: [] };
  const found = (view === "live" ? scanSeenOriginsLive : scanSeenOriginsJson)(
    ch.root,
    key.limits.maxScanNodes
  );
  if (found === undefined) return { originsOverflow: true };
  const all = ch.origin === undefined ? found : [...new Set(found).add(ch.origin)].sort();
  return all.length > key.limits.maxOrigins ? { originsOverflow: true } : { origins: all };
}

/**
 * The journal's envelope-metadata step: drop any caller-supplied `origins` / `originsOverflow` on a CHANNEL event (the field is the
 * kernel's alone there, like the `kernel` stamp; application metadata on any other event is left byte-untouched), then add the record of this event. Returns `metadata` untouched
 * (same object) when there is nothing to record: an untracked or overflowed run, or a non-channel event.
 */
export function stampSeenOrigins(
  before: ExecutionState | undefined,
  eventType: string,
  payload: unknown,
  metadata: Meta
): Meta {
  let meta = metadata;
  if (
    meta !== undefined &&
    CHANNELS.has(eventType) &&
    (Object.hasOwn(meta, "origins") || Object.hasOwn(meta, "originsOverflow"))
  ) {
    const { origins: _o, originsOverflow: _f, ...rest } = meta;
    meta = rest;
  }
  const rec = seenOriginsRecord(before, eventType, payload, meta);
  return rec === undefined ? meta : { ...meta, ...rec };
}
