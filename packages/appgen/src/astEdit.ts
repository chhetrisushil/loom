import ts from "typescript";
import { stepConstName, stepConstSource } from "./stepTemplate";
import { isStubBody } from "./stub";

// ── Surgical, formatting-preserving edits to an existing flow.ts ──────────────
//
// Self-contained: appgen owns this small edit toolkit (a TS-AST reader + an offset
// splice buffer) rather than depending on the compiler's transform pass or a heavier
// AST-rewrite library. Every edit is a splice into the ORIGINAL source, so untouched
// code — including a human's formatting and comments — is preserved byte-for-byte,
// which keeps the `--dry-run` diff honest. The model never emits source through here:
// callers pass intent (add this step, add an approval gate); the editor emits the code.

interface Splice {
  start: number;
  end: number;
  text: string;
}

function isCallTo(
  node: ts.Node | undefined,
  name: string,
  sf: ts.SourceFile
): node is ts.CallExpression {
  return node !== undefined && ts.isCallExpression(node) && node.expression.getText(sf) === name;
}

function propInit(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
  }
  return undefined;
}

export class FlowEditor {
  private readonly sf: ts.SourceFile;
  private readonly splices: Splice[] = [];
  /** Human-readable summary of the edits applied (surfaced in the plan/diff). */
  readonly notes: string[] = [];

  constructor(
    private readonly src: string,
    fileName = "flow.ts"
  ) {
    this.sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  }

