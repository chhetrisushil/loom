import type { A2UICatalog } from "./catalog";
import type { ComponentInstance } from "./messages";

// ── Catalogue conformance on the A2UI egress path ─────────────────────────────
//
// A2UI makes the catalogue load-bearing: `createSurface` names a `catalogId`, and
// a client can only render a `component` type its catalogue defines. The bridge
// stamped that id on every message and checked nothing against it, so an
// off-catalogue component was emitted happily and failed at the CLIENT, at render
// time, per viewer — the failure arriving as far as possible from the code that
// caused it.
//
// The same hole existed for `callFunction`: catalogues declare the `functions` an
// agent may invoke on the client (ADR 0070), and nothing compared a call to them.
//
// These checks close both. They are deliberately EXACT rather than thorough: a
// component's `properties` are JSON-Schema documents with `$ref`s into a shared
// types file, so this module checks the property *keys* a catalogue declares and
// makes no claim about their values. A partial check that announced itself as
// complete would be worse than none.

export type A2UIFindingCode =
  /** A `component` type the catalogue does not define. */
  | "unknown-component"
  /** A prop key outside the component's declared `properties`. */
  | "undeclared-prop"
  /** Two components sharing an `id` — A2UI addresses components by id. */
  | "duplicate-component-id"
  /** No component with `id: "root"`; A2UI has nowhere to start rendering. */
  | "missing-root"
  /** A catalogue entry that declares no `properties`, so its props go unchecked. */
  | "unchecked-props"
  /** A `callFunction` name the catalogue does not declare. */
  | "unknown-function"
  /** A `children: string[]` entry naming an id no component in scope defines. */
  | "dangling-child"
  /** A `children: { componentId }` (List template) naming an id in scope defines. */
  | "dangling-template"
  /** A component reachable from itself through `children` references. */
  | "child-cycle"
  /** A component no path from `root` ever reaches — it will never render. */
  | "unreachable-component"
  /** A catalogue entry's key disagrees with its `component` discriminator const. */
  | "catalog-entry-key-mismatch"
  /** A catalogue function's key disagrees with its declared `name`. */
  | "catalog-function-key-mismatch";

export interface A2UIFinding {
  readonly code: A2UIFindingCode;
  readonly severity: "error" | "warn";
  readonly message: string;
  /** The component or function the finding is about. */
  readonly subject: string;
}

export interface A2UIValidation {
  /** True iff there are no `error`-severity findings. */
  readonly ok: boolean;
  readonly findings: readonly A2UIFinding[];
  /**
   * Components examined. `ok: true` over an empty tree is not evidence that a
   * composer works, and this is how a caller tells the two apart.
   */
  readonly components: number;
}

/** Structural keys of a `ComponentInstance`; everything else is a prop. */
const RESERVED_KEYS = new Set(["id", "component"]);

export interface ValidateComponentsOptions {
  /**
   * Require exactly one component with `id: "root"`.
   *
   * True for a `createSurface` tree, which carries the whole view and has to name
   * its entry point. False for an `updateComponents` batch, which may legitimately
   * replace a subtree — demanding a root there would reject correct usage, and a
   * check that rejects correct usage gets turned off.
   *
   * Reachability (`unreachable-component`) is only reported when this is true: a
   * partial batch legitimately omits most of the tree, so "not reached from root"
   * is meaningless for it.
   */
  readonly requireRoot: boolean;
  /**
   * Ids already known outside `components` — e.g. what a client already holds —
   * against which `children` references in `components` may resolve, in addition
   * to ids within `components` itself.
   *
   * `A2UISurfaceBridge.recompose` REPLACES its stored tree with each batch, while
   * an A2UI client MERGES `updateComponents` by id: a batch that references an
   * already-delivered sibling is correct usage, not a dangling reference. Without
   * this, checking a batch against only itself would reject exactly that and get
   * turned off. Cycle detection also walks through `knownComponents`, so a batch
   * that closes a loop back through an already-sent component is still caught.
   */
  readonly knownComponents?: ReadonlyMap<string, ComponentInstance>;
}

/** The two `children` shapes A2UI components use to reference other components. */
function childIdsOf(instance: ComponentInstance | undefined): readonly string[] {
  if (!instance) return [];
  const children = instance.children;
  if (Array.isArray(children)) {
    return children.filter((c): c is string => typeof c === "string");
  }
  if (
    children !== null &&
    typeof children === "object" &&
    typeof (children as { componentId?: unknown }).componentId === "string"
  ) {
    return [(children as { componentId: string }).componentId];
  }
  return [];
}

/**
 * Check a component tree against a catalogue. Never throws; returns every finding
 * from one pass, so a composer can degrade or record a gap on the whole report
 * rather than on the first failure.
 */
