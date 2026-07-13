import MagicString from "magic-string";
import ts from "typescript";
import { shortHash } from "./hash";
import type { ExtractedChunk, FlowEntry, PluginState, SkillEntry, StepEntry } from "./types";

const VIRTUAL_PREFIX = "\0loom:chunk:";

export function transformFile(
  sourceText: string,
  absolutePath: string,
  pluginState: PluginState
): { code: string; map: string } | null {
  if (
    !sourceText.includes("step$") &&
    !sourceText.includes("flow$") &&
    !sourceText.includes("skill$")
  ) {
    return null;
  }

  const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.ESNext, true);

  const ms = new MagicString(sourceText);
  const importLines = collectImportLines(sourceFile, sourceText);
  const localSteps: StepEntry[] = [];
  let modified = false;

  ts.forEachChild(sourceFile, function visit(node: ts.Node): void {
    if (tryProcessStep(node, absolutePath, importLines, ms, localSteps, pluginState)) {
      modified = true;
    }
    if (tryProcessSkill(node, absolutePath, importLines, ms, pluginState)) {
      modified = true;
    }
    ts.forEachChild(node, visit);
  });

  collectFlows(sourceFile, sourceText, localSteps, pluginState, absolutePath);

  if (!modified) return null;
  return {
    code: ms.toString(),
    map: ms.generateMap({ hires: true, source: absolutePath }).toString(),
  };
}

function tryProcessStep(
  node: ts.Node,
  absolutePath: string,
  importLines: string[],
  ms: MagicString,
  localSteps: StepEntry[],
  pluginState: PluginState
): boolean {
  // Match a `step$({...})` call WHEREVER it appears (the walk visits every node): a direct
  // variable initializer `const Foo = step$(...)` — from which we capture the var name so a
  // flow's `steps: [Foo]` array can resolve it — OR inline inside that array. Same robustness
  // as flow$ detection; the old variable-only gate silently skipped inline/wrapped steps.
  if (!(ts.isCallExpression(node) && isCallTo(node, "step$") && node.arguments.length > 0)) {
    return false;
  }
  const callNode = node;
  const varName = declaredVarName(node); // undefined for an inline step$(...)

  const argObj = callNode.arguments[0];
  if (!argObj || !ts.isObjectLiteralExpression(argObj)) return false;

  const idProp = findProperty(argObj, "id");
  const handlerProp = findProperty(argObj, "handler");
  const toolIdProp = findProperty(argObj, "toolId");

  const stepId = idProp ? getStringLiteral(idProp.initializer) : undefined;
  if (!stepId) return false;

  const toolId = toolIdProp ? getStringLiteral(toolIdProp.initializer) : undefined;

  const stepEntry: StepEntry = {
    id: stepId,
    varName: varName ?? stepId,
    hasHandler: false,
    ...(toolId !== undefined && { toolId }),
    sourceFile: absolutePath,
  };

  if (
    handlerProp &&
    ts.isPropertyAssignment(handlerProp) &&
    ts.isCallExpression(handlerProp.initializer) &&
    isCallTo(handlerProp.initializer, "handler$") &&
    handlerProp.initializer.arguments.length > 0
  ) {
    const fn = handlerProp.initializer.arguments[0]!;
    const fnText = sourceText(ms, fn);
    const hash = shortHash(absolutePath + stepId);
    const chunkVirtualId = `${VIRTUAL_PREFIX}${stepId}_${hash}`;
    const chunkSrc = buildChunkSource(importLines, fnText);

    const chunk: ExtractedChunk = {
      stepId,
      kind: "step",
      chunkVirtualId,
      chunkSource: chunkSrc,
      sourceFile: absolutePath,
      hash,
    };
    pluginState.chunks.set(chunkVirtualId, chunk);

    ms.overwrite(
      handlerProp.initializer.getStart(),
      handlerProp.initializer.getEnd(),
      `() => import("${chunkVirtualId}")`
    );

    stepEntry.hasHandler = true;
    stepEntry.chunkVirtualId = chunkVirtualId;
    stepEntry.hash = hash;
  }

  if (varName) pluginState.stepsByVarName.set(varName, stepId);
  pluginState.steps.set(stepId, stepEntry);
  localSteps.push(stepEntry);

  return stepEntry.hasHandler;
}

