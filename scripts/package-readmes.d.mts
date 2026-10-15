export const GENERATED_MARKER: string;
export const WORKSPACE_DIRS: string[];
export interface PackageJson {
  name: string;
  description?: string;
  private?: boolean;
  bin?: string | Record<string, string>;
  exports?: Record<string, unknown>;
  [key: string]: unknown;
}
export function workspacePackages(root: string): { dir: string; rel: string; pkg: PackageJson }[];
export function apiReferenceHeading(orgText: string, name: string): string | undefined;
export function renderReadme(p: { rel: string; pkg: PackageJson }, apiReferenceOrg: string): string;
export function plan(
  root: string
): { file: string; text: string; state: "missing" | "stale" | "ok" }[];