export function validateComponents(
  components: readonly ComponentInstance[],
  catalog: A2UICatalog,
  options: ValidateComponentsOptions
): A2UIValidation {
  const findings: A2UIFinding[] = [];
  const seenIds = new Set<string>();
  let roots = 0;

  for (const instance of components) {
    if (seenIds.has(instance.id)) {
      findings.push({
        code: "duplicate-component-id",
        severity: "error",
        subject: instance.id,
        message: `two components share the id "${instance.id}" — A2UI addresses components by id, so one silently replaces the other`,
      });
    }
    seenIds.add(instance.id);
    if (instance.id === "root") roots++;

    const entry = catalog.components[instance.component];
    if (!entry) {
      findings.push({
        code: "unknown-component",
        severity: "error",
        subject: instance.id,
        message: `component type "${instance.component}" is not defined in catalogue "${catalog.id}" — a client holding that catalogue cannot render it`,
      });
      // Without an entry there is no property declaration, so any prop finding
      // here would be invented. One defect, one finding.
      continue;
    }

    if (!entry.properties) {
      findings.push({
        code: "unchecked-props",
        severity: "warn",
        subject: instance.component,
        message: `catalogue entry "${instance.component}" declares no properties, so this component's props are not checked — declare them, or accept that this check does not cover it`,
      });
      continue;
    }

    for (const key of Object.keys(instance)) {
      // `Object.hasOwn`, not `in` — `in` walks the prototype chain, and
      // `entry.properties` is a plain object, so a prop keyed "toString",
      // "hasOwnProperty" or an own "__proto__" (JSON.parse creates one as a
      // normal own property, never as prototype assignment) would read as
      // "declared" via Object.prototype and skip this check entirely.
      if (RESERVED_KEYS.has(key) || Object.hasOwn(entry.properties, key)) continue;
      findings.push({
        code: "undeclared-prop",
        severity: "error",
        subject: instance.id,
        message: `prop "${key}" is not declared by "${instance.component}" in catalogue "${catalog.id}"`,
      });
    }
  }

  if (options.requireRoot && roots === 0) {
    findings.push({
      code: "missing-root",
      severity: "error",
      subject: "root",
      message:
        'no component has id "root" — A2UI renders a surface from its root and has nowhere to start',
    });
  }

  // ── Structural checks: dangling references, cycles, reachability ────────────
  //
  // These are pure adjacency-list graph properties — checkable without JSON
  // Schema and without any claim about prop VALUES. `merged` is the graph a
  // client actually resolves references against: `components` (this batch)
  // overlaid on `knownComponents` (what is already known/delivered), because a
  // batch legitimately references an existing sibling it did not re-send.
  const known = options.knownComponents;
  const merged: Map<string, ComponentInstance> = known ? new Map(known) : new Map();
  for (const instance of components) merged.set(instance.id, instance);

  for (const instance of components) {
    const children = instance.children;
    if (Array.isArray(children)) {
      for (const childId of children) {
        if (typeof childId === "string" && !merged.has(childId)) {
          findings.push({
            code: "dangling-child",
            severity: "error",
            subject: instance.id,
            message: `component "${instance.id}" references child id "${childId}", which no component in scope defines`,
          });
        }
      }
    } else if (
      children !== null &&
      typeof children === "object" &&
      typeof (children as { componentId?: unknown }).componentId === "string"
    ) {
      const templateId = (children as { componentId: string }).componentId;
      if (!merged.has(templateId)) {
        findings.push({
          code: "dangling-template",
          severity: "error",
          subject: instance.id,
          message: `list "${instance.id}" templates component id "${templateId}", which no component in scope defines`,
        });
      }
    }
  }

  // One iterative DFS per unvisited node, white(absent)/grey(1, on the current
  // path)/black(2, fully explored) colouring — O(V+E) total, no recursion, so
  // depth is bounded by heap rather than call-stack size. Starting at "root"
  // (when present) also gives reachability for free; any node left unvisited
  // after that is picked up by the second loop purely for cycle coverage, since
  // an orphaned subtree can still loop on itself.
  const color = new Map<string, 1 | 2>();
  const reachableFromRoot = new Set<string>();

  const dfsFrom = (startId: string, markReachable: boolean): void => {
    if (color.has(startId)) return;
    const stack: { id: string; kids: readonly string[]; idx: number }[] = [
      { id: startId, kids: childIdsOf(merged.get(startId)), idx: 0 },
    ];
    color.set(startId, 1);
    if (markReachable) reachableFromRoot.add(startId);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; kids: readonly string[]; idx: number };
      if (frame.idx < frame.kids.length) {
        const childId = frame.kids[frame.idx++] as string;
        if (!merged.has(childId)) continue; // dangling — already reported above
        const childColor = color.get(childId);
        if (childColor === 1) {
          findings.push({
            code: "child-cycle",
            severity: "error",
            subject: childId,
            message: `component "${frame.id}" references "${childId}", which is its own ancestor via \`children\` — a cycle`,
          });
          continue;
        }
        if (childColor === 2) continue; // already fully explored elsewhere
        color.set(childId, 1);
        if (markReachable) reachableFromRoot.add(childId);
        stack.push({ id: childId, kids: childIdsOf(merged.get(childId)), idx: 0 });
      } else {
        color.set(frame.id, 2);
        stack.pop();
      }
    }
  };

  if (merged.has("root")) dfsFrom("root", true);
  for (const id of merged.keys()) {
    if (!color.has(id)) dfsFrom(id, false);
  }

  if (options.requireRoot && roots > 0) {
    // Reachability is only meaningful once a root actually exists — with none,
    // `missing-root` already says everything there is to say, and reporting
    // every other component as "unreachable" on top of it would be noise about
    // the same defect rather than a second one.
    for (const instance of components) {
      if (instance.id !== "root" && !reachableFromRoot.has(instance.id)) {
        findings.push({
          code: "unreachable-component",
          severity: "warn",
          subject: instance.id,
          message: `component "${instance.id}" is not reachable from "root" — it will never render`,
        });
      }
    }
  }

  return {
    ok: findings.every((f) => f.severity !== "error"),
    findings,
    components: components.length,
  };
}