// Match: const Foo = skill$({ ..., instructions: instructions$("...") })
// and extract the instruction body into its own lazy chunk, exactly as
// tryProcessStep does for handler$ — so only selected skills load their text.
function tryProcessSkill(
  node: ts.Node,
  absolutePath: string,
  importLines: string[],
  ms: MagicString,
  pluginState: PluginState
): boolean {
  // Detect `skill$({...})` wherever it appears (direct var initializer or nested, e.g. inside
  // an agent's skill list) — same robustness as step$/flow$.
  if (!(ts.isCallExpression(node) && isCallTo(node, "skill$") && node.arguments.length > 0)) {
    return false;
  }
  const callNode = node;
  const varName = declaredVarName(node);

  const argObj = callNode.arguments[0];
  if (!argObj || !ts.isObjectLiteralExpression(argObj)) return false;

  const idProp = findProperty(argObj, "id");
  const instructionsProp = findProperty(argObj, "instructions");
  const skillId = idProp ? getStringLiteral(idProp.initializer) : undefined;
  if (!skillId) return false;

  const skillEntry: SkillEntry = {
    id: skillId,
    varName: varName ?? skillId,
    sourceFile: absolutePath,
  };

  if (
    instructionsProp &&
    ts.isPropertyAssignment(instructionsProp) &&
    ts.isCallExpression(instructionsProp.initializer) &&
    isCallTo(instructionsProp.initializer, "instructions$") &&
    instructionsProp.initializer.arguments.length > 0
  ) {
    // The body is a string/template literal; extract its exact source and emit
    // it as the chunk's default export.
    const bodyText = sourceText(ms, instructionsProp.initializer.arguments[0]!);
    const hash = shortHash(absolutePath + skillId);
    const chunkVirtualId = `${VIRTUAL_PREFIX}${skillId}_${hash}`;
    const chunkSrc = buildChunkSource(importLines, bodyText);

    pluginState.chunks.set(chunkVirtualId, {
      stepId: skillId,
      kind: "skill",
      chunkVirtualId,
      chunkSource: chunkSrc,
      sourceFile: absolutePath,
      hash,
    });

    ms.overwrite(
      instructionsProp.initializer.getStart(),
      instructionsProp.initializer.getEnd(),
      `() => import("${chunkVirtualId}")`
    );

    skillEntry.chunkVirtualId = chunkVirtualId;
    skillEntry.hash = hash;
  }

  if (varName) pluginState.skillsByVarName.set(varName, skillId);
  pluginState.skills.set(skillId, skillEntry);

  return skillEntry.chunkVirtualId !== undefined;
}

