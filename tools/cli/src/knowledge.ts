import * as fs from "node:fs";
import * as path from "node:path";
import type { LoomApp } from "@loom/app";
import type { KnowledgeBase, KnowledgeDoc, SyncResult } from "@loom/knowledge";

// ── `loom knowledge` — operating a corpus from outside a flow ────────────────
//
// Three things an application cannot do for you, and that everyone ends up writing
// a one-off script for: get a directory of documents into a corpus, see what is in
// one, and ask it a question to find out why retrieval returned what it did.
//
// Two rules hold this command together:
//
//  - `sync` is a DESTRUCTIVE reconcile. `docs` is the complete set, so a document the
//    directory no longer contains is deleted from the corpus. It therefore defaults to a
//    dry run and writes only under `--apply`, the same gate `loom retention run` and
//    `loom sweep content` use — and the preview goes through `KnowledgeBase.planSync`, the
//    same classification `sync` itself runs, so it is a preview of the real operation.
//  - a retrieval run from here is NOT a recorded decision. Inside a flow, `retrieve`
//    requires `ctx.decide` because a corpus changes between a run and its replay. An
//    operator query has no execution to record into, which is the escape hatch ADR 0090
//    named — visible in the code, and printed in the output so a transcript of this
//    command is never mistaken for what an execution saw.

/** A file the walk deliberately did not ingest, and why. Never silent. */
export interface SkippedFile {
  file: string;
  reason: string;
}

export interface CorpusDocs {
  docs: KnowledgeDoc[];
  skipped: SkippedFile[];
}

/** Default extensions. Text formats only: a corpus is what a person can read and edit. */
const DEFAULT_EXTENSIONS = ["md", "txt"];
/** Per-file ceiling. One accidentally-committed dump should not become the whole corpus. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** `# Heading` on the first non-empty line, else the file name without its extension. */
function titleOf(relative: string, text: string): string {
  for (const line of text.split("\n", 20)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    return heading?.[1]?.trim() ?? path.basename(relative, path.extname(relative));
  }
  return path.basename(relative, path.extname(relative));
}

/**
 * Read a directory tree into documents.
 *
 * The document id is the POSIX-style path relative to `dir`, which is stable across
 * platforms and is what makes a second `sync` recognise the same document. Nothing goes
 * into `meta`: a passage's `meta` is indexed as searchable text, so stamping the path
 * there would make every path segment a relevance term — and the id, which is that path,
 * is deliberately not indexed.
 */
export function readCorpusDir(
  dir: string,
  opts: { extensions?: string[]; maxBytes?: number } = {}
): CorpusDocs {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`knowledge sync: --dir "${dir}" is not a directory`);
  }
  const extensions = new Set((opts.extensions ?? DEFAULT_EXTENSIONS).map((e) => `.${e}`));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const docs: KnowledgeDoc[] = [];
  const skipped: SkippedFile[] = [];

  const walk = (current: string): void => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      // Symlinks are not followed: a link out of the tree would ingest a file the
      // operator never pointed at, and a link back into it would ingest one twice under
      // two ids — which `sync` would then treat as two documents forever.
      if (entry.isSymbolicLink()) {
        skipped.push({ file: path.relative(root, full), reason: "symlink (not followed)" });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const size = fs.statSync(full).size;
      if (size > maxBytes) {
        skipped.push({ file: relative, reason: `${size} bytes exceeds the ${maxBytes}-byte cap` });
        continue;
      }
      const text = fs.readFileSync(full, "utf-8");
      if (text.trim().length === 0) {
        skipped.push({ file: relative, reason: "empty" });
        continue;
      }
      docs.push({ id: relative, title: titleOf(relative, text), text });
    }
  };
  walk(root);
  return { docs, skipped };
}

/** Load a built config module and return its LoomApp, the way `loom verify` does. */
function loadApp(configPath: string): LoomApp {
  const mod = require(path.resolve(configPath)) as { default?: unknown; app?: unknown };
  const app = (mod.default ?? mod.app ?? mod) as Partial<LoomApp>;
  if (typeof app.knowledge !== "function") {
    throw new Error(
      "config module must default-export a LoomApp from defineConfig(...) (no knowledge() found)"
    );
  }
  return app as LoomApp;
}

