// ── Token-aware context budgeting (ADR 0122 D3) ───────────────────────────────────────────────
//
// `agentLoop$`'s `compaction` triggers on message COUNT and UTF-8 BYTES, never on tokens, and it
// folds the transcript of ONE run. A dialogue outlives a run: the question here is "which of the
// turns I hold fit the model's window beside the system prompt and the new message", asked once per
// user turn. This module answers it as a PURE function over counted tokens, so the only
// non-deterministic ingredient (a provider's exact counter) is isolated behind a seam the caller
// records (`conversation$` journals the verdict as a decision; a replay never calls the counter).

/** Counts the tokens of a text. Sync or async; a provider may supply its exact tokenizer. */
export interface TokenCounter {
  count(text: string): number | Promise<number>;
  /** Tokens a single message costs beyond its text (role markers, separators). Default 4. */
  readonly perMessage?: number;
}

/**
 * The default counter: no tokenizer, no dependency, deterministic and CONSERVATIVE. ASCII costs a
 * quarter token per character (the usual English rule of thumb, rounded UP), every other code point
 * costs a whole token (CJK, emoji and symbols tokenize at roughly one token or more per character,
 * so a flat chars/4 would under-count them by 4x and overflow the window). Over-counting only costs
 * some history; under-counting costs the request.
 */
export function heuristicTokenCounter(options: { asciiCharsPerToken?: number } = {}): TokenCounter {
  const per = options.asciiCharsPerToken ?? 4;
  if (!(per >= 1) || !Number.isFinite(per)) {
    throw new RangeError("heuristicTokenCounter: asciiCharsPerToken must be a number >= 1");
  }
  return {
    perMessage: 4,
    count(text: string): number {
      let ascii = 0;
      let wide = 0;
      for (const ch of text) {
        if ((ch.codePointAt(0) as number) < 0x80) ascii++;
        else wide++;
      }
      return Math.ceil(ascii / per) + wide;
    },
  };
}

export class ContextBudgetError extends Error {
  readonly code = "CONTEXT_BUDGET";
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

/** One turn of the history the budgeter weighs: its token cost is counted once and cached. */
export interface BudgetTurn {
  /** The tokens of the turn's messages (user + assistant), if already counted. */
  tokens?: number;
  user: string;
  assistant?: string;
}

export interface BudgetRequest {
  /** The model's context window, in tokens. */
  contextWindow: number;
  /** Tokens held back for the reply. Default `min(4096, window / 4)`. */
  reserveOutputTokens?: number;
  /** The system prompt (counted once). */
  system?: string;
  /** The rolling summary of evicted turns (counted once), if any. */
  summary?: string;
  /** The new user message. */
  prompt: string;
  /** Turns oldest first. */
  turns: readonly BudgetTurn[];
  counter?: TokenCounter;
}

export type BudgetVerdict =
  | {
      ok: true;
      /** How many of the NEWEST turns fit (the rest are to be dropped / summarized). */
      keep: number;
      /** Tokens counted for each turn that had none: `[index, tokens]`. */
      counted: [number, number][];
      /** The total the request will cost (fixed parts + kept turns), reply reserve excluded. */
      tokens: number;
      /** The rolling summary alone made the request not fit, so it was left out of this fit (and is to be dropped). */
      dropSummary?: true;
    }
  | { ok: false; reason: "prompt-too-large"; tokens: number; available: number };

/**
 * Fit `system + summary + turns + prompt` into `contextWindow - reserveOutputTokens`. Keeps the
 * longest NEWEST suffix of whole turns that fits (a turn is never split); the prompt is never
 * dropped, and when system + summary + prompt alone exceed the window the verdict is
 * `prompt-too-large` (the caller refuses the turn rather than send a request the provider will
 * reject). Pure of the counter's answers: the same counts give the same verdict.
 *
 * Cost: one `count` per turn that has no cached `tokens`, then a single backwards pass; the caller
 * caches `counted` on its turns, so a steady-state conversation counts only the NEW turn per call.
 */
export async function fitToWindow(req: BudgetRequest): Promise<BudgetVerdict> {
  const counter = req.counter ?? heuristicTokenCounter();
  const overhead = counter.perMessage ?? 4;
  if (!Number.isFinite(req.contextWindow) || req.contextWindow <= 0) {
    throw new RangeError("fitToWindow: contextWindow must be a positive number");
  }
  const reserve = req.reserveOutputTokens ?? Math.min(4096, Math.floor(req.contextWindow / 4));
  const available = req.contextWindow - reserve;
  let fixed = overhead; // the prompt message
  fixed += await counter.count(req.prompt);
  if (req.system !== undefined && req.system !== "") fixed += await counter.count(req.system);
  if (req.summary !== undefined && req.summary !== "") {
    fixed += overhead + (await counter.count(req.summary));
  }
  if (fixed > available) return { ok: false, reason: "prompt-too-large", tokens: fixed, available };
  const counted: [number, number][] = [];
  const weights: number[] = new Array<number>(req.turns.length);
  // Walk newest -> oldest and stop at the first turn that does not fit: older turns are never
  // counted, so a long window costs O(kept), not O(held).
  let used = fixed;
  let keep = 0;
  for (let i = req.turns.length - 1; i >= 0; i--) {
    const turn = req.turns[i] as BudgetTurn;
    let w = turn.tokens;
    if (w === undefined) {
      w = overhead + (await counter.count(turn.user));
      if (turn.assistant !== undefined && turn.assistant !== "") {
        w += overhead + (await counter.count(turn.assistant));
      }
      counted.push([i, w]);
    }
    weights[i] = w;
    if (used + w > available) break;
    used += w;
    keep++;
  }
  return { ok: true, keep, counted, tokens: used };
}

/**
 * `fitToWindow`, but a rolling summary that is itself too big to leave room for the prompt is DROPPED
 * rather than wedging the conversation: with no summary the same request may fit. The verdict says so
 * (`dropSummary`) and the caller discards the summary. Still `prompt-too-large` when it cannot fit even so.
 */
export async function fitWithSummaryFallback(req: BudgetRequest): Promise<BudgetVerdict> {
  const v = await fitToWindow(req);
  if (v.ok || req.summary === undefined || req.summary === "") return v;
  const { summary: _dropped, ...rest } = req;
  const again = await fitToWindow(rest);
  return again.ok ? { ...again, dropSummary: true } : again;
}

/**
 * The longest prefix of `text` that costs at most `maxTokens`, with an ellipsis when cut: a binary
 * search over prefix lengths, O(log n) counts. Deterministic for a deterministic counter, and the
 * caller records its answer anyway.
 */
export async function truncateToTokens(
  text: string,
  maxTokens: number,
  counter: TokenCounter
): Promise<string> {
  if ((await counter.count(text)) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((await counter.count(text.slice(0, mid))) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : `${text.slice(0, lo)}…`;
}
