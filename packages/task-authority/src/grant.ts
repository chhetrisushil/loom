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
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);
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
  if (!isObj(g)) fail("grant must be an object");
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
  const names = Object.keys(leases);
  if (names.length > MAX_LEASES) fail(`at most ${MAX_LEASES} leases`);
  const allowed = new Set(effects);
  for (const name of names) {
    if (FORBIDDEN_NAMES.has(name)) fail(`lease name ${name} is forbidden`);
    for (const dim of [`lease.${name}`, `lease.${name}.reserved`, `lease.${name}.returned`])
      if (!DIMENSION_PATTERN.test(dim))
        fail(`lease name "${name}" does not fit the dimension pattern`);
    const spec = leases[name];
    if (!isObj(spec)) fail(`lease ${name} must be an object`);
    const c = own(spec, "ceiling");
    if (typeof c !== "number" || !Number.isInteger(c) || c <= 0 || c > CEILING_MAX)
      fail(`lease ${name} ceiling must be a positive integer <= ${CEILING_MAX}`);
    const le = effectList(own(spec, "effects"), `lease ${name} effects`, MAX_EFFECTS);
    if (le.length === 0) fail(`lease ${name} effects must be non-empty`);
    if (!le.every((e) => allowed.has(e)))
      fail(`lease ${name} effects must be a subset of the grant's`);
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

/** Mint a grant: validates the shape, then signs EVERY field with HMAC-SHA256. */
export function signTaskGrant(secret: string, g: UnsignedTaskGrant): TaskGrant {
  validateGrantShape(g);
  const { parentId } = g;
  const leases: Record<string, LeaseSpec> = {};
  for (const n of Object.keys(g.leases).sort()) {
    const s = g.leases[n] as LeaseSpec;
    leases[n] = { ceiling: s.ceiling, effects: [...s.effects] };
  }
  const clean: UnsignedTaskGrant = {
    taskId: g.taskId,
    rootId: g.rootId,
    ...(parentId !== undefined && { parentId }),
    issuedTo: g.issuedTo,
    effects: [...g.effects],
    leases,
    exp: g.exp,
    epoch: g.epoch,
  };
  return { ...clean, sig: mac(secret, clean) };
}

/** Constant-time verification; malformed input returns false and never throws. */
export function verifyTaskGrant(secret: string, g: TaskGrant): boolean {
  try {
    validateGrantShape(g);
    const sig = own(g as unknown as Record<string, unknown>, "sig");
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
    return timingSafeEqual(Buffer.from(mac(secret, g), "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

/** sha256 hex of the canonical encoding including the signature: a stable, non-bearer identifier. */
export function taskGrantDigest(g: TaskGrant): string {
  return createHash("sha256")
    .update(`${VERSION_PREFIX}${canonicalBody(g)}\n${String(g.sig)}`)
    .digest("hex");
}
