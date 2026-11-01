import { SANDBOX_MESSAGE_LIMIT, SANDBOX_NAME_LIMIT, boundText } from "./boundText";
import type { SandboxBackendCapabilities, SandboxOutcome } from "./types";

// ── ADR 0144 D2 — never trust a backend's shape ──────────────────────────────
//
// A third-party backend is a different package written by a different author. What it returns
// is checked against the closed vocabulary here, at run time, and anything else is an
// UNTYPED failure — never a guessed channel, because a channel is a claim about what the
// SCRIPT did and a malformed outcome proves nothing about that.

const LIMITS: ReadonlySet<unknown> = new Set(["cpu", "memory", "wallClock"]);

/**
 * Return the outcome with its text bounded, or throw (untyped) when it is not a well-formed outcome.
 * Every field is read ONCE into a local and the locals are validated and used: a getter that
 * answers differently the second time cannot pass a check and then deliver something else.
 */
export function validateOutcome(raw: unknown): SandboxOutcome {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw malformed("outcome is not an object");
  }
  const o = raw as Record<string, unknown>;
  const ok = o.ok;
  if (ok === true) return { ok: true, value: o.value };
  if (ok !== false) throw malformed("`ok` is not a boolean");
  const kind = o.kind;
  switch (kind) {
    case "limit": {
      const limit = o.limit;
      if (!LIMITS.has(limit)) throw malformed("`limit` is not cpu, memory or wallClock");
      return { ok: false, kind: "limit", limit: limit as "cpu" | "memory" | "wallClock" };
    }
    case "threw": {
      const message = o.message;
      const name = o.name;
      if (typeof message !== "string") throw malformed("`threw.message` is not a string");
      if (name !== undefined && typeof name !== "string") {
        throw malformed("`threw.name` is not a string");
      }
      // Bounded HERE whatever the backend already did: this text lands in an append-only log.
      const bounded = boundText(message, SANDBOX_MESSAGE_LIMIT);
      return name === undefined
        ? { ok: false, kind: "threw", message: bounded }
        : { ok: false, kind: "threw", name: boundText(name, SANDBOX_NAME_LIMIT), message: bounded };
    }
    case "inputTooLarge":
      return { ok: false, kind: "inputTooLarge" };
    case "infrastructure": {
      const message = o.message;
      if (typeof message !== "string") throw malformed("`infrastructure.message` is not a string");
      return {
        ok: false,
        kind: "infrastructure",
        message: boundText(message, SANDBOX_MESSAGE_LIMIT),
      };
    }
    default:
      throw malformed("unknown outcome `kind`");
  }
}

function malformed(why: string): Error {
  return new Error(`sandbox: backend returned a malformed outcome (${why})`);
}

const NETWORKS: ReadonlySet<unknown> = new Set(["none", "allowlist", "open"]);
const WALL_CLOCKS: ReadonlySet<unknown> = new Set(["hard", "soft"]);

/**
 * Validate a capabilities declaration and return a frozen COPY of it. Each field is read once, so a
 * getter that flips, or an object mutated after construction, cannot change what was vetted.
 */
export function readCapabilities(caps: unknown): Readonly<SandboxBackendCapabilities> {
  const bad = (why: string): never => {
    throw new Error(`sandbox: malformed backend capabilities (${why})`);
  };
  if (typeof caps !== "object" || caps === null) return bad("not an object");
  const c = caps as Partial<Record<keyof SandboxBackendCapabilities, unknown>>;
  const { language, network, wallClock, memory, cpu, freshPerRun } = c;
  if (typeof language !== "string" || language === "") return bad("`language` is empty");
  if (!NETWORKS.has(network)) return bad("`network` must be none, allowlist or open");
  if (!WALL_CLOCKS.has(wallClock)) return bad("`wallClock` must be hard or soft");
  for (const [key, v] of [
    ["memory", memory],
    ["cpu", cpu],
    ["freshPerRun", freshPerRun],
  ] as const) {
    if (typeof v !== "boolean") return bad(`\`${key}\` must be a boolean`);
  }
  return Object.freeze({
    language,
    network: network as SandboxBackendCapabilities["network"],
    wallClock: wallClock as SandboxBackendCapabilities["wallClock"],
    memory: memory as boolean,
    cpu: cpu as boolean,
    freshPerRun: freshPerRun as boolean,
  });
}
