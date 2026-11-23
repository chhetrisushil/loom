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
  effects: string[];
  leases: Record<string, LeaseSpec>;
  exp: number;
  epoch: number;
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
const MAX_SERIALIZED = 64 * 1024;
// No dots: lease `a` owns dimensions `lease.a`, `.reserved`, `.returned`; a name "a.reserved" must not collide.
const LEASE_NAME = /^[a-z][a-z0-9_-]{0,48}$/;
const GRANT_KEYS = [
  "taskId",
  "rootId",
  "parentId",
  "issuedTo",
  "effects",
  "leases",
  "exp",
  "epoch",
];
const LEASE_KEYS = ["ceiling", "effects"];
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
  const parentId = own(g, "parentId");
  if (parentId !== undefined) {
    idField(g, "parentId");
    if (rootId === taskId) fail("a child (parentId) must have a rootId different from taskId");
  } else if (rootId !== taskId) fail("a root grant must have rootId === taskId");
  const effects = effectList(own(g, "effects"), "effects", MAX_EFFECTS);
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
  return JSON.stringify({
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
const mac = (secret: string, g: UnsignedTaskGrant): string =>
  createHmac("sha256", secret)
    .update(VERSION_PREFIX + canonicalBody(g))
    .digest("hex");

function needSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length === 0) fail("secret must be a non-empty string");
}

/** Mint a grant: validates the shape, then signs EVERY field with HMAC-SHA256. */
export function signTaskGrant(secret: string, g: UnsignedTaskGrant): TaskGrant {
  needSecret(secret);
  const snap = snapshot(g, false);
  return { ...snap, sig: mac(secret, snap) } as TaskGrant;
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
export function verifyTaskGrant(secret: string, g: TaskGrant): TaskGrant | undefined {
  try {
    needSecret(secret);
    const snap = snapshot(g, true);
    const sig = snap.sig;
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return undefined;
    const { sig: _s, ...body } = snap;
    if (!timingSafeEqual(Buffer.from(mac(secret, body), "hex"), Buffer.from(sig, "hex")))
      return undefined;
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
