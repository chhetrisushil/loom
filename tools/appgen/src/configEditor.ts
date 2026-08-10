import ts from "typescript";

// Wire capability→tool grants into `app/config.ts` by inserting a `GrantTable`
// authorizer into the `defineConfig({...})` call (and its import). Same surgical,
// formatting-preserving splice approach as the FlowEditor: untouched config is kept
// byte-for-byte. If the config already declares an `authorizer`, we don't guess how to
// merge — we surface the grants as a note for the human to apply.

export interface GrantWireResult {
  after: string;
  notes: string[];
  changed: boolean;
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

export function wireGrantsIntoConfig(
  src: string,
  grants: Record<string, readonly string[]>,
  fileName = "config.ts"
): GrantWireResult {
  const notes: string[] = [];
  const entries = Object.entries(grants).filter(([, tools]) => tools.length > 0);
  if (entries.length === 0) return { after: src, notes, changed: false };

  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);

  let obj: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (obj !== undefined) return;
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "defineConfig") {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) obj = arg;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (obj === undefined) {
    notes.push("no defineConfig({...}) found — grants not wired");
    return { after: src, notes, changed: false };
  }

  const hasAuthorizer = obj.properties.some(
    (p) => ts.isPropertyAssignment(p) && p.name.getText() === "authorizer"
  );
  if (hasAuthorizer) {
    notes.push(
      `config already declares an \`authorizer\` — add these grants manually: ${JSON.stringify(grants)}`
    );
    return { after: src, notes, changed: false };
  }

  const splices: Splice[] = [];

  const hasImport =
    /import\s*\{[^}]*\bGrantTable\b[^}]*\}\s*from\s*["']@loom\/effect-runtime["']/.test(src);
  if (!hasImport) {
    let lastImportEnd = 0;
    for (const s of sf.statements) if (ts.isImportDeclaration(s)) lastImportEnd = s.getEnd();
    splices.push({
      start: lastImportEnd,
      end: lastImportEnd,
      text: '\nimport { GrantTable } from "@loom/effect-runtime";',
    });
  }

  const grantLines = entries
    .map(
      ([cap, tools]) =>
        `    ${JSON.stringify(cap)}: [${tools.map((t) => JSON.stringify(t)).join(", ")}],`
    )
    .join("\n");
  const closeBrace = obj.getEnd() - 1; // the object's `}`
  splices.push({
    start: closeBrace,
    end: closeBrace,
    text: `  security: { authorizer: new GrantTable({\n${grantLines}\n  }) },\n`,
  });

  let after = src;
  for (const sp of splices.sort((a, b) => b.start - a.start)) {
    after = after.slice(0, sp.start) + sp.text + after.slice(sp.end);
  }
  notes.push(`wired grants into defineConfig for: ${entries.map(([c]) => c).join(", ")}`);
  return { after, notes, changed: true };
}