  /** Ids of the steps already declared in this flow (`step$({ id: ... })`). */
  existingStepIds(): string[] {
    const ids: string[] = [];
    const visit = (node: ts.Node): void => {
      if (isCallTo(node, "step$", this.sf)) {
        const obj = node.arguments[0];
        if (obj !== undefined && ts.isObjectLiteralExpression(obj)) {
          const init = propInit(obj, "id");
          if (init !== undefined && ts.isStringLiteralLike(init)) ids.push(init.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
    return ids;
  }

  /**
   * Add a new step: insert its `step$` const after the last existing step const,
   * register it in the flow's `steps: [...]` array, and wire a `ctx.run(...)` call into
   * the runner before its `return`. A no-op (recorded as a note) if a step with this id
   * already exists.
   */
  addStep(id: string): void {
    if (this.existingStepIds().includes(id)) {
      this.notes.push(`step "${id}" already present — left as-is`);
      return;
    }
    const anchor = this.lastStepConstEnd();
    if (anchor === undefined) {
      this.notes.push(`could not locate a step const to anchor new step "${id}"`);
      return;
    }
    this.splices.push({ start: anchor, end: anchor, text: `\n\n${stepConstSource(id)}` });
    this.registerInStepsArray(id);
    const name = stepConstName(id);
    const wired = this.insertStmtBeforeReturn(
      `  await ctx.run(${name}, { prompt: input.prompt });\n`
    );
    this.notes.push(
      wired
        ? `added step "${id}" (registered and wired into the runner)`
        : `added step "${id}" (registered; wire it into the runner)`
    );
  }

  /**
   * Remove a step: delete its `step$` const, its entry in the flow's `steps: [...]`
   * array, and any bare `ctx.run(...)` call for it in the runner. Refuses (with a note)
   * to delete a step whose handler has been hand-edited — that code is the human's to
   * remove. Returns true if removed.
   */
  removeStep(id: string): boolean {
    let stmt: ts.VariableStatement | undefined;
    let constName: string | undefined;
    let edited = false;
    for (const s of this.sf.statements) {
      if (!ts.isVariableStatement(s)) continue;
      const decl = s.declarationList.declarations[0];
      if (decl === undefined) continue;
      const init = decl.initializer;
      if (!isCallTo(init, "step$", this.sf)) continue;
      const obj = init.arguments[0];
      if (obj === undefined || !ts.isObjectLiteralExpression(obj)) continue;
      const idInit = propInit(obj, "id");
      if (idInit === undefined || !ts.isStringLiteralLike(idInit) || idInit.text !== id) continue;
      stmt = s;
      constName = decl.name.getText(this.sf);
      const handler = propInit(obj, "handler");
      if (isCallTo(handler, "handler$", this.sf) && handler.arguments[0] !== undefined) {
        edited = !isStubBody(id, handler.arguments[0].getText(this.sf));
      }
    }
    if (stmt === undefined || constName === undefined) {
      this.notes.push(`step "${id}" not found — cannot delete`);
      return false;
    }
    if (edited) {
      this.notes.push(`step "${id}" has hand-edited code — not deleted (remove it manually)`);
      return false;
    }
    this.spliceOutStatement(stmt);
    this.removeFromStepsArray(constName);
    this.removeRunnerCall(constName);
    this.notes.push(`removed step "${id}"`);
    return true;
  }

  /** Insert a durable approval suspend gate into the runner, unless one already exists. */
  ensureApprovalGate(): void {
    if (/ctx\.suspend\s*\(/.test(this.src)) {
      this.notes.push("approval gate already present — left as-is");
      return;
    }
    this.insertBeforeRunnerReturn(
      '  // Pause for a human approval — a durable suspend gate; resume with { eventType: "Approved" }.\n' +
        '  await ctx.suspend({ on: "Approved" });\n',
      "added approval gate (ctx.suspend)"
    );
  }

  /** Insert a durable UI surface write into the runner, unless one already exists. */
  ensureUi(): void {
    if (/ctx\.ui\.set\s*\(/.test(this.src)) {
      this.notes.push("UI surface already present — left as-is");
      return;
    }
    this.insertBeforeRunnerReturn(
      '  ctx.ui.set("status", "done"); // durable, replayable UI surface\n',
      "added UI surface (ctx.ui.set)"
    );
  }

  /**
   * Replace a step's handler body — ONLY if it is still the untouched generated stub.
   * Returns true if replaced, false if the handler was human-edited (insert-only). This
   * is the safety gate: appgen never clobbers code a human has touched.
   */
  replaceStubBody(stepId: string, newBody: string): boolean {
    let target: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (target !== undefined) return;
      if (isCallTo(node, "step$", this.sf)) {
        const obj = node.arguments[0];
        if (obj !== undefined && ts.isObjectLiteralExpression(obj)) {
          const id = propInit(obj, "id");
          if (id !== undefined && ts.isStringLiteralLike(id) && id.text === stepId) {
            const handler = propInit(obj, "handler");
            if (isCallTo(handler, "handler$", this.sf) && handler.arguments[0] !== undefined) {
              target = handler.arguments[0];
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);

    if (target === undefined) {
      this.notes.push(`step "${stepId}" not found — cannot modify`);
      return false;
    }
    if (!isStubBody(stepId, target.getText(this.sf))) {
      this.notes.push(`step "${stepId}" handler was hand-edited — left untouched (insert-only)`);
      return false;
    }
    this.splices.push({ start: target.getStart(this.sf), end: target.getEnd(), text: newBody });
    this.notes.push(`implemented step "${stepId}" (was an untouched stub)`);
    return true;
  }

  /** Whether any edit has been staged. */
  changed(): boolean {
    return this.splices.length > 0;
  }

  /** Apply all staged splices to the original source (highest offset first). */
  toString(): string {
    let out = this.src;
    for (const sp of [...this.splices].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, sp.start) + sp.text + out.slice(sp.end);
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private lastStepConstEnd(): number | undefined {
    let end: number | undefined;
    for (const stmt of this.sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      const init = stmt.declarationList.declarations[0]?.initializer;
      if (isCallTo(init, "step$", this.sf)) end = stmt.getEnd();
    }
    return end;
  }

  private registerInStepsArray(id: string): void {
    const arr = this.flowStepsArray();
    if (arr === undefined) {
      this.notes.push(`could not locate the flow "steps: [...]" array for "${id}"`);
      return;
    }
    const name = stepConstName(id);
    if (arr.elements.length === 0) {
      const pos = arr.getStart(this.sf) + 1; // just inside `[`
      this.splices.push({ start: pos, end: pos, text: name });
    } else {
      const last = arr.elements[arr.elements.length - 1]!;
      const pos = last.getEnd();
      this.splices.push({ start: pos, end: pos, text: `, ${name}` });
    }
  }

  private flowStepsArray(): ts.ArrayLiteralExpression | undefined {
    let arr: ts.ArrayLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (arr !== undefined) return;
      if (isCallTo(node, "flow$", this.sf)) {
        const obj = node.arguments[0];
        if (obj !== undefined && ts.isObjectLiteralExpression(obj)) {
          const steps = propInit(obj, "steps");
          if (steps !== undefined && ts.isArrayLiteralExpression(steps)) arr = steps;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
    return arr;
  }

  /** The runner is `(ctx, input) => { ... }`; find its block body. */
  private runnerBlock(): ts.Block | undefined {
    let block: ts.Block | undefined;
    const visit = (node: ts.Node): void => {
      if (block !== undefined) return;
      if (ts.isArrowFunction(node) && node.parameters.length >= 1) {
        const first = node.parameters[0]?.name.getText(this.sf);
        if (first === "ctx" && ts.isBlock(node.body)) {
          block = node.body;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
    return block;
  }

  private insertBeforeRunnerReturn(text: string, note: string): void {
    if (this.insertStmtBeforeReturn(text)) this.notes.push(note);
    else this.notes.push(`could not locate the runner body — skipped: ${note}`);
  }

  /** Insert `text` before the runner's final statement (its `return`). */
  private insertStmtBeforeReturn(text: string): boolean {
    const block = this.runnerBlock();
    if (block === undefined || block.statements.length === 0) return false;
    const last = block.statements[block.statements.length - 1]!;
    const pos = last.getStart(this.sf);
    const lineStart = this.src.lastIndexOf("\n", pos - 1) + 1;
    this.splices.push({ start: lineStart, end: lineStart, text });
    return true;
  }

  /** Splice out a whole statement, including its leading trivia and trailing newlines. */
  private spliceOutStatement(stmt: ts.Node): void {
    const start = stmt.getFullStart();
    let end = stmt.getEnd();
    while (end < this.src.length && this.src[end] === "\n") end++;
    this.splices.push({ start, end, text: "" });
  }

  private removeFromStepsArray(constName: string): void {
    const arr = this.flowStepsArray();
    if (arr === undefined) return;
    const els = arr.elements;
    const idx = els.findIndex((e) => e.getText(this.sf) === constName);
    if (idx < 0) return;
    const el = els[idx]!;
    if (els.length === 1) {
      this.splices.push({ start: el.getStart(this.sf), end: el.getEnd(), text: "" });
    } else if (idx === 0) {
      // drop "el, " — from this element's start to the next element's start.
      this.splices.push({ start: el.getStart(this.sf), end: els[1]!.getStart(this.sf), text: "" });
    } else {
      // drop ", el" — from the previous element's end to this element's end.
      this.splices.push({ start: els[idx - 1]!.getEnd(), end: el.getEnd(), text: "" });
    }
  }

  /** Remove a bare `ctx.run(<constName>, …)` statement from the runner (not a `const x = …`). */
  private removeRunnerCall(constName: string): void {
    const block = this.runnerBlock();
    if (block === undefined) return;
    const re = new RegExp(`ctx\\.run\\(\\s*${constName}\\b`);
    for (const s of block.statements) {
      if (ts.isExpressionStatement(s) && re.test(s.getText(this.sf))) {
        this.spliceOutStatement(s);
        return;
      }
    }
  }
}