/**
 * Check a catalogue's own well-formedness: an entry's key must equal its
 * `component` discriminator const, and a function's key must equal its `name`.
 *
 * A catalogue is looked up by both directions — `validateComponents` indexes
 * `catalog.components` by key to check an instance's `component` field, and a
 * client indexes it the same way to route a wire message to a renderer. A
 * mis-keyed entry (declared under `"Text"`, discriminator `{ const: "Txt" }`)
 * passes as a bare `unchecked-props` warn today: the key routes lookups but the
 * const is never compared to it, so nothing catches the two disagreeing.
 */
export function validateCatalog(catalog: A2UICatalog): A2UIValidation {
  const findings: A2UIFinding[] = [];

  for (const [key, entry] of Object.entries(catalog.components)) {
    if (entry.component.const !== key) {
      findings.push({
        code: "catalog-entry-key-mismatch",
        severity: "error",
        subject: key,
        message: `catalogue "${catalog.id}" entry "${key}" declares component discriminator "${entry.component.const}" — a component instance is routed by one and rendered by the other, and the two disagree`,
      });
    }
  }

  if (catalog.functions) {
    for (const [key, fn] of Object.entries(catalog.functions)) {
      if (fn.name !== key) {
        findings.push({
          code: "catalog-function-key-mismatch",
          severity: "error",
          subject: key,
          message: `catalogue "${catalog.id}" function "${key}" declares name "${fn.name}" — the two must agree`,
        });
      }
    }
  }

  return { ok: findings.every((f) => f.severity !== "error"), findings, components: 0 };
}

/**
 * Check a `callFunction` name against a catalogue's declared `functions`.
 *
 * A catalogue that declares no `functions` at all is a refusal, not a pass: it
 * says the client exposes nothing callable, so every call against it is a
 * finding. Treating the absence as "unverifiable, therefore allowed" is how a
 * declared vocabulary ends up enforcing nothing.
 */
export function validateFunctionCall(name: string, catalog: A2UICatalog): A2UIValidation {
  const declared = catalog.functions;
  if (!declared || Object.keys(declared).length === 0) {
    return {
      ok: false,
      components: 0,
      findings: [
        {
          code: "unknown-function",
          severity: "error",
          subject: name,
          message: `catalogue "${catalog.id}" declares no client-callable functions, so "${name}" cannot be one — declare it under \`functions\``,
        },
      ],
    };
  }
  if (!(name in declared)) {
    return {
      ok: false,
      components: 0,
      findings: [
        {
          code: "unknown-function",
          severity: "error",
          subject: name,
          message: `"${name}" is not declared under \`functions\` in catalogue "${catalog.id}"`,
        },
      ],
    };
  }
  return { ok: true, components: 0, findings: [] };
}

/** Render a report as a single-line message for an error thrown at a seam. */
export function describeFindings(report: A2UIValidation): string {
  return report.findings
    .filter((f) => f.severity === "error")
    .map((f) => `${f.code} [${f.subject}]: ${f.message}`)
    .join("; ");
}
