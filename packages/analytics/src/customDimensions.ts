import { BUILTIN_METER_DIMENSIONS, isVocabularyName } from "@loom/core";

// ── Custom metering dimensions in analytics (ADR 0115 follow-up) ──────────────
//
// `RESOURCE_METERED.custom` carries open dimensions (`gpu_seconds`, `pages_scanned`). Analytics
// attributes them exactly like the built-ins, with two bounds so a buggy or hostile writer cannot
// grow a report without limit:
//   - at most MAX_CUSTOM_DIMENSIONS distinct names are admitted PER REPORT (the first seen, in
//     log order, so the result is deterministic); every further name is summed into the single
//     OTHER_DIMENSION bucket and counted in `otherNames`, with a warning;
//   - the set of overflowed names being counted is itself capped (OVERFLOW_NAME_CAP), so counting
//     distinct names cannot become the unbounded map this exists to prevent.
// A name or value the kernel's fold would skip (bad pattern, prototype name, a built-in name,
// non-finite or negative value) is skipped here too.

/** Most distinct custom dimension names one report admits (the kernel caps one execution at 32). */
export const MAX_CUSTOM_DIMENSIONS = 32;
/** The bucket every name past the cap is summed into. Not a valid dimension name, so it cannot collide. */
export const OTHER_DIMENSION = "(other)";
const OVERFLOW_NAME_CAP = 1024;
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Optional unit labels by dimension name (`{ gpu_seconds: "s" }`), supplied by the caller's metering declaration. */
export type DimensionUnits = Readonly<Record<string, string>>;

/** A summed set of custom dimensions: name → total, past-the-cap names under `(other)`. */
export type CustomTotals = Record<string, number>;

export interface CustomDimensionsReport {
  /** Distinct names folded into `(other)`; `otherNamesCapped` when this is a lower bound. */
  otherNames: number;
  otherNamesCapped: boolean;
  /** Units for the admitted names that have one declared. */
  units?: Record<string, string> | undefined;
  /** One human-readable line when the cap was hit. */
  warnings: string[];
}

/** One tracker per report: it owns the admitted-name set shared by every total in that report. */
export class CustomDimensionTracker {
  private readonly admitted = new Set<string>();
  private readonly overflow = new Set<string>();
  private overflowCapped = false;

  constructor(private readonly declared: DimensionUnits | undefined = undefined) {}

  /** Add one event's `custom` map into each given total, in one pass. Returns true if anything was added. */
  addPayload(custom: unknown, ...into: CustomTotals[]): boolean {
    if (typeof custom !== "object" || custom === null || Array.isArray(custom)) return false;
    let any = false;
    for (const name of Object.keys(custom)) {
      const value = (custom as Record<string, unknown>)[name];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      if (
        !isVocabularyName(name) ||
        BUILTIN_METER_DIMENSIONS.has(name) ||
        PROTOTYPE_NAMES.has(name)
      )
        continue;
      let key = name;
      if (!this.admitted.has(name)) {
        if (this.admitted.size < MAX_CUSTOM_DIMENSIONS) {
          this.admitted.add(name);
        } else {
          key = OTHER_DIMENSION;
          if (!this.overflow.has(name)) {
            if (this.overflow.size < OVERFLOW_NAME_CAP) this.overflow.add(name);
            else this.overflowCapped = true;
          }
        }
      }
      for (const t of into) t[key] = (t[key] ?? 0) + value;
      any = true;
    }
    return any;
  }

  /** The report-level facts (units, overflow, warnings); undefined when no custom dimension was seen. */
  report(): CustomDimensionsReport | undefined {
    if (this.admitted.size === 0) return undefined;
    let units: Record<string, string> | undefined;
    if (this.declared !== undefined) {
      for (const n of this.admitted) {
        const u = Object.hasOwn(this.declared, n) ? this.declared[n] : undefined;
        if (typeof u === "string") {
          units ??= Object.create(null) as Record<string, string>;
          units[n] = u;
        }
      }
    }
    const otherNames = this.overflow.size;
    const warnings: string[] = [];
    if (otherNames > 0 || this.overflowCapped) {
      warnings.push(
        `custom metering dimensions capped at ${MAX_CUSTOM_DIMENSIONS}: ${
          this.overflowCapped ? `at least ${otherNames}` : otherNames
        } further name(s) are summed under "${OTHER_DIMENSION}"`
      );
    }
    return { otherNames, otherNamesCapped: this.overflowCapped, units, warnings };
  }
}

/** A fresh null-prototype totals object (names are caller-chosen; `__proto__` must stay inert). */
export function newCustomTotals(): CustomTotals {
  return Object.create(null) as CustomTotals;
}
