import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TaskGrantShapeError } from "./errors";

/** A side-effect lease: a ceiling over the listed effects (ADR 0150 D3). */
export interface LeaseSpec {
  ceiling: number;
  effects: readonly string[];
}

/** A signed, task-scoped grant (ADR 0150 D2). Every field is bound into `sig`. */
export interface TaskGrant {
  taskId: string;
  rootId: string;
  parentId?: string;
  issuedTo: string;
  /**
   * R30: the tenant the task runs in (opaque pseudonymous id, ADR 0111). Signed; the principal codec
   * restores it from this verified grant, and the log only holds the ref. Absent => not tenant-scoped.
   */
  tenant?: string;
  /** R30: the end user the task acts for (opaque pseudonymous id). The broker holds it; the app owns its erasure there. */
  onBehalfOf?: string;
  effects: string[];
  /**
   * ADR 0150 S-R4 (D8): globs over `<toolId>:<resource>` read capabilities this task may use. Governs EVERY effect that declares `capabilities.read`
   * (own-lineage reads are not exempt). Signed, and encoded only when present. Absent = no reads at all, for a read effect.
   * Enforced by `TaskGrantAuthorizer` (S6); a run with no task grant has no `reads` check.
   */
  reads?: string[];
  /**
   * ADR 0150 S-R4 (D10): `"isolated"` refuses a sandbox effect that is not network-less and fresh per run.
   * Signed, and encoded only when present. A child of an isolated task is isolated. Enforced from S8.
   */
  sandbox?: "isolated";
  leases: Record<string, LeaseSpec>;
  exp: number;
  epoch: number;
  /**
   * ADR 0150 D7 approval evidence (slice 2): the full sha256 hex hashes of the cross-lineage foreign sets a renewal
   * approved (`directedBy` `park`). Signed, encoded ONLY when present (a grant without it is byte-identical to before),
   * written only by a broker that granted a renewal request naming the set, kept across unrelated renewals.
   */
  approvedLineages?: string[];
  sig: string;
}
export type UnsignedTaskGrant = Omit<TaskGrant, "sig">;

