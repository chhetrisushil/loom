import { asCell } from "./normalize";
import type { FlexLayout, GridCell, GridLayout, Layout, StackLayout, Widget } from "./types";

// ADR 0099 D2 — a role is a registry KEY, so it has a key's shape: a lowercase ASCII letter,
// then lowercase letters, digits or hyphens, at most 64 characters in all. No `_`, `.` or
// uppercase, so `__proto__`/`constructor` can never be one and a role never needs escaping in a
// CSS attribute selector (`[data-container-role=stepped]`) or a log line.
const LAYOUT_ROLE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Whether `value` is a well-formed layout role (ADR 0099 D2): `/^[a-z][a-z0-9-]{0,63}$/`. A
 * renderer looks a container's role up only when this holds; anything else — absent, empty,
 * a non-string, `"Stepped"`, a 65-character string — draws the plain container, exactly as an
 * unknown role does. It is the ONE spelling of the rule, so a compiler's schema and a
 * renderer's lookup cannot drift apart.
 */
export function isLayoutRole(value: unknown): value is string {
  return typeof value === "string" && LAYOUT_ROLE.test(value);
}

/**
 * Whether `value` is a well-formed layout id (IR 2.4.0, ADR 0101): the same rule as `Widget.id`,
 * a non-empty string — no charset, no length cap. Anything else — absent, `""`, a number, `null`
 * — is treated as ABSENT by every reader: the container is keyed positionally, the identity walk
 * skips it, and it collides with nothing. It is the ONE spelling of the rule, so a compiler's
 * schema and a renderer's keying cannot drift apart (as `isLayoutRole` is for roles).
 */
export function isLayoutId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** `isLayoutId` on a node's `id`, narrowing the node. Internal. */
export function hasLayoutId(layout: unknown): layout is { id: string } {
  return isLayoutId((layout as { id?: unknown } | null | undefined)?.id);
}

export interface GridOptions {
  /** This container's stable identity, one namespace with widget ids (IR 2.4.0, ADR 0101). */
  id?: string;
  columns: number;
  gap?: number;
  /** A section heading (IR 2.1.0). */
  title?: string;
  /** What this container is to a renderer that knows it (IR 2.2.0; see `isLayoutRole`). */
  role?: string;
  children: Array<GridCell | Widget | Layout>;
}

export function grid(options: GridOptions): GridLayout {
  return {
    type: "grid",
    ...(options.id !== undefined && { id: options.id }),
    columns: options.columns,
    ...(options.gap !== undefined && { gap: options.gap }),
    ...(options.title !== undefined && { title: options.title }),
    ...(options.role !== undefined && { role: options.role }),
    children: options.children.map(asCell),
  };
}

export interface FlexOptions {
  /** This container's stable identity, one namespace with widget ids (IR 2.4.0, ADR 0101). */
  id?: string;
  direction?: "row" | "column";
  gap?: number;
  /** A section heading (IR 2.1.0). */
  title?: string;
  /** What this container is to a renderer that knows it (IR 2.2.0; see `isLayoutRole`). */
  role?: string;
  children: Array<Widget | Layout>;
}

export function flex(options: FlexOptions): FlexLayout {
  return {
    type: "flex",
    ...(options.id !== undefined && { id: options.id }),
    direction: options.direction ?? "row",
    ...(options.gap !== undefined && { gap: options.gap }),
    ...(options.title !== undefined && { title: options.title }),
    ...(options.role !== undefined && { role: options.role }),
    children: options.children,
  };
}

export interface StackOptions {
  /** This container's stable identity, one namespace with widget ids (IR 2.4.0, ADR 0101). */
  id?: string;
  gap?: number;
  /** A section heading (IR 2.1.0). */
  title?: string;
  /** What this container is to a renderer that knows it (IR 2.2.0; see `isLayoutRole`). */
  role?: string;
  children: Array<Widget | Layout>;
}

export function stack(options: StackOptions): StackLayout {
  return {
    type: "stack",
    ...(options.id !== undefined && { id: options.id }),
    ...(options.gap !== undefined && { gap: options.gap }),
    ...(options.title !== undefined && { title: options.title }),
    ...(options.role !== undefined && { role: options.role }),
    children: options.children,
  };
}
