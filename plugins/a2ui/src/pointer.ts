// ── Dot-path ↔ JSON Pointer (RFC 6901) ────────────────────────────────────────
//
// Loom agent surfaces address state with dot-paths ("a.b.c", "" = root); A2UI
// binds and updates the data model with JSON Pointers ("/a/b/c", "" = whole
// document). This converts between them, escaping the two RFC 6901 reserved
// characters (`~` → `~0`, `/` → `~1`) so a segment that happens to contain them
// round-trips safely.

function escapeSegment(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** "a.b" → "/a/b"; "" → "" (the whole data model). */
export function dotPathToPointer(dotPath: string): string {
  if (dotPath === "") return "";
  return "/" + dotPath.split(".").map(escapeSegment).join("/");
}

/** Split a Loom dot-path into the segment array `getSurfaceValue` expects. */
export function dotPathToParts(dotPath: string): string[] {
  return dotPath === "" ? [] : dotPath.split(".");
}
