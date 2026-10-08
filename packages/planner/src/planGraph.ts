import { validateToolInput } from "@loom/agent";
import type { CapabilityCatalog } from "@loom/capability";
import { isTainted, taintOf, tainted } from "@loom/classify";

// ── R16 (ADR 0123) — a plan is a DAG of steps with arguments and bindings ──────────────────────
//
// `Plan` (the original shape) is an ordered list of `{ capabilityId, rationale }`: no arguments, no
// edges, nothing between steps. A `PlanGraph` is the version an executor can run:
//
//   { id, capabilityId, args, dependsOn[], preconditions[] }
//
// `args` is JSON that may contain REFERENCES — `{ "$from": "<stepId>.<path>" }` — to an upstream
// step's output. A reference is resolved at execution, by this module, from the executor's own
// record of outputs. The model never supplies a value for a bound position, and a resolved value
// is DATA in an argument: it is not interpolated into a prompt (and a tainted output stays tainted).
//
// Everything here is a pure function of its inputs: validation, ordering and resolution have no
// clock, no I/O and no randomness, so a replay recomputes them identically.

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A reference to an upstream step's output: `"<stepId>"` or `"<stepId>.<path>.0.<more>"`. */
export interface PlanRef {
  $from: string;
}

export type PreconditionTest = "exists" | "truthy" | "equals";

/**
 * A guard evaluated just before a step runs, over the resolved output of an upstream step. A miss is
 * a typed failure of kind `precondition` (it never runs the capability), and it is what a replan is
 * for. `equals` compares to a JSON scalar with `===`.
 */
export interface PlanPrecondition {
  ref: string;
  test?: PreconditionTest;
  value?: string | number | boolean | null;
}

export interface PlanNode {
  /** Unique within the plan history (replans may not reuse an id). `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. */
  id: string;
  capabilityId: string;
  /** Arguments for the capability's input schema. May contain {@link PlanRef}s. */
  args?: { [k: string]: Json };
  /** Upstream step ids. Every reference in `args` and `preconditions` must point at one of these. */
  dependsOn?: string[];
  preconditions?: PlanPrecondition[];
  /** Model-authored free text. Bounded, display/audit only; never put in an instruction position. */
  rationale?: string;
}

export interface PlanGraph {
  goal: string;
  nodes: PlanNode[];
}

/** Hard bounds on a plan. Every one is checked before anything runs. */
export interface PlanLimits {
  /** Default 32. */
  maxNodes: number;
  /** Max `dependsOn` per node. Default 16. */
  maxDependsOn: number;
  /** Max serialized bytes of one node's `args`. Default 32 KiB. */
  maxArgsBytes: number;
  /** Max JSON nesting inside `args`. Default 16. */
  maxArgsDepth: number;
  /** Max references in one node (args + preconditions). Default 32. */
  maxRefsPerNode: number;
  /** Max preconditions per node. Default 8. */
  maxPreconditions: number;
  /** Max `rationale` characters (longer is truncated, not refused). Default 500. */
  maxRationaleChars: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = Object.freeze({
  maxNodes: 32,
  maxDependsOn: 16,
  maxArgsBytes: 32 * 1024,
  maxArgsDepth: 16,
  maxRefsPerNode: 32,
  maxPreconditions: 8,
  maxRationaleChars: 500,
});

export type PlanIssueCode =
  | "malformed"
  | "too-large"
  | "duplicate-id"
  | "reserved-id"
  | "unknown-capability"
  | "unknown-dependency"
  | "self-dependency"
  | "cycle"
  | "bad-ref"
  | "dangling-ref"
  | "undeclared-ref"
  | "args-invalid"
  | "forbidden-key";

export interface PlanIssue {
  code: PlanIssueCode;
  nodeId?: string;
  message: string;
}

/** Thrown by {@link assertValidPlanGraph}. `issues` is bounded (first 10). */
export class PlanValidationError extends Error {
  readonly issues: readonly PlanIssue[];
  constructor(issues: readonly PlanIssue[]) {
    const shown = issues.slice(0, 10);
    super(
      `invalid plan: ${shown.map((i) => `${i.code}${i.nodeId !== undefined ? `@${i.nodeId}` : ""}: ${i.message}`).join("; ")}${issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : ""}`
    );
    this.name = "PlanValidationError";
    this.issues = shown;
    Object.setPrototypeOf(this, PlanValidationError.prototype);
  }
}

export const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_PATH_SEGMENTS = 16;
const MAX_SEGMENT_CHARS = 64;

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isPlanRef(v: unknown): v is PlanRef {
  return typeof v === "object" && v !== null && !Array.isArray(v) && own(v, "$from");
}

/** `"step.a.0"` → `{ step, path: ["a", "0"] }`, or `undefined` when the text is not a legal reference. */
export function parseRef(text: unknown): { step: string; path: string[] } | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > 512) return undefined;
  const parts = text.split(".");
  const step = parts[0] as string;
  if (!NODE_ID.test(step)) return undefined;
  const path = parts.slice(1);
  if (path.length > MAX_PATH_SEGMENTS) return undefined;
  for (const seg of path) {
    if (seg.length === 0 || seg.length > MAX_SEGMENT_CHARS || FORBIDDEN_KEYS.has(seg)) {
      return undefined;
    }
  }
  return { step, path };
}

