/** Names a scaffold writes into a path or a `package.json` — validated before anything is created. */

/** A construct name (`loom new <kind> <name>`): kebab-case, becomes a directory / file name. */
export const CONSTRUCT_NAME = /^[a-z][a-z0-9-]*$/;

/** Best-effort kebab-case form of an arbitrary string (`"Bad Name!"` → `"bad-name"`). */
export function kebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Why `name` is not an acceptable `loom new` name, or `undefined` when it is. A path
 * separator or `..` is called out first: those escape the convention folder, which is a
 * different mistake from a name that is merely not kebab-case.
 */
export function constructNameProblem(name: string): string | undefined {
  if (/[\\/]/.test(name) || name === ".." || name === "." || /^[a-zA-Z]:/.test(name)) {
    return `"${name}" is a path, not a name — a name may not contain path separators or "..", it would write outside the convention folder`;
  }
  if (CONSTRUCT_NAME.test(name)) return undefined;
  const k = kebab(name);
  const hint = CONSTRUCT_NAME.test(k) ? ` — did you mean "${k}"?` : "";
  return `invalid name "${name}": use lowercase kebab-case matching ${CONSTRUCT_NAME.source}${hint}`;
}

/** npm's rules for an unscoped package name (lowercase, URL-safe, no leading `.`/`_`). */
export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && /^[a-z0-9][a-z0-9._~-]*$/.test(name);
}

/** A valid npm name derived from a directory name, or `undefined` if nothing usable remains. */
export function packageNameFrom(dirName: string): string | undefined {
  const k = kebab(dirName);
  return isValidPackageName(k) ? k : undefined;
}