function collectFlows(
  sourceFile: ts.SourceFile,
  _sourceText: string,
  _localSteps: StepEntry[],
  pluginState: PluginState,
  absolutePath: string
): void {
  ts.forEachChild(sourceFile, function visit(node: ts.Node): void {
    // Match a `flow$(...)` call WHEREVER it appears — not only as a direct variable
    // initializer (`const f = flow$(...)`), but also nested inside the idiomatic
    // `RegisteredFlow` shape `const f = { definition: flow$(...), runner } as RegisteredFlow`.
    // The walk recurses into every child (below), so matching the call node directly catches
    // both; the previous variable-initializer-only check missed the object-wrapped form and
    // emitted an empty `flows` map for real apps.
    if (ts.isCallExpression(node) && isCallTo(node, "flow$") && node.arguments.length > 0) {
      const argObj = node.arguments[0];
      if (argObj && ts.isObjectLiteralExpression(argObj)) {
        const idProp = findProperty(argObj, "id");
        const versionProp = findProperty(argObj, "version");
        const stepsProp = findProperty(argObj, "steps");

        const flowId = idProp ? getStringLiteral(idProp.initializer) : undefined;
        const version = versionProp ? getStringLiteral(versionProp.initializer) : "0.0.0";
        if (!flowId) return;

        const stepIds: string[] = [];
        if (
          stepsProp &&
          ts.isPropertyAssignment(stepsProp) &&
          ts.isArrayLiteralExpression(stepsProp.initializer)
        ) {
          for (const el of stepsProp.initializer.elements) {
            if (ts.isIdentifier(el)) {
              // A referenced step variable: `steps: [assessStep, …]`.
              const resolvedId = pluginState.stepsByVarName.get(el.text);
              if (resolvedId) stepIds.push(resolvedId);
            } else if (
              ts.isCallExpression(el) &&
              isCallTo(el, "step$") &&
              el.arguments.length > 0
            ) {
              // An inline step: `steps: [step$({ id: "…" }), …]` — read its id directly.
              const arg = el.arguments[0];
              const idProp =
                arg && ts.isObjectLiteralExpression(arg) ? findProperty(arg, "id") : undefined;
              const inlineId = idProp ? getStringLiteral(idProp.initializer) : undefined;
              if (inlineId) stepIds.push(inlineId);
            }
          }
        }

        // Heuristic: detect suspend points from runner source text
        const suspendPoints = detectSuspendPoints(_sourceText, stepIds, pluginState);

        pluginState.flows.set(flowId, {
          id: flowId,
          version: version ?? "0.0.0",
          stepIds,
          suspendPoints,
          sourceFile: absolutePath,
        } satisfies FlowEntry);
      }
    }

    ts.forEachChild(node, visit);
  });
}

function detectSuspendPoints(
  sourceText: string,
  stepIds: string[],
  pluginState: PluginState
): string[] {
  // Heuristic: a step is a suspend point if the source file contains ctx.suspend(
  // near a ctx.run(StepVar) reference and the step has kind "human" or HumanEffect.
  // V1: mark any step whose effect entry has no handler and no toolId — assume human.
  // A more precise analysis requires full AST traversal of runner bodies.
  const suspendPoints: string[] = [];
  if (sourceText.includes("ctx.suspend(") || sourceText.includes("HumanEffect")) {
    for (const id of stepIds) {
      const entry = pluginState.steps.get(id);
      if (entry && !entry.hasHandler && !entry.toolId) {
        suspendPoints.push(id);
      }
    }
  }
  return suspendPoints;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function collectImportLines(sourceFile: ts.SourceFile, text: string): string[] {
  const lines: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      // Skip type-only imports — they're erased at runtime and Rollup can't parse them
      const raw = text.slice(statement.getStart(), statement.getEnd());
      if (raw.startsWith("import type ")) continue;
      lines.push(text.slice(statement.getStart(), statement.getEnd()));
    }
  }
  return lines;
}

function buildChunkSource(importLines: string[], fnText: string): string {
  return [
    "// @loom/compiler — generated chunk (do not edit)",
    ...importLines,
    "",
    `export default ${fnText};`,
    "",
  ].join("\n");
}

function isCallTo(node: ts.CallExpression, name: string): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === name;
}

/** The variable name a call initializes (`const Foo = call(...)`), or undefined if it's inline. */
function declaredVarName(call: ts.CallExpression): string | undefined {
  const parent = call.parent;
  return parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? parent.name.text
    : undefined;
}

function findProperty(
  obj: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) {
      return prop;
    }
  }
  return undefined;
}

function getStringLiteral(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function sourceText(ms: MagicString, node: ts.Node): string {
  return ms.original.slice(node.getStart(), node.getEnd());
}
