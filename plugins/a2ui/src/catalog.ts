import type { ComponentInstance } from "./messages";

// ── A2UI catalogs ──────────────────────────────────────────────────────────────
//
// A catalog is load-bearing in A2UI, not optional: `createSurface` names a
// `catalogId`, and every component declares a `component` type the client can
// only render if that type is defined in a catalog it knows. Catalogs are JSON
// Schema documents (component/function/surfaceProperties vocabularies); this
// plugin ships one small, curated default catalog sufficient to render Loom
// surfaces, plus `defineCatalog` so an app can supply its own richer one.
//
// Client-side `functions` — the vocabulary the agent may `callFunction` on the
// client and receive a `functionResponse` for — are declared here (see ADR
// 0070). Continuous two-way *binding sync* (live data-model reconciliation)
// remains out of scope.

export interface CatalogComponentSchema {
  /** JSON-Schema discriminator — routes a node to this component type. */
  component: { const: string };
  /** Type-specific property schemas (kept loose in the MVP). */
  properties?: Record<string, unknown>;
}

/**
 * A client-callable function the agent may invoke via `callFunction`. `args` /
 * `returns` are JSON-Schema documents (kept loose here, mirroring the component
 * schemas); `callableFrom` optionally scopes which surface region may originate
 * the call (A2UI catalog boundary).
 */
export interface CatalogFunctionSchema {
  name: string;
  args?: Record<string, unknown>;
  returns?: Record<string, unknown>;
  callableFrom?: string;
}

export interface A2UICatalog {
  id: string;
  components: Record<string, CatalogComponentSchema>;
  functions?: Record<string, CatalogFunctionSchema>;
  surfaceProperties?: Record<string, unknown>;
}

/** Identity helper — declare a BYO catalog with inferred types. */
export function defineCatalog(catalog: A2UICatalog): A2UICatalog {
  return catalog;
}

/** Identity helper — declare a client-callable function with inferred types. */
export function defineFunction(fn: CatalogFunctionSchema): CatalogFunctionSchema {
  return fn;
}

export const DEFAULT_CATALOG_ID = "loom.core.v1";

// A minimal component vocabulary: layout (Column/Row), text (Text/Badge),
// a data-bound List (template iteration), and a Button that raises an action.
export const defaultCatalog: A2UICatalog = {
  id: DEFAULT_CATALOG_ID,
  components: {
    Text: {
      component: { const: "Text" },
      properties: { text: { $ref: "common_types.json#/DynamicString" } },
    },
    Badge: {
      component: { const: "Badge" },
      properties: {
        label: { $ref: "common_types.json#/DynamicString" },
        tone: { $ref: "common_types.json#/DynamicString" },
      },
    },
    Column: {
      component: { const: "Column" },
      properties: { children: { $ref: "common_types.json#/ChildList" } },
    },
    Row: {
      component: { const: "Row" },
      properties: { children: { $ref: "common_types.json#/ChildList" } },
    },
    List: {
      component: { const: "List" },
      properties: { children: { $ref: "common_types.json#/ChildList" } },
    },
    Button: {
      component: { const: "Button" },
      properties: {
        label: { $ref: "common_types.json#/DynamicString" },
        action: { $ref: "common_types.json#/DynamicString" },
      },
    },
  },
};

// ── Component builders (authoring DX) ──────────────────────────────────────────
//
// A data binding is `{ path: "<JSON Pointer>" }`; a literal is the bare value.

export type Dynamic<T> = T | { path: string };

/** Bind a prop to a JSON Pointer into the surface data model. */
export function bind(pointer: string): { path: string } {
  return { path: pointer };
}

export function text(id: string, value: Dynamic<string>): ComponentInstance {
  return { id, component: "Text", text: value };
}

export function badge(
  id: string,
  label: Dynamic<string>,
  tone?: Dynamic<string>
): ComponentInstance {
  return { id, component: "Badge", label, ...(tone !== undefined && { tone }) };
}

export function column(id: string, children: string[]): ComponentInstance {
  return { id, component: "Column", children };
}

export function row(id: string, children: string[]): ComponentInstance {
  return { id, component: "Row", children };
}

/**
 * A data-bound list: iterate the array at `path` (JSON Pointer), rendering
 * `itemComponentId` once per item. Relative bindings inside the item component
 * resolve against the current element (A2UI collection scope).
 */
export function list(id: string, path: string, itemComponentId: string): ComponentInstance {
  return { id, component: "List", children: { path, componentId: itemComponentId } };
}

export function button(id: string, label: Dynamic<string>, action: string): ComponentInstance {
  return { id, component: "Button", label, action };
}

/**
 * A throwaway view that renders the whole data model as JSON text — handy for a
 * demo or a first render before a real component tree is authored. A2UI
 * stringifies a non-string DynamicString bound to an object.
 */
export function jsonDebugView(): ComponentInstance[] {
  return [text("root", bind(""))];
}
