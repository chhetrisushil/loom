// ── AppSpec (Loom 2.0 AI-native DX) ──────────────────────────────────────────
//
// The structured intermediate between natural language and generated code. NL is
// parsed into this JSON-serializable spec (the only place "understanding" happens —
// and it is deterministic/offline by default), then plain, static, inspectable
// TypeScript is emitted from it. There is NO runtime interpretation of NL: the
// output is ordinary Loom code you own, statically wired (P5).

export interface ReasoningSpec {
  /** Cheapest model to try first, e.g. "gemma". */
  baseModel?: string;
  /** Ordered stronger models to elevate to on low confidence, e.g. ["gemini", "opus"]. */
  elevateTo?: string[];
}

export interface CapabilitySpec {
  id: string;
  name: string;
  intent: string;
  /** Step ids in order (defaults to a single "run" step). */
  steps: string[];
  reasoning?: ReasoningSpec;
  /** Pause for a human approval (a durable suspend gate). */
  approval?: boolean;
  /** Emit a UI surface update. */
  ui?: boolean;
}

export interface ComputeSpec {
  /** e.g. "local" | "cloudrun" | "fargate". */
  target?: string;
}

export interface AppSpec {
  name: string;
  capabilities: CapabilitySpec[];
  compute?: ComputeSpec;
}

export interface GeneratedFile {
  path: string;
  contents: string;
}
