export const GENERATED_MARKER: string;
export const WORKSPACE_DIRS: string[];
export function workspacePackages(root: string): { dir: string; rel: string; pkg: any }[];
export function apiReferenceHeading(orgText: string, name: string): string | undefined;
export function renderReadme(p: { rel: string; pkg: any }, apiReferenceOrg: string): string;
export function plan(
  root: string
): { file: string; text: string; state: "missing" | "stale" | "ok" }[];
