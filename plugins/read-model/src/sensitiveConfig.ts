import { createHash } from "node:crypto";
import type { SensitiveMap } from "./types";

/** `["STEP_COMPLETED.output.ssn", …]` (a store's `sealingCapability().covers`) -> a {@link SensitiveMap}. */
export function sensitiveMapFromCovers(covers: readonly string[]): SensitiveMap {
  const out: Record<string, string[]> = {};
  for (const c of covers) {
    const dot = c.indexOf(".");
    if (dot <= 0 || dot === c.length - 1) continue;
    const type = c.slice(0, dot);
    out[type] = [...(out[type] ?? []), c.slice(dot + 1)];
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

/** Union of any number of (optional) maps. */
export function mergeSensitive(...maps: (SensitiveMap | undefined)[]): SensitiveMap {
  const out: Record<string, string[]> = {};
  for (const m of maps) {
    for (const [type, paths] of Object.entries(m ?? {}))
      out[type] = [...(out[type] ?? []), ...paths];
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

/**
 * The version written to the fold header: the declared version, plus a digest of the declared
 * sensitive map when there is one, so editing the paths rebuilds the model (ADR 0132 D5, D11).
 */
export function effectiveFoldVersion(version: string, declared: SensitiveMap): string {
  const entries = Object.keys(declared)
    .sort()
    .flatMap((type) => {
      const paths = [...new Set(declared[type])].sort();
      return paths.length === 0 ? [] : [[type, paths]];
    });
  if (entries.length === 0) return version;
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 8);
  return `${version}+sens.${digest}`;
}