/**
 * Open the corpus, refusing an app whose `memoryStore` was never configured.
 *
 * That app has a working corpus backed by the in-memory default, which is right for a
 * test and useless here: this process would ingest a directory into a store that is
 * discarded when it exits, print a successful-looking summary, and leave nothing behind.
 */
function openCorpus(app: LoomApp, scope: string): KnowledgeBase {
  if (app.stores.memoryStore === undefined) {
    throw new Error(
      "the config sets no `memoryStore`, so its corpus lives in a store this process throws away on exit. Wire a durable one (`memoryStore: new SqliteMemoryStore(...)`) before operating a corpus from the CLI."
    );
  }
  return app.knowledge(scope);
}

function summarize(plan: SyncResult): string {
  const line = (label: string, ids: string[]): string =>
    ids.length === 0 ? `  ${label}: none` : `  ${label} (${ids.length}): ${ids.join(", ")}`;
  return [
    line("write", plan.written),
    line("unchanged", plan.unchanged),
    line("REMOVE", plan.removed),
  ].join("\n");
}

export async function cmdKnowledgeSync(opts: {
  config: string;
  scope: string;
  dir: string;
  extensions?: string[];
  maxBytes?: number;
  apply?: boolean;
}): Promise<{ text: string; result: SyncResult }> {
  const app = loadApp(opts.config);
  try {
    const kb = openCorpus(app, opts.scope);
    const { docs, skipped } = readCorpusDir(opts.dir, {
      ...(opts.extensions !== undefined && { extensions: opts.extensions }),
      ...(opts.maxBytes !== undefined && { maxBytes: opts.maxBytes }),
    });
    const plan = opts.apply === true ? await kb.sync(docs) : await kb.planSync(docs);

    const lines = [
      `knowledge sync: ${docs.length} document(s) from ${path.resolve(opts.dir)} → "${opts.scope}"`,
      summarize(plan),
    ];
    if (skipped.length > 0) {
      // Reported, never silent: a file the corpus does not contain is the answer to a
      // "why did retrieval miss that" question nobody would otherwise be able to answer.
      lines.push(`  skipped (${skipped.length}):`);
      for (const s of skipped) lines.push(`    ${s.file} — ${s.reason}`);
    }
    lines.push(
      opts.apply === true
        ? "  applied."
        : "  dry run — nothing written. Re-run with --apply. NOTE: `REMOVE` deletes documents the directory no longer contains."
    );
    return { text: lines.join("\n"), result: plan };
  } finally {
    await app.close();
  }
}

export async function cmdKnowledgeSearch(opts: {
  config: string;
  scope: string;
  query: string;
  limit?: number;
}): Promise<{ text: string; hits: number }> {
  const app = loadApp(opts.config);
  try {
    const kb = openCorpus(app, opts.scope);
    // The operator bypass, deliberately visible: there is no execution to record into,
    // so this pass-through `decide` computes and returns. A flow MUST pass `ctx.decide`.
    const passages = await kb.retrieve(opts.query, {
      decide: async (_key, compute) => compute(),
      ...(opts.limit !== undefined && { limit: opts.limit }),
    });
    const lines = [
      `knowledge search "${opts.query}" in "${opts.scope}" — ${passages.length} hit(s)`,
    ];
    for (const p of passages) {
      const text = p.text.value.replace(/\s+/g, " ").trim();
      lines.push(`  ${p.docId}#${p.index}${p.title !== undefined ? ` — ${p.title}` : ""}`);
      lines.push(`    ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
    }
    lines.push(
      "  (operator query — NOT a recorded retrieval; inside a flow this goes through ctx.decide)"
    );
    return { text: lines.join("\n"), hits: passages.length };
  } finally {
    await app.close();
  }
}

export async function cmdKnowledgeList(opts: {
  config: string;
  scope: string;
}): Promise<{ text: string; docs: number }> {
  const app = loadApp(opts.config);
  try {
    const records = await openCorpus(app, opts.scope).listDocs();
    const lines = [`knowledge list "${opts.scope}" — ${records.length} document(s)`];
    for (const r of records) {
      // An uncommitted row means a crash between the manifest write and the passages;
      // the next sync rewrites it. Showing it beats a corpus that looks complete.
      const state = r.committed ? "" : "  [uncommitted — will be rewritten on next sync]";
      lines.push(`  ${r.docId}  ${r.chunkCount} passage(s)  ${r.fingerprint}${state}`);
    }
    return { text: lines.join("\n"), docs: records.length };
  } finally {
    await app.close();
  }
}