// Mirrors CUSTOM_DIMENSION_PATTERN / CUSTOM_DIMENSION_CEILING in packages/replay-vm/src/eventHandlers.ts
// (the kernel owns them; a test asserts equality). Not imported: the kernel is not a dependency.
const DIMENSION_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CEILING_MAX = 1e15;
const MAX_ID = 256;
const MAX_EFFECTS = 256;
const MAX_EFFECT_LEN = 512;
const MAX_LEASES = 10;
/** S-R4: a `reads` entry may hold at most this many `*` (the matcher's cost grows with it). */
export const READS_MAX_STARS = 4;
/** S-R4: the total size of `reads` (sum of entry lengths); with the star cap, bounds a subset check at O(total^2) steps. */
export const READS_MAX_TOTAL = 16 * 1024;
// C1 controls, line/paragraph separators and bidi controls: invisible in a log line or an operator UI.
const READS_HIDDEN = /[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Most approved foreign sets a grant carries (the broker drops the oldest past it). */
export const MAX_APPROVALS = 16;
const MAX_SERIALIZED = 64 * 1024;
// No dots: lease `a` owns dimensions `lease.a`, `.reserved`, `.returned`; a name "a.reserved" must not collide.
const LEASE_NAME = /^[a-z][a-z0-9_-]{0,48}$/;
const GRANT_KEYS = [
  "taskId",
  "rootId",
  "parentId",
  "issuedTo",
  "tenant",
  "onBehalfOf",
  "effects",
  "reads",
  "sandbox",
  "leases",
  "exp",
  "epoch",
  "approvedLineages",
];
const LEASE_KEYS = ["ceiling", "effects"];
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
const VERSION_PREFIX = "tg1\n";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.hasOwn(o, k) ? o[k] : undefined;
const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function fail(msg: string): never {
  throw new TaskGrantShapeError(msg);
}
function onlyKeys(o: object, allowed: readonly string[], what: string): void {
  for (const k of Reflect.ownKeys(o))
    if (typeof k !== "string" || !allowed.includes(k))
      fail(`${what} has an unexpected key ${String(k)}`);
}
function idField(o: Record<string, unknown>, k: string): string {
  const v = own(o, k);
  if (typeof v !== "string" || v.length < 1 || v.length > MAX_ID)
    fail(`${k} must be a string of 1..${MAX_ID} chars`);
  return v;
}
function effectList(v: unknown, what: string, max: number): string[] {
  if (!Array.isArray(v) || v.length > max) fail(`${what} must be an array of at most ${max}`);
  for (const e of v)
    if (typeof e !== "string" || e.length < 1 || e.length > MAX_EFFECT_LEN || e === "*")
      fail(
        `${what} entries must be non-empty strings of at most ${MAX_EFFECT_LEN} chars, never "*"`
      );
  return v as string[];
}

/** Assert the structural bounds of an (unsigned or signed) grant; throws `TaskGrantShapeError`. */
export function validateGrantShape(g: unknown): asserts g is UnsignedTaskGrant {
  checkShape(g, false);
}
function checkShape(g: unknown, signed: boolean): void {
  if (!isObj(g)) fail("grant must be an object");
  onlyKeys(g, signed ? [...GRANT_KEYS, "sig"] : GRANT_KEYS, "grant");
  const taskId = idField(g, "taskId");
  const rootId = idField(g, "rootId");
  idField(g, "issuedTo");
  for (const k of ["tenant", "onBehalfOf"])
    if (own(g, k) !== undefined && CONTROL.test(idField(g, k)))
      fail(`${k} must not contain control characters`);
  const parentId = own(g, "parentId");
  if (parentId !== undefined) {
    idField(g, "parentId");
    if (rootId === taskId) fail("a child (parentId) must have a rootId different from taskId");
  } else if (rootId !== taskId) fail("a root grant must have rootId === taskId");
  const effects = effectList(own(g, "effects"), "effects", MAX_EFFECTS);
  const reads = own(g, "reads");
  if (reads !== undefined) {
    const list = effectList(reads, "reads", MAX_EFFECTS);
    if (new Set(list).size !== list.length) fail("reads entries must be unique");
    if (list.reduce((n, r) => n + r.length, 0) > READS_MAX_TOTAL)
      fail(`reads must total at most ${READS_MAX_TOTAL} chars`);
    for (const r of list) {
      if (CONTROL.test(r) || READS_HIDDEN.test(r))
        fail("reads entries must not contain control or invisible characters");
      // a literal tool id first, so no entry can match every capability (`**`, `*:*`, `:*`)
      const colon = r.indexOf(":");
      if (colon < 1 || r.lastIndexOf("*", colon) >= 0)
        fail('reads entries must be "<toolId>:<resource glob>" with a literal, non-empty tool id');
      if (r.split("*").length - 1 > READS_MAX_STARS)
        fail(`reads entries may hold at most ${READS_MAX_STARS} "*"`);
    }
  }
  const sandbox = own(g, "sandbox");
  if (sandbox !== undefined && sandbox !== "isolated") fail('sandbox must be "isolated"');
  const leases = own(g, "leases");
  if (!isObj(leases)) fail("leases must be an object");
  let count = 0;
  for (const k in leases) {
    if (Object.hasOwn(leases, k) && ++count > MAX_LEASES) fail(`at most ${MAX_LEASES} leases`);
  }
  onlyKeys(
    leases,
    Reflect.ownKeys(leases).filter((k): k is string => typeof k === "string"),
    "leases"
  );
  const names = Object.keys(leases);
  const allowed = new Set(effects);
  const leased = new Set<string>();
  for (const name of names) {
    if (!LEASE_NAME.test(name)) fail(`lease name "${name}" must match ${LEASE_NAME}`);
    for (const dim of [`lease.${name}`, `lease.${name}.reserved`, `lease.${name}.returned`])
      if (!DIMENSION_PATTERN.test(dim))
        fail(`lease name "${name}" does not fit the dimension pattern`);
    const spec = leases[name];
    if (!isObj(spec)) fail(`lease ${name} must be an object`);
    onlyKeys(spec, LEASE_KEYS, `lease ${name}`);
    const c = own(spec, "ceiling");
    if (typeof c !== "number" || !Number.isInteger(c) || c <= 0 || c > CEILING_MAX)
      fail(`lease ${name} ceiling must be a positive integer <= ${CEILING_MAX}`);
    const le = effectList(own(spec, "effects"), `lease ${name} effects`, MAX_EFFECTS);
    if (le.length === 0) fail(`lease ${name} effects must be non-empty`);
    if (!le.every((e) => allowed.has(e)))
      fail(`lease ${name} effects must be a subset of the grant's`);
    for (const e of le) {
      // R21: the effect context carries no resource in slice 1, so `<tool>:<resource>` could never match.
      if (e.includes(":")) fail(`lease ${name} effect "${e}" must not be resource-qualified`);
      if (leased.has(e)) fail(`effect "${e}" is listed in two leases (overlap)`);
      leased.add(e);
    }
  }
  if (!isNonNegInt(own(g, "exp"))) fail("exp must be a non-negative integer");
  if (!isNonNegInt(own(g, "epoch"))) fail("epoch must be a non-negative integer");
  const ap = own(g, "approvedLineages");
  if (
    ap !== undefined &&
    !(
      Array.isArray(ap) &&
      ap.length >= 1 &&
      ap.length <= MAX_APPROVALS &&
      ap.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) &&
      new Set(ap).size === ap.length
    )
  )
    fail(`approvedLineages must be 1..${MAX_APPROVALS} distinct sha256 hex strings`);
}

