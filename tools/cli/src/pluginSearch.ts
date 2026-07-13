export interface PluginSearchHit {
  name: string;
  version: string;
  description: string;
}

/**
 * Search the npm registry for Loom plugins — packages carrying the `loom-plugin`
 * keyword, narrowed by `term`. `fetchImpl` is injectable for tests. Pure over the
 * network response.
 */
export async function searchPlugins(
  term: string,
  fetchImpl: typeof fetch = fetch
): Promise<PluginSearchHit[]> {
  // npm's search supports a `keywords:` qualifier — every Loom plugin is asked to carry
  // `loom-plugin` (ADR 0043 / docs/plugins.md), so that is the discovery anchor.
  const query = `keywords:loom-plugin ${term}`.trim();
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=25`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`npm search failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    objects?: Array<{ package: { name: string; version: string; description?: string } }>;
  };
  return (data.objects ?? []).map((o) => ({
    name: o.package.name,
    version: o.package.version,
    description: o.package.description ?? "",
  }));
}

/** `loom plugin search <term>` — render the hits (or a friendly empty message). */
export async function cmdPluginSearch(term: string): Promise<string> {
  const hits = await searchPlugins(term);
  if (hits.length === 0) {
    return `no plugins found for "${term}" (npm keyword loom-plugin)`;
  }
  const lines = hits.map((h) => `  ${h.name}@${h.version}\n      ${h.description}`);
  return `Loom plugins matching "${term}":\n\n${lines.join("\n")}`;
}
