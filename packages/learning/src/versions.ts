import { createHash } from "node:crypto";
import type { Trajectory, TrajectoryStep, VersionRef } from "./types";

// ── Content-addressed prompt and model versions (R18, ADR 0124) ──────────────
//
// A prompt template or a model configuration is a versioned artifact: change one word of the
// system prompt, or the temperature, and you have a different policy. "Which prompt produced this
// answer" has to be answerable from the log, and a human-assigned version number is a promise
// nobody keeps. So the version IS the content's hash: two deployments with byte-identical
// templates share a version, and a one-character edit cannot reuse the old one.
//
// The ref is plain data (`{ id, version }`) recorded in a decision's `policy.refs`, never read by
// replay (a decision's `choice` is the sole replay input, P9), so adding it changes no existing
// log and no replay.

/** JSON with object keys sorted at every depth: equal content, equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, 0));
}

const MAX_DEPTH = 64;

function sortKeys(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("canonicalJson: value nested too deeply");
  if (Array.isArray(value)) return value.map((v) => sortKeys(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJson: a non-finite number has no canonical form");
  }
  return value;
}

/** `sha256:<hex>` of the canonical form of `value`. */
export function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

const REF_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function checkId(kind: string, id: string): string {
  if (!REF_ID.test(id)) {
    throw new Error(`${kind}: id must match ${REF_ID} (got ${JSON.stringify(id)})`);
  }
  return id;
}

/**
 * The version of a prompt template: its text (or a structured template, e.g. the message list),
 * hashed. `id` names the slot ("triage-system"); the version is the content.
 */
export function promptVersion(id: string, template: string | Record<string, unknown>): VersionRef {
  return { id: checkId("promptVersion", id), version: contentHash({ prompt: template }) };
}

/**
 * The version of a model configuration: provider/model name and every parameter that changes
 * what comes back (temperature, max tokens, tool set, ...). Pass the whole config; leaving a
 * parameter out of the hash means two different configs share a version.
 */
export function modelVersion(id: string, config: Record<string, unknown>): VersionRef {
  return { id: checkId("modelVersion", id), version: contentHash({ model: config }) };
}

/** Whether `ref` is the version of exactly this content (a catalog integrity check). */
export function refMatches(
  ref: VersionRef,
  kind: "prompt" | "model",
  content: string | Record<string, unknown>
): boolean {
  return ref.version === contentHash({ [kind]: content });
}

/**
 * Group trajectory steps by a version recorded in their decision stamp, so an evaluation can be
 * sliced "by prompt" or "by model". A step with no recorded ref lands under `"(unversioned)"` -
 * an honest bucket, never merged into a real version.
 */
export function sliceByVersion<A>(
  trajectories: readonly Trajectory<A>[],
  by: "prompt" | "model" | "policy"
): Map<string, Trajectory<A>[]> {
  const out = new Map<string, Trajectory<A>[]>();
  for (const t of trajectories) {
    const groups = new Map<string, TrajectoryStep<A>[]>();
    for (const s of t.steps) {
      const ref =
        by === "policy"
          ? s.policy !== undefined
            ? { id: s.policy.id, version: s.policy.version }
            : undefined
          : s.policy?.refs?.[by];
      const key = ref === undefined ? "(unversioned)" : `${ref.id}@${ref.version}`;
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [s]);
      else list.push(s);
    }
    for (const [key, list] of groups) {
      const bucket = out.get(key) ?? [];
      bucket.push({ ...t, steps: list });
      out.set(key, bucket);
    }
  }
  return out;
}
