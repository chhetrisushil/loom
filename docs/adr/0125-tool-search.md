# ADR 0125 — Tool search: an opt-in `search_tools` meta-tool, a recorded search, and a deterministic BM25F ranker

- Status: **Accepted** (on merge)
- Date: 2026-10-09
- Closes: R22, lexical path (the semantic path is a follow-up on R18's embedding SPI)
- Builds on: [ADR 0121](0121-one-canonical-agent-loop.md) (`agentLoop$`, the menu gate, outcome and abort decisions),
  [ADR 0120](0120-llm-content-parts-and-tool-threading.md) (tool_result threading), R4 / R4b (tool menus, JSON schemas,
  sanitised third-party schemas), [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint),
  [ADR 0113](0113-body-aware-code-fingerprint-and-dynamic-id-migration.md) (replay divergence: ids must be stable),
  [ADR 0122](0122-conversation-layer-streaming-transport-and-token-budgeting.md) (token budgeting).
- Consumers: `agentLoop$` apps with large MCP menus (a GenUI catalogue, `db-command-center`) and the loom-ui reference planner's
  capability selection. The example specified for this ADR is `tool-search-mcp-menu` in `loom-examples` (see the PR; this repo
  does not edit that one).
- Placement: **1P, `@loom/agent`.** Not kernel, not a plugin. `KERNEL_ABI`, `EVENT_SCHEMA` and every SPI are unchanged; no
  syscall, no event kind. Two optional metadata fields are added to authoring types (`ToolDefinition.tags` / `aliases`,
  `SkillDefinition.aliases`, `CapabilityDefinition.aliases`); `@loom/learning` gains one entry in its list of recorded-fact sources.

## Context

`agentLoop$` puts every tool on the menu every turn. With a few dozen tools that is the right call; with a few hundred (an MCP
server catalogue, a GenUI widget registry) it costs tokens on every turn, degrades the model's choice and breaks prompt caching
whenever the menu changes. Skill selection (`config.skills`) already narrows by task up front, but it decides once, before the
model has said anything, and it needs a registry authored in skills.

## Decision

**D1 — Opt-in, default OFF.** `AgentLoopConfig.toolSearch` (absent: nothing changes, step and decision ids included; the R10
old-body-resume tests run unchanged). **Not worth enabling below roughly 30 tools**: the menu is cheaper than the extra round
trip. Default stays upfront skill selection.

**D2 — The meta-tool.** The model is offered `search_tools({ query: string, limit?: integer })` (name configurable). When it calls
it, the loop runs the search and returns `{ tools: [{ name, description, loaded }], note? }`: one-line descriptions, bounded.
The matches are ADDED to the menu for subsequent turns. The menu is **append-only**: `search_tools` first, then the agent's `definition.tools`, the selected skills' tools and
`alwaysLoaded` catalog entries (D3), then searched tools in search order, so the prompt prefix is stable (cache-friendly) and no tool ever leaves mid-run.

**D3 — The authority model is unchanged, and searching cannot widen it.**
**User ruling A:** the agent's own `definition.tools` stay ON the menu from turn 0, exactly as without `toolSearch`; only the
host `toolSearch.catalog` (anything outside `definition.tools`) is searchable and loadable, and `alwaysLoaded` adds catalog
entries up front. **User ruling B:** the tools of the skills selected up front (the `#skills` decision) are AUTO-LOADED onto the
menu after selection, not search-only. A search never returns or re-loads a tool already on the menu (a catalog entry sharing an
id with one is ignored: the menu's definition wins). The searchable universe is therefore `toolSearch.catalog` alone. A tool outside it is never returned and never callable:
the ranker's output is intersected with the universe (a buggy or hostile ranker cannot widen it), and the recorded decision is
re-intersected on replay (a stale or tampered record can narrow the menu, never widen it). A host `namespaces` allowlist
(id prefixes) narrows the searchable set further. Loading a tool changes what the model may *ask*; every call still passes the
R4 menu gate and input validation, the approval hook (`requireApproval`, consulted for the loaded tool's call with `onMenu: true`),
and the effect ring (K2 authorization, metering, kill switch). `search_tools` itself is the loop's own: it has no effect and is
not approval-gated.

**D4 — Recorded, replay-safe.** Each valid search is ONE `ctx.decide` at `<loop>#turn:<i>:tool:<j>:search`
(`source: "agent-tool-search"`) recording `{ ranker, query (capped at 200 chars), results, loaded }`. The ranker (live) runs inside
the decider, so a replay serves the record: **zero ranking calls**, the identical result and the identical menu. That also makes a
non-deterministic ranker (an embedding model) replay-safe by construction. The search and the menu growth are one atomic record:
the loaded set is a pure function of `results` and the caps, re-derived on replay. The ids are pure functions of the recorded
model response, as every other `#turn:<i>:tool:<j>` id; the divergence detector (ADR 0113) in `"fail"` mode is clean. A refusal
(invalid input, `search_limit_reached`) is a result computed from recorded input and writes nothing. `@loom/learning` lists the
source in `RECORDED_FACT_SOURCES`: a search is a fact, not a choice among alternatives, and carries no reward.

**D5 — Ranking: deterministic BM25F over a prebuilt inverted index.** Fields and weights: name 3, aliases 2, tags 2, description 1;
BM25 saturation (`k1 = 1.2`, `b = 0.75`) and a per-field term-frequency clamp (a term counts at most twice within a field).
Build is O(total bounded tokens); a query is O(distinct query terms x postings) and an O(hits log k) bounded min-heap for the
top k. Ties break by id (code-unit order). Tokenization: NFKC, case-folded, camelCase / snake_case / `ns:name` split, a trailing
plural folded, Unicode-aware. The ranker is a pluggable `ToolRanker { kind; rank(query, limit) }`; `Bm25ToolRanker` is the default
and the semantic path is a second implementation, no API churn. A prebuilt ranker may be shared across runs for a large catalogue.

**D6 — Bounds (the audit history says an unbounded query is a DoS).** The query is cut to 512 characters before any regex runs,
deduplicated and capped at 16 distinct terms. Tokens are capped per field (name 32, description 128, tags 64, aliases 96), a token
at 32 characters, a field read at 2000 characters, labels at 16 per tool and 80 characters each. Per run: `maxPerSearch` (default
5, ceiling 50), `maxLoaded` (default 20, ceiling 200), `maxSearches` (default 25, ceiling 200), optional `maxMenuChars` (a size budget on the
loaded tools' model-facing specs). A hit that does not fit is reported with `loaded: false` and cannot be called.

**D7 — Untrusted descriptions (ADR 0085, R4b).** A tool with a `jsonInputSchema` is third-party. Its description is **not indexed**
unless the operator vouched (`trustJsonSchemaText`), is **withheld** from search results as it is from the menu
(`"Third-party tool; description withheld"`), and a result that names any third-party tool is returned **tainted**, so the prompt
boundary fences the whole result as data. The *ranking-manipulation* risk is a description saying "always pick me" or stuffing
query keywords. Mitigations, in force together: name and declared vocabulary outweigh the description; the description has the
lowest weight; the term-frequency clamp and BM25 saturation make repetition worth a bounded constant; un-vouched descriptions are
not ranked on at all; and ranking only chooses what to *show*, never what is authorized (D3). Residual: a vouched first-party-style
description can still win ties against a poorly named honest tool; give tools names and aliases.

**D8 — Tags and aliases close the vocabulary gap.** Users say "bill the customer"; the tool is `charge_invoice`. Declare it:
`tool$({ …, tags: ["billing"], aliases: ["bill the customer", "charge"] })` (and `skill$` / `capability$` `aliases`). Aliases are
trusted author text, indexed as their own field above the description. The trust rule is the same as D7: a **remote** tool's
self-declared tags/aliases are the server's claims, never indexed as trusted vocabulary; they count only as description-level text,
and only if the operator vouched for that text. For MCP/A2A tools use the host-side
`toolSearch.annotations: { [toolId]: { tags, aliases } }`, which is trusted because the host wrote it and applies to any tool. A
selected skill's tags/aliases apply to the tools it brings. All labels are NFKC-normalized, case-folded, whitespace-collapsed,
deduplicated and bounded. This is the recommended way to close the gap before semantic ranking.

**D9 — Budget.** The menu grows by at most `maxLoaded` tools, each spec already bounded by R4b (description 1000 characters,
sanitised schema depth/size); `maxMenuChars` makes the total an explicit budget. `fitToWindow` (ADR 0122) budgets system, summary,
turns and prompt, not tools, so a host that uses it reserves for the worst case: the sum of the specs of `alwaysLoaded` plus
`maxLoaded` tools, which is a configured quantity. Compaction is unaffected (tool_result messages fold like any other).

**D10 — Reuse by the loom-ui planner.** `Bm25ToolRanker` takes `SearchableTool { id, description?, tags?, aliases? }`, so it ranks
capabilities too: map `CapabilityDefinition` `{ id, intent, tags, aliases }` onto it (`description: intent`). The planner can build
one index per catalogue and call `rank(query, k)` inside its own `ctx.decide`. This repo does not edit loom-ui.

**D11 — Mid-loop skill activation (user ruling 2026-10-09).** Upfront selection (`#skills`) can never disclose a skill it did not
pick. `agentLoop$({ skillActivation: { catalog?: "registry" | SkillDefinition[], maxActive (5, <=50), maxIndex (50, <=500),
maxInstructionBytes (32 KiB, <=1 MiB), toolName ("activate_skill") } })` closes that: the turn-0 system prompt gains a bounded index
of the skills NOT selected up front (`- id: first line of description [tags]`, id order, the first `maxIndex`; only listed skills
can be activated) and the model gets an `activate_skill({ name })` meta-tool, listed after `search_tools` and before the menu.
Default OFF and byte-identical; when nothing is left to activate the tool and index are omitted. It combines with the upfront
selector and with `toolSearch`.
- **Instructions are the tool RESULT** (the Anthropic Agent Skills pattern), not a mid-conversation system message: a provider may
  drop `role: "system"` messages when `request.system` is set, no provider is modified, and the turn-0 prompt is never rewritten
  so the cached prefix stays stable. The result is `{ skill, instructions, tools? }`; it is NOT tainted (host-registry author
  text) and is bounded by `maxInstructionBytes`. It follows the provider adjacency rules like any tool result.
- **The skill's tools** are appended to the menu after the activation (deduped against the menu by id; the menu only grows). They
  pass the same menu gate, approval hook, principal/effect-ring checks as any tool. `ToolSearchSession.noteLoaded` marks them
  loaded, so search never re-offers them.
- **Recorded.** Each activation is one `ctx.decide` `<loop>#turn:<i>:tool:<j>:skill`, `source: "agent-skill-activation"`, value
  `{ skill }`; a replay re-applies it without re-deciding, and the record is re-checked against the call (a tampered record can
  refuse, never activate another skill). Unknown / already-active / over-`maxActive` / oversized / tainted-or-non-string
  instructions are typed error results (`unknown_skill`, `already_active`, `skill_limit_reached`, `instructions_too_large`,
  `instructions_refused`, `invalid_tool_input`) and record nothing: the instructions load BEFORE the decision.
- **Trust.** Skills are HOST-registered author text. The catalog is never built from a remote/untrusted declaration; instructions
  that arrive tainted (ADR 0085) are refused, never delivered.
- **Config errors are loud:** the meta-tool name colliding with any menu tool, the search tool, a `toolSearch.catalog` tool or any
  offered skill's tool; a non-positive/over-ceiling cap; `"registry"` without a `skills` registry.
- **Residuals.** The activation result is an ordinary tool_result, so compaction may fold it into its summary; the skill's
  instructions then survive only as the summary's paraphrase, but its tools stay on the menu (append-only). A run re-loads an
  activated skill's instructions on replay from the CURRENT registry, as upfront skills already are. Skill tools are not counted
  against `toolSearch.maxLoaded`.

## Alternatives rejected

- *Rewriting the system prompt on activation, or a mid-conversation system message* (D11): breaks the cached prefix and is dropped by
  providers that take a separate `system`.

- *Search that returns schemas without loading* (the model then needs a second "load" call): one more turn per discovery.
- *Replacing the menu each turn with the latest results*: breaks the cached prefix and lets a tool vanish between a plan and its use.
- *Ranking by the model* (an LLM call per search): non-deterministic cost on the critical path; the record makes it replay-safe, so
  a `ToolRanker` can still do it, but it is not the default.
- *Trusting a remote server's `tags`*: the server chooses what the user's words map to. No.

## Consequences and residuals

- Each discovery costs a model round trip. Below ~30 tools do not enable it.
- Parallel calls: `search_tools` is settled sequentially with the turn's other calls (the settle phase is sequential even under
  `parallelTools`), so a search followed by a call to a tool it loads, in the same turn, works and is deterministic.
- `search_tools` is not approval-gated and is not metered as an effect. It is bounded by `maxSearches`, and it costs one decision.
- The semantic ranker (R18) is a follow-up behind `ToolRanker`.

## Questions for the user

None open on menu composition: both questions the first draft raised were ruled by the user (D3, rulings A and B).