// Deterministic encoding: fixed field order, sorted string arrays, sorted lease names. Built only
// from own properties of validated input, so key order (or inherited keys) never reach the bytes.
function canonicalBody(g: UnsignedTaskGrant): string {
  const src = g as unknown as Record<string, unknown>;
  const leases: [string, { ceiling: number; effects: string[] }][] = Object.keys(g.leases)
    .sort()
    .map((n) => {
      const s = g.leases[n] as LeaseSpec;
      return [n, { ceiling: s.ceiling, effects: [...s.effects].sort() }];
    });
  // R30: identity is appended ONLY when present, so a grant without it encodes byte-identically to before.
  const identity: Record<string, string> = {};
  for (const k of ["onBehalfOf", "tenant"]) {
    const v = own(src, k);
    if (v !== undefined) identity[k] = v as string;
  }
  // S-R4: `reads` (sorted) and `sandbox` are likewise appended ONLY when present.
  const optional: Record<string, unknown> = {};
  const reads = own(src, "reads");
  if (reads !== undefined) optional.reads = [...(reads as string[])].sort();
  if (own(src, "sandbox") !== undefined) optional.sandbox = "isolated";
  const approved = own(src, "approvedLineages"); // ADR 0150 D7 approval evidence, likewise only when present
  if (approved !== undefined) optional.approvedLineages = [...(approved as string[])].sort();
  return JSON.stringify({
    ...identity,
    ...optional,
    effects: [...g.effects].sort(),
    epoch: g.epoch,
    exp: g.exp,
    issuedTo: g.issuedTo,
    leases,
    parentId: own(src, "parentId") ?? null,
    rootId: g.rootId,
    taskId: g.taskId,
  });
}
/**
 * S-R4: is the glob `child` covered by the glob `parent`? `*` matches any run of characters (including
 * `:`); every other character is literal. `child` is matched as a LITERAL string, so its own `*` must be
 * absorbed by a `*` in `parent`: sound (every string `child` matches, `parent` matches) and conservative.
 * Greedy two-pointer match, no regex (no exponential backtracking): at most O(|parent| * |child|) steps,
 * so a `reads` list within `READS_MAX_TOTAL` costs O(total^2) over all pairs. `meter` counts the steps.
 */
export function globCovers(parent: string, child: string, meter?: { steps: number }): boolean {
  let p = 0;
  let c = 0;
  let star = -1;
  let mark = 0;
  while (c < child.length) {
    if (meter) meter.steps++;
    if (parent[p] === "*") {
      star = p++;
      mark = c;
    } else if (p < parent.length && parent[p] === child[c]) {
      p++;
      c++;
    } else if (star >= 0) {
      p = star + 1;
      mark++;
      c = mark;
    } else return false;
  }
  while (parent[p] === "*") p++;
  return p === parent.length;
}
/** S-R4: the first reason `child` is not a subset of `parent`'s `reads` / `sandbox`, or `undefined`. */
export function widensReadsOrSandbox(
  parent: Pick<UnsignedTaskGrant, "reads" | "sandbox">,
  child: Pick<UnsignedTaskGrant, "reads" | "sandbox">,
  meter?: { steps: number }
): string | undefined {
  const bad = (child.reads ?? []).find(
    (r) => !(parent.reads ?? []).some((p) => globCovers(p, r, meter))
  );
  if (bad !== undefined) return `child reads "${bad}" exceeds the parent's reads`;
  if (parent.sandbox === "isolated" && child.sandbox !== "isolated")
    return "a child of an isolated task must be isolated";
  return undefined;
}

/**
 * One secret, or a rotation ring: sign/MAC with `current`; verify grants against `current` then
 * `previous`; `refOnly` keys verify a recorded REF MAC (`fromRef`) and are NEVER accepted for a grant
 * signature, so a retired key cannot mint authority. Retire a key in two steps: move it to `previous`;
 * once its grants have renewed onto `current` (or after the longest grant TTL) move it to `refOnly`, and
 * keep it there for the lifetime of any run started under it. Removing it entirely strands those runs.
 */
export type GrantKeys =
  | string
  | { current: string; previous?: readonly string[]; refOnly?: readonly string[] };
const MAX_PREVIOUS_KEYS = 8;