interface ArgsScan {
  refs: string[];
  /** A message when the args are not a bounded, clean JSON tree. */
  problem?: { code: PlanIssueCode; message: string };
}

/** Iterative walk of one args tree: bounds, forbidden keys, reference collection. */
function scanArgs(args: unknown, limits: PlanLimits): ArgsScan {
  const refs: string[] = [];
  const stack: Array<[unknown, number]> = [[args, 0]];
  let bytes = 0;
  while (stack.length > 0) {
    const [v, depth] = stack.pop() as [unknown, number];
    if (depth > limits.maxArgsDepth) {
      return { refs, problem: { code: "too-large", message: "args nest too deeply" } };
    }
    if (v === null || typeof v === "boolean") {
      bytes += 5;
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        return { refs, problem: { code: "malformed", message: "args hold a non-finite number" } };
      }
      bytes += 8;
    } else if (typeof v === "string") {
      bytes += v.length + 2;
    } else if (Array.isArray(v)) {
      bytes += 2;
      for (const c of v) stack.push([c, depth + 1]);
    } else if (typeof v === "object") {
      if (isPlanRef(v)) {
        const keys = Object.keys(v);
        const from = (v as PlanRef).$from;
        if (keys.length !== 1 || parseRef(from) === undefined) {
          return {
            refs,
            problem: {
              code: "bad-ref",
              message: `a "$from" reference must be exactly { "$from": "<stepId>[.path]" } (got keys ${keys.slice(0, 4).join(",")})`,
            },
          };
        }
        refs.push(from);
        bytes += from.length + 12;
      } else {
        for (const k of Object.keys(v)) {
          if (FORBIDDEN_KEYS.has(k)) {
            return {
              refs,
              problem: { code: "forbidden-key", message: `args may not contain key "${k}"` },
            };
          }
          bytes += k.length + 3;
          stack.push([(v as Record<string, unknown>)[k], depth + 1]);
        }
      }
    } else {
      return { refs, problem: { code: "malformed", message: `args hold a ${typeof v}` } };
    }
    if (bytes > limits.maxArgsBytes) {
      return { refs, problem: { code: "too-large", message: "args exceed the byte limit" } };
    }
    if (refs.length > limits.maxRefsPerNode) {
      return { refs, problem: { code: "too-large", message: "too many references in args" } };
    }
  }
  return { refs };
}

