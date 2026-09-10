// ── The binding-semantics pin (ADR 0095) ─────────────────────────────────────
//
// `flowContentHash` above pins CODE identity into an execution: replay against changed flow
// code raises rather than folding a log with the wrong fold. This is the same pin one tier
// out, for the derivations an artifact READS through rather than the code it runs.
//
// The hole it closes is that a name is not a meaning. A composed surface is
// content-addressed, and `docs/composed-surfaces.md` lists its BINDINGS among the things
// that address freezes — but a binding is `{ projectionId, path }`, and the projection
// behind that id is live code with no version. The query, the filter predicates, the join
// keys, the aggregation and the window all sit behind the name, on the floating side. Edit
// the fold and every pinned view bound to it means something else, under an unchanged hash.
//
// The same is true of a read model's `extract`, where it is worse: the rows the old
// extractor wrote stay, the watermark is already past the events that produced them, and one
// query answers from two extractors with no signal anywhere.
//
// WHY THE PIN IS DECLARED AND NOT DERIVED. `flowContentHash` deliberately excludes handler
// code because it is not stably serializable at runtime, and a fold closure is the same
// object: hashing `Function.prototype.toString` flips on a whitespace edit and holds steady
// across a changed constant captured in scope — wrong in both directions. So the version is
// the author's, exactly as `EffectClass` and `CatalogEntry.props` are: loom checks the
// declaration it is given and does not invent one. A declaration is a claim, not a proof.

/** Declared semantic versions of the derivations an artifact reads through, by id. */
export type VersionPins = Readonly<Record<string, string>>;

export type PinFindingCode =
  /** Both sides declare a version and they differ — the derivation behind the name changed. */
  | "drift"
  /** One side declares nothing, so nothing about this id was actually checked. */
  | "unpinned";

export interface PinFinding {
  readonly code: PinFindingCode;
  readonly severity: "error" | "warn";
  /** The derivation id: a `projectionId`, a read model's id. */
  readonly id: string;
  readonly message: string;
  /** The version the artifact recorded, when it recorded one. */
  readonly recorded?: string;
  /** The version registered now, when one is declared. */
  readonly current?: string;
}

export interface PinReport {
  /** True iff nothing drifted. `unpinned` findings are warnings and do not clear this flag. */
  readonly ok: boolean;
  readonly findings: readonly PinFinding[];
  /**
   * Ids where BOTH sides declared a version — the denominator.
   *
   * `ok: true` over `compared: 0` is not a pass: it is two sides that declared nothing to
   * each other, which is precisely the state this check exists to make visible.
   */
  readonly compared: number;
}

/** A declared version is a non-empty string; `""` is a forgotten field, not a version. */
function declared(pins: VersionPins | undefined, id: string): string | undefined {
  const value = pins?.[id];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Compare the versions an artifact RECORDED against the versions registered NOW.
 *
 * Maps rather than blueprints, because the second consumer's pins come from a service's
 * registered definitions and not from a tree (`ReadModelService.pins()`) — the same reason
 * `preservesNodes` takes id sets. `blueprintPins` / `checkBlueprintPins` in
 * `@loom/blueprint-runtime` spell the blueprint case.
 *
 * It reports and never throws. `FlowCodeMismatchError` throws because the kernel is about to
 * fold a log with the wrong code, which has no correct outcome; a drifted binding does — the
 * caller may accept it (a deliberate re-promotion), degrade to a rendering that says so, or
 * refuse. Only the caller knows which.
 *
 * One pass over each side: O(|recorded| + |current|).
 */
export function checkVersionPins(
  recorded: VersionPins | undefined,
  current: VersionPins | undefined
): PinReport {
  const findings: PinFinding[] = [];
  const seen = new Set<string>();
  let compared = 0;

  for (const id of Object.keys(recorded ?? {})) {
    if (seen.has(id)) continue;
    seen.add(id);
    const was = declared(recorded, id);
    const now = declared(current, id);

    if (was === undefined) {
      findings.push({
        code: "unpinned",
        severity: "warn",
        id,
        message: `"${id}" was recorded without a version, so nothing about it can be checked — this artifact predates the pin, or the derivation declined to declare one`,
        ...(now !== undefined && { current: now }),
      });
      continue;
    }
    if (now === undefined) {
      findings.push({
        code: "unpinned",
        severity: "warn",
        id,
        message: `"${id}" was recorded at version "${was}" but the derivation registered now declares no version — it cannot be compared, and an unverifiable match is not a match`,
        recorded: was,
      });
      continue;
    }

    compared++;
    if (was !== now) {
      findings.push({
        code: "drift",
        severity: "error",
        id,
        message: `"${id}" was recorded at version "${was}" and is now "${now}" — the derivation behind this name changed, so what it produces no longer means what this artifact was built against`,
        recorded: was,
        current: now,
      });
    }
  }

  for (const id of Object.keys(current ?? {})) {
    if (seen.has(id)) continue;
    seen.add(id);
    const now = declared(current, id);
    findings.push({
      code: "unpinned",
      severity: "warn",
      id,
      message: `"${id}" is registered${now === undefined ? "" : ` at version "${now}"`} but the artifact recorded nothing for it — it was bound after the fact, or the recording missed it`,
      ...(now !== undefined && { current: now }),
    });
  }

  return {
    ok: !findings.some((f) => f.severity === "error"),
    findings,
    compared,
  };
}
