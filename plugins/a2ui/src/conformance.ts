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
  | "unknown-function";

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
   */
  readonly requireRoot: boolean;
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
      if (RESERVED_KEYS.has(key) || key in entry.properties) continue;
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

  return {
    ok: findings.every((f) => f.severity !== "error"),
    findings,
    components: components.length,
  };
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
