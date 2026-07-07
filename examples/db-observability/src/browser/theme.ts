import type { CSSProperties } from "react";

// Shared dark-theme tokens + card styles for the widget renderers.
export const colors = {
  bg: "#0b0f17",
  card: "#131a26",
  cardBorder: "#1e2a3d",
  text: "#e2e8f0",
  dim: "#7a8aa0",
  accent: "#4299e1",
  good: "#38a169",
  warn: "#d69e2e",
  crit: "#e53e3e",
} as const;

/** Colour for a value against warn/critical thresholds (higher = worse). */
export function severityColor(value: number, warn: number, crit: number): string {
  if (value >= crit) return colors.crit;
  if (value >= warn) return colors.warn;
  return colors.good;
}

export const card: CSSProperties = {
  background: colors.card,
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: 10,
  padding: 16,
};

export const cardTitle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: colors.dim,
  marginBottom: 10,
};
