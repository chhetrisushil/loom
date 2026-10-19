import { sha256Hex } from "@loom/core";
import type { SensitiveMap } from "./types";

const sortedUnique = (acc: Map<string, string[]>): SensitiveMap =>
  Object.fromEntries([...acc].map(([k, v]) => [k, [...new Set(v)].sort()]));

/** `["STEP_COMPLETED.output.ssn", …]` (a store's `sealingCapability().covers`) -> a {@link SensitiveMap}. */
export function sensitiveMapFromCovers(covers: readonly string[]): SensitiveMap {
  const out = new Map<string, string[]>();
  for (const c of covers) {
    const dot = c.indexOf(".");
    if (dot <= 0 || dot === c.length - 1) continue;
    const type = c.slice(0, dot);
    out.set(type, [...(out.get(type) ?? []), c.slice(dot + 1)]);
  }
  return sortedUnique(out);
}

/** A sensitive map must be a plain object of arrays of non-blank strings; anything else would silently stop masking. */
export function assertSensitiveMap(map: unknown, where = "sensitive"): void {
  if (map === undefined) return;
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    throw new TypeError(
      `${where}: must be an object mapping event types to arrays of payload paths`
    );
  }
  for (const [type, paths] of Object.entries(map)) {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || p.trim() === "")) {
      throw new TypeError(`${where}.${type}: must be an array of non-blank path strings`);
    }
  }
}

/** Union of any number of (optional) maps. Throws `TypeError` for a badly shaped map. */
export function mergeSensitive(...maps: (SensitiveMap | undefined)[]): SensitiveMap {
  const out = new Map<string, string[]>();
  for (const m of maps) {
    assertSensitiveMap(m);
    for (const [type, paths] of Object.entries(m ?? {})) {
      out.set(type, [...(out.get(type) ?? []), ...paths]);
    }
  }
  return sortedUnique(out);
}

/**
 * The version written to the fold header: the declared version, plus a digest of the declared
 * sensitive map when there is one, so editing the paths rebuilds the model (ADR 0132 D5, D11).
 */
export function effectiveFoldVersion(version: string, declared: SensitiveMap): string {
  const entries = Object.keys(declared)
    .sort()
    .flatMap((type) => {
      const paths = [...new Set(Object.hasOwn(declared, type) ? declared[type] : [])].sort();
      return paths.length === 0 ? [] : [[type, paths]];
    });
  if (entries.length === 0) return version;
  const digest = sha256Hex(JSON.stringify(entries)).slice(0, 8);
  return `${version}+sens.${digest}`;
}