export interface ValidatePlanOptions {
  catalog: Pick<CapabilityCatalog, "get">;
  limits?: Partial<PlanLimits>;
  /**
   * Step ids that exist OUTSIDE `plan.nodes` and are already done (a replan's kept steps). They may
   * be named in `dependsOn` / references; a new node may not reuse one.
   */
  external?: ReadonlySet<string>;
  /** Ids a node may not use (failed / skipped in an earlier round). */
  reserved?: ReadonlySet<string>;
}

export type PlanValidation =
  | { ok: true; order: string[] }
  | { ok: false; issues: PlanIssue[]; truncated: boolean };

const MAX_ISSUES = 25;

/**
 * Check a plan graph without running anything. Refuses: a malformed or oversized plan, a duplicate
 * or reserved id, an unknown capability, a dependency on an unknown step, a cycle (Kahn, O(V+E)),
 * a reference that names no declared upstream step, and `args` that are schema-invalid (for a node
 * with no references; a node WITH references is validated after resolution, at execution).
 *
 * Returns a topological order (declaration order among ready nodes, so it is deterministic).
 */
export function validatePlanGraph(plan: unknown, opts: ValidatePlanOptions): PlanValidation {
  const limits: PlanLimits = { ...DEFAULT_PLAN_LIMITS, ...opts.limits };
  const issues: PlanIssue[] = [];
  const add = (code: PlanIssueCode, message: string, nodeId?: string): void => {
    if (issues.length < MAX_ISSUES)
      issues.push({ code, message, ...(nodeId !== undefined && { nodeId }) });
  };
  const fail = (): PlanValidation => ({
    ok: false,
    issues,
    truncated: issues.length >= MAX_ISSUES,
  });

  if (typeof plan !== "object" || plan === null || !Array.isArray((plan as PlanGraph).nodes)) {
    add("malformed", "a plan is { goal, nodes: [...] }");
    return fail();
  }
  const nodes = (plan as PlanGraph).nodes;
  if (nodes.length > limits.maxNodes) {
    add("too-large", `${nodes.length} nodes exceed the limit of ${limits.maxNodes}`);
    return fail();
  }
  const external = opts.external ?? new Set<string>();

  const index = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (typeof n !== "object" || n === null || typeof n.id !== "string" || !NODE_ID.test(n.id)) {
      add("malformed", `node ${i} has no legal id (${NODE_ID.source})`);
      return;
    }
    if (index.has(n.id)) add("duplicate-id", "duplicate step id", n.id);
    else index.set(n.id, i);
    if (external.has(n.id) || opts.reserved?.has(n.id) === true) {
      add("reserved-id", "id was used by an earlier round of this plan", n.id);
    }
  });
  if (issues.length > 0) return fail();

  const adj: number[][] = nodes.map(() => []);
  const indeg: number[] = nodes.map(() => 0);

  nodes.forEach((n, i) => {
    const cap = typeof n.capabilityId === "string" ? opts.catalog.get(n.capabilityId) : undefined;
    if (cap === undefined) {
      add("unknown-capability", `no capability "${String(n.capabilityId).slice(0, 80)}"`, n.id);
    }
    if (
      n.args !== undefined &&
      (typeof n.args !== "object" || n.args === null || Array.isArray(n.args))
    ) {
      add("malformed", "args must be an object", n.id);
      return;
    }
    if (n.dependsOn !== undefined && !Array.isArray(n.dependsOn)) {
      add("malformed", "dependsOn must be an array of step ids", n.id);
      return;
    }
    const deps = n.dependsOn ?? [];
    if (deps.length > limits.maxDependsOn) {
      add("too-large", "too many dependsOn entries", n.id);
      return;
    }
    const declared = new Set<string>();
    for (const d of deps) {
      if (typeof d !== "string") {
        add("malformed", "dependsOn holds a non-string", n.id);
        continue;
      }
      if (d === n.id) {
        add("self-dependency", "a step cannot depend on itself", n.id);
        continue;
      }
      if (declared.has(d)) continue; // a repeated edge is harmless; count it once
      declared.add(d);
      const j = index.get(d);
      if (j !== undefined) {
        adj[j]?.push(i);
        indeg[i] = (indeg[i] ?? 0) + 1;
      } else if (!external.has(d)) {
        add("unknown-dependency", `depends on unknown step "${d.slice(0, 64)}"`, n.id);
      }
    }

    const scan = scanArgs(n.args ?? {}, limits);
    if (scan.problem !== undefined) add(scan.problem.code, scan.problem.message, n.id);
    const refTexts = [...scan.refs];
    const pre = n.preconditions ?? [];
    if (!Array.isArray(pre) || pre.length > limits.maxPreconditions) {
      add("too-large", "preconditions must be an array within the limit", n.id);
    } else {
      for (const p of pre) {
        if (typeof p !== "object" || p === null || parseRef(p.ref) === undefined) {
          add("bad-ref", "a precondition needs a legal `ref`", n.id);
          continue;
        }
        if (p.test !== undefined && !["exists", "truthy", "equals"].includes(p.test)) {
          add("malformed", "unknown precondition test", n.id);
        }
        if (p.test === "equals") {
          const v = p.value;
          if (v !== null && !["string", "number", "boolean"].includes(typeof v)) {
            add("malformed", "an `equals` precondition needs a scalar `value`", n.id);
          }
        }
        refTexts.push(p.ref);
      }
    }
    if (refTexts.length > limits.maxRefsPerNode) add("too-large", "too many references", n.id);
    for (const text of refTexts) {
      const r = parseRef(text);
      if (r === undefined) continue; // already reported by the scan
      if (!index.has(r.step) && !external.has(r.step)) {
        add("dangling-ref", `reference to unknown step "${r.step}"`, n.id);
      } else if (!declared.has(r.step)) {
        add("undeclared-ref", `reference to "${r.step}" which is not in dependsOn`, n.id);
      }
    }

    // A node with no references is checkable now; one with references is checked once they resolve.
    if (cap !== undefined && scan.problem === undefined && scan.refs.length === 0) {
      const chk = validateToolInput(cap.inputSchema, n.args ?? {});
      if (!chk.ok) {
        add(
          "args-invalid",
          chk.issues.map((x) => `${x.path || "(root)"}: ${x.message}`).join("; "),
          n.id
        );
      }
    }
  });
  if (issues.length > 0) return fail();

  // Kahn's algorithm, ready nodes taken in declaration order (a min-index scan via a sorted frontier
  // would be O(V log V); declaration-order FIFO is O(V+E) and just as deterministic).
  const order: string[] = [];
  const deg = indeg.slice();
  let frontier: number[] = [];
  deg.forEach((d, i) => {
    if (d === 0) frontier.push(i);
  });
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      order.push((nodes[i] as PlanNode).id);
      for (const j of adj[i] as number[]) {
        deg[j] = (deg[j] as number) - 1;
        if (deg[j] === 0) next.push(j);
      }
    }
    frontier = next;
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    add("cycle", `dependency cycle among: ${stuck.slice(0, 8).join(", ")}`);
    return fail();
  }
  return { ok: true, order };
}

