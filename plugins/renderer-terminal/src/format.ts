// Text formatting shared by the kind-blind fallback and the kind-aware default renderers.

export function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    return value
      .map((item) =>
        typeof item === "object" && item !== null
          ? `• ${Object.values(item as Record<string, unknown>)
              .map(String)
              .join(" · ")}`
          : `• ${String(item)}`
      )
      .join("\n");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
