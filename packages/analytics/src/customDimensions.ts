import { CUSTOM_DIMENSION_CEILING, CUSTOM_DIMENSION_PATTERN } from "@loom/replay-vm";

// ── Custom metering dimensions in analytics (ADR 0115 follow-up) ──────────────
//
// `RESOURCE_METERED.custom` carries open dimensions (`gpu_seconds`, `pages_scanned`). Analytics
// attributes them exactly like the built-ins, with bounds so a buggy or hostile writer cannot
// grow a report without limit:
//   - at most MAX_CUSTOM_DIMENSIONS distinct names are admitted PER REPORT: the TOP names by
//     total value (tie: name ascending), so the result is deterministic and independent of log or
//     execution order, and a high-value name appearing late is never buried;
//   - every other name is summed into the single OTHER_DIMENSION bucket and counted in
//     `otherNames`, with a warning;
//   - selecting the top names needs per-name totals, held in a map capped at TRACK_NAME_CAP
//     distinct names; a name first seen past that cap is summed into an untracked overflow
//     (so it can only ever land in `(other)`) and `otherNamesCapped` is set.
// Two phases, O(events) + O(names log names): `observe` every payload first, then `addPayload`
// assigns each payload to the (now fixed) admitted set. Callers therefore walk the events twice.
// Validity matches the kernel fold (`addCustomDimensions`, same pattern and the SAME value
// ceiling): bad pattern, prototype name, non-finite, negative or over-ceiling value are skipped;
// a built-in name inside `custom` is summed, as the fold does. Until the cap is hit the `custom`
// totals therefore equal the fold's `_resources.custom`; `(other)` has no fold counterpart.

/** Most distinct custom dimension names one report admits (the kernel caps one execution at 32). */
export const MAX_CUSTOM_DIMENSIONS = 32;
/** The bucket every name past the cap is summed into. Not a valid dimension name, so it cannot collide. */
export const OTHER_DIMENSION = "(other)";
const TRACK_NAME_CAP = 1024;
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** The valid (name, value) pairs of one `custom` payload, as the kernel fold would accept them. */
function* validEntries(custom: unknown): Generator<[string, number]> {
  if (typeof custom !== "object" || custom === null || Array.isArray(custom)) return;
  for (const name of Object.keys(custom)) {
    const value = (custom as Record<string, unknown>)[name];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > CUSTOM_DIMENSION_CEILING
    )
      continue;
    if (!CUSTOM_DIMENSION_PATTERN.test(name) || PROTOTYPE_NAMES.has(name)) continue;
    yield [name, value];
  }
}

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
  private readonly seen = new Map<string, number>();
  private untracked = false;
  private admitted: Set<string> | undefined;
  private otherCount = 0;

  constructor(private readonly declared: DimensionUnits | undefined = undefined) {}

  /** Phase 1: count one event's `custom` map towards the per-name totals. Call for every payload before any `addPayload`. */
  observe(custom: unknown): void {
    if (this.admitted !== undefined)
      throw new Error("CustomDimensionTracker: observe after addPayload");
    for (const [name, value] of validEntries(custom)) {
      const prior = this.seen.get(name);
      if (prior !== undefined) this.seen.set(name, prior + value);
      else if (this.seen.size < TRACK_NAME_CAP) this.seen.set(name, value);
      else this.untracked = true;
    }
  }

  private admit(): Set<string> {
    if (this.admitted === undefined) {
      const ranked = [...this.seen.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      );
      this.admitted = new Set(ranked.slice(0, MAX_CUSTOM_DIMENSIONS).map(([n]) => n));
      this.otherCount = Math.max(0, ranked.length - MAX_CUSTOM_DIMENSIONS);
    }
    return this.admitted;
  }

  /** Phase 2: add one event's `custom` map into each given total. Returns true if anything was added. */
  addPayload(custom: unknown, ...into: CustomTotals[]): boolean {
    const admitted = this.admit();
    let any = false;
    for (const [name, value] of validEntries(custom)) {
      const key = admitted.has(name) ? name : OTHER_DIMENSION;
      for (const t of into) t[key] = (t[key] ?? 0) + value;
      any = true;
    }
    return any;
  }

  /** The report-level facts (units, overflow, warnings); undefined when no custom dimension was seen. */
  report(): CustomDimensionsReport | undefined {
    const admitted = this.admit();
    if (admitted.size === 0) return undefined;
    let units: Record<string, string> | undefined;
    if (this.declared !== undefined) {
      for (const n of admitted) {
        const u = Object.hasOwn(this.declared, n) ? this.declared[n] : undefined;
        if (typeof u === "string") {
          units ??= Object.create(null) as Record<string, string>;
          units[n] = u;
        }
      }
    }
    const otherNames = this.otherCount;
    const capped = this.untracked;
    const warnings: string[] = [];
    if (otherNames > 0 || capped) {
      warnings.push(
        `custom metering dimensions capped at ${MAX_CUSTOM_DIMENSIONS} (top by value): ${
          capped ? `at least ${otherNames}` : otherNames
        } further name(s) are summed under "${OTHER_DIMENSION}"`
      );
    }
    return { otherNames, otherNamesCapped: capped, units, warnings };
  }
}

/** A fresh null-prototype totals object (names are caller-chosen; `__proto__` must stay inert). */
export function newCustomTotals(): CustomTotals {
  return Object.create(null) as CustomTotals;
}
