import type React from "react";
import type { WidgetRendererProps } from "../RendererRegistry";

// Columns come from the widget when declared. When they do not, they are derived
// from the union of the rows' keys rather than the first row's — a first-row
// sample silently drops every column the first row happens to be missing, which
// is the table equivalent of a filter nobody asked for.
function deriveColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

export const DataTableRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const props = widget.props as { columns?: string[] };
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const columns = props.columns ?? deriveColumns(rows);

  return (
    <div data-widget-kind="DataTable" data-widget-id={widget.id}>
      {widget.title && <div className="table-title">{widget.title}</div>}
      {rows.length === 0 ? (
        // An empty table and an unresolved binding are different facts, and a
        // table that renders nothing for both is how a view claims "there is
        // nothing here" when it actually means "I could not tell".
        <div className="table-empty">{value === undefined ? "—" : "no rows"}</div>
      ) : (
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              // Rows have no stable identity in the binding, so the index is the
              // only key available; the widget id scopes it to this table.
              <tr key={`${widget.id}-row-${i}`}>
                {columns.map((c) => (
                  <td key={c}>{row[c] === undefined || row[c] === null ? "" : String(row[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