/** {@link validatePlanGraph}, throwing {@link PlanValidationError}. */
export function assertValidPlanGraph(plan: unknown, opts: ValidatePlanOptions): string[] {
  const v = validatePlanGraph(plan, opts);
  if (!v.ok) throw new PlanValidationError(v.issues);
  return v.order;
}

// ── Resolution ──────────────────────────────────────────────────────────────────────────────────

/** A reference that cannot be resolved against the recorded outputs (missing step, missing path). */
export class RefResolutionError extends Error {
  readonly ref: string;
  constructor(ref: string, why: string) {
    super(`cannot resolve "$from": "${ref.slice(0, 120)}": ${why}`);
    this.name = "RefResolutionError";
    this.ref = ref;
    Object.setPrototypeOf(this, RefResolutionError.prototype);
  }
}

/**
 * Read `ref` from the executor's recorded outputs. Only OWN properties are followed (a path of
 * `constructor` or `__proto__` was refused at validation and is refused again here). A tainted
 * output stays tainted: the path is followed inside it and the result re-wrapped with the same origin.
 */
export function resolveRef(ref: string, outputs: ReadonlyMap<string, unknown>): unknown {
  const parsed = parseRef(ref);
  if (parsed === undefined) throw new RefResolutionError(ref, "not a legal reference");
  if (!outputs.has(parsed.step))
    throw new RefResolutionError(ref, `step "${parsed.step}" has no output`);
  const root = outputs.get(parsed.step);
  const taint = isTainted(root) ? taintOf(root) : undefined;
  let cur: unknown = taint !== undefined ? (root as { value: unknown }).value : root;
  for (const seg of parsed.path) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(seg) || Number(seg) >= cur.length) {
        throw new RefResolutionError(ref, `no index "${seg}"`);
      }
      cur = cur[Number(seg)];
    } else if (typeof cur === "object" && cur !== null && own(cur, seg)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      throw new RefResolutionError(ref, `no property "${seg}"`);
    }
  }
  return taint !== undefined && !isTainted(cur) ? tainted(cur, taint.origin) : cur;
}

