/**
 * Caller-supplied extra request headers for the HTTP providers (for example Anthropic's
 * `anthropic-workspace-id`). Validated once at construction; a provider's own auth and protocol
 * headers can never be replaced. Errors name the header and never carry a value.
 */
export function validateExtraHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  protectedNames: readonly string[],
  provider: string
): Readonly<Record<string, string>> {
  if (headers === undefined) return {};
  const owned = new Set(protectedNames.map((n) => n.toLowerCase()));
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(name)) {
      throw new Error(`${provider}: header name contains a CR or LF character`);
    }
    if (name.length === 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`${provider}: invalid header name "${name.slice(0, 64)}"`);
    }
    if (typeof value !== "string") {
      throw new Error(`${provider}: header "${name}" must have a string value`);
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`${provider}: header "${name}" value contains a CR or LF character`);
    }
    const lower = name.toLowerCase();
    if (owned.has(lower)) {
      throw new Error(
        `${provider}: header "${name}" is protected (owned by the provider) and cannot be overridden`
      );
    }
    if (seen.has(lower)) {
      throw new Error(`${provider}: header "${name}" is given twice (names are case-insensitive)`);
    }
    seen.add(lower);
    out[name] = value;
  }
  return out;
}
