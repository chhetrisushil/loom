export const RELEASE_VERSION: string;
export const DIST_TAG: string;
export const REPOSITORY_URL: string;
export function filesFor(dir: string): string[];
export function expectedPackageJson(p: {
  dir: string;
  rel: string;
  pkg: Record<string, unknown>;
}): Record<string, unknown>;
export function plan(root: string): {
  entries: { rel: string; file: string; state: "ok" | "stale"; next: Record<string, unknown> }[];
  errors: string[];
};