/** Substitute every `{ $from }` in `args` (iteratively). The model's other values pass through unchanged. */
export function resolveArgs(
  args: { [k: string]: Json } | undefined,
  outputs: ReadonlyMap<string, unknown>
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const work: Array<{ src: unknown; set: (v: unknown) => void }> = [];
  for (const k of Object.keys(args ?? {})) {
    work.push({ src: (args as Record<string, unknown>)[k], set: (v) => defineOwn(root, k, v) });
  }
  while (work.length > 0) {
    const { src, set } = work.pop() as (typeof work)[number];
    if (isPlanRef(src)) {
      set(resolveRef((src as PlanRef).$from, outputs));
    } else if (Array.isArray(src)) {
      const arr: unknown[] = new Array(src.length);
      set(arr);
      src.forEach((c, i) =>
        work.push({
          src: c,
          set: (v) => {
            arr[i] = v;
          },
        })
      );
    } else if (typeof src === "object" && src !== null) {
      const obj: Record<string, unknown> = {};
      set(obj);
      for (const k of Object.keys(src)) {
        work.push({ src: (src as Record<string, unknown>)[k], set: (v) => defineOwn(obj, k, v) });
      }
    } else {
      set(src);
    }
  }
  return root;
}

function defineOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Evaluate a precondition over resolved outputs. `undefined` ⇒ held; otherwise the reason it missed. */
export function checkPrecondition(
  p: PlanPrecondition,
  outputs: ReadonlyMap<string, unknown>
): string | undefined {
  let v: unknown;
  try {
    v = resolveRef(p.ref, outputs);
  } catch (e) {
    if (p.test === "exists") return `${p.ref} does not exist`;
    return e instanceof Error ? e.message : "unresolvable";
  }
  const raw = isTainted(v) ? (v as { value: unknown }).value : v;
  const test = p.test ?? "exists";
  if (test === "exists") return raw === undefined || raw === null ? `${p.ref} is empty` : undefined;
  if (test === "truthy") return raw ? undefined : `${p.ref} is not truthy`;
  return raw === p.value ? undefined : `${p.ref} does not equal the required value`;
}

/** Nodes (by id) that still need running, plus the ids each depends on, as adjacency for Kahn. */
export function dependentsOf(nodes: readonly PlanNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    for (const d of new Set(n.dependsOn ?? [])) {
      const l = out.get(d);
      if (l) l.push(n.id);
      else out.set(d, [n.id]);
    }
  }
  return out;
}

/** Truncate a node's free text to the limit (display / audit only). */
export function boundRationale(
  r: unknown,
  max = DEFAULT_PLAN_LIMITS.maxRationaleChars
): string | undefined {
  return typeof r === "string" ? r.slice(0, max) : undefined;
}