/**
 * Validates a {@link GrantKeys} and splits it: `sign` is the current key, `verify` is every key,
 * current first. Throws on a non-string or empty key, more than 8 previous keys, or `current` listed
 * in `previous`.
 */
export function keyRing(keys: GrantKeys): {
  sign: string;
  verify: readonly string[];
  ref: readonly string[];
} {
  const ring = (typeof keys === "string" ? { current: keys } : keys) as {
    current?: unknown;
    previous?: unknown;
    refOnly?: unknown;
  } | null;
  const cur = ring?.current;
  if (typeof cur !== "string" || cur.length === 0) fail("secret must be a non-empty string");
  // Each list is read EXACTLY ONCE (a custom iterator could yield different keys twice).
  const list = (v: unknown, what: string): string[] => {
    if (v === undefined) return [];
    if (typeof v === "string" || typeof (v as Iterable<unknown>)?.[Symbol.iterator] !== "function")
      fail(`${what} must be a list`);
    const out = Array.from(v as Iterable<unknown>);
    if (out.length > MAX_PREVIOUS_KEYS) fail(`at most ${MAX_PREVIOUS_KEYS} ${what} keys`);
    return out as string[];
  };
  const prev = list(ring?.previous, "previous");
  const refOnly = list(ring?.refOnly, "refOnly");
  const all = [cur as string, ...prev, ...refOnly];
  if (all.some((k) => typeof k !== "string" || k.length === 0) || new Set(all).size !== all.length)
    fail("keys must be non-empty and unique across current, previous and refOnly");
  return { sign: cur as string, verify: [cur as string, ...prev], ref: all };
}

/** Validate and COPY a key ring (a later mutation of the caller's object cannot change it). */
export function sealKeys(keys: GrantKeys): GrantKeys {
  const r = keyRing(keys);
  return Object.freeze({
    current: r.sign,
    previous: Object.freeze(r.verify.slice(1)),
    refOnly: Object.freeze(r.ref.slice(r.verify.length)),
  });
}

const mac = (secret: string, g: UnsignedTaskGrant): string =>
  createHmac("sha256", secret)
    .update(VERSION_PREFIX + canonicalBody(g))
    .digest("hex");

/** Mint a grant: validates the shape, then signs EVERY field with HMAC-SHA256. */
export function signTaskGrant(keys: GrantKeys, g: UnsignedTaskGrant): TaskGrant {
  const { sign } = keyRing(keys);
  const snap = snapshot(g, false);
  return { ...snap, sig: mac(sign, snap) } as TaskGrant;
}

// Detached plain-data copy (getters, toJSON, custom iterators, non-enumerables are resolved ONCE
// here), validated, so later reads cannot differ from what was checked.
function snapshot(g: unknown, signed: boolean): UnsignedTaskGrant & { sig?: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(g);
  } catch {
    fail("grant is not serializable");
  }
  if (text === undefined || text.length > MAX_SERIALIZED)
    fail("grant is not serializable or too large");
  const copy: unknown = JSON.parse(text);
  checkShape(copy, signed);
  return copy as UnsignedTaskGrant & { sig?: string };
}
function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const c of Object.values(v)) deepFreeze(c);
    Object.freeze(v);
  }
  return v;
}

/**
 * Constant-time verification. Returns a deep-frozen SNAPSHOT of exactly what was signed, or
 * `undefined` (never throws). Use the returned copy, never the input, for every later read.
 */
export function verifyTaskGrant(keys: GrantKeys, g: TaskGrant): TaskGrant | undefined {
  try {
    const { verify } = keyRing(keys);
    const snap = snapshot(g, true);
    const sig = snap.sig;
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return undefined;
    const { sig: _s, ...body } = snap;
    // Every key is compared (no early exit), so timing does not reveal WHICH key matched.
    let ok = false;
    for (const k of verify)
      ok = timingSafeEqual(Buffer.from(mac(k, body), "hex"), Buffer.from(sig, "hex")) || ok;
    if (!ok) return undefined;
    return deepFreeze(snap as TaskGrant);
  } catch {
    return undefined;
  }
}

/**
 * sha256 hex of the canonical encoding including the signature: a stable, non-bearer identifier.
 * Computed from a validated snapshot (not the live object); throws `TaskGrantShapeError` on a
 * malformed grant. It does not check the signature: pass a grant returned by `verifyTaskGrant`.
 */
export function taskGrantDigest(g: TaskGrant): string {
  const { sig, ...body } = snapshot(g, true);
  if (typeof sig !== "string") fail("sig must be a string");
  return createHash("sha256")
    .update(`${VERSION_PREFIX}${canonicalBody(body)}\n${sig}`)
    .digest("hex");
}
