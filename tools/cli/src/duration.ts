const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30s` / `5m` / `6h` / `2d` → ms. A bare number is milliseconds. */
export function parseDuration(raw: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(raw.trim());
  if (match === null) throw new Error(`invalid duration "${raw}" (try 30s, 5m, 6h, 2d)`);
  return Number(match[1]) * (match[2] ? (UNITS[match[2]] as number) : 1);
}

/** ms → the shortest spelling that stays exact: 86400000 → `1d`. */
export function humanizeDuration(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}
