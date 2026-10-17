import type { LlmResponse } from "@loom/llm";
import type { Script } from "../cassetteFiles";

// ── The appgen intents ────────────────────────────────────────────────────────
//
// Ten intents → the app shape a correct plan produces. Each case is an intent (written from the USER side), the
// fixture it runs against, the shape it must leave behind (`expected`, written from the intent BEFORE any planner
// ran over it), and a hand-written SCRIPT: what a sensible model would answer. The script is the source of truth
// for the committed cassette (`pnpm eval:author` records the real `planChangesModel` over it). See PROVENANCE.md:
// no model produced any of this.
//
// `expected` is a DELTA on the fixture, in the item vocabulary of `shape.ts`:
//   present: items that must exist after the plan is applied (a flow, a step, an approval gate, a UI surface)
//   absent:  items that must be gone (a deleted flow)

export type FixtureKind = "none" | "support-desk";

export interface ExpectedShape {
  readonly present: readonly string[];
  readonly absent: readonly string[];
}

export interface AppgenCase {
  readonly id: string;
  readonly tags: readonly string[];
  readonly fixture: FixtureKind;
  readonly intent: string;
  readonly expected: ExpectedShape;
  /** What a sensible model answers, turn by turn (a self-repair re-prompt is turn 1). */
  readonly script: Script;
}

type Op = "create" | "extend" | "modify";
interface Cap {
  id: string;
  name: string;
  intent: string;
  op: Op;
  steps: { id: string; op: "create" | "modify" }[];
  addApproval?: true;
  addUi?: true;
}

const reply = (name: string, capabilities: Cap[]): LlmResponse => ({
  content: JSON.stringify({ name, capabilities }),
  stopReason: "end_turn",
});
const turns =
  (...rs: LlmResponse[]): Script =>
  (turn) =>
    rs[Math.min(turn, rs.length - 1)] as LlmResponse;
const step = (id: string) => ({ id, op: "create" as const });
const cap = (c: Cap): Cap => c;

export const APPGEN_CASES: readonly AppgenCase[] = [
  {
    id: "new-ticket-router",
    tags: ["net-new", "natural"],
    fixture: "none",
    intent:
      "I want an agent that reads a customer support ticket, works out how urgent it is, and routes it to the right team.",
    expected: {
      present: [
        "flow:ticket-router",
        "step:ticket-router/classify-urgency",
        "step:ticket-router/route-to-team",
      ],
      absent: [],
    },
    script: turns(
      reply("ticket-router", [
        cap({
          id: "ticket-router",
          name: "Ticket Router",
          intent: "Read a support ticket, rate its urgency and route it to the right team.",
          op: "create",
          steps: [step("classify-urgency"), step("route-to-team")],
        }),
      ])
    ),
  },
  {
    id: "new-refund-reviewer",
    tags: ["net-new", "grammar", "approval", "ui"],
    fixture: "none",
    intent:
      "Create a refund-reviewer capability. Step check policy. Step draft decision. Pause for approval. Generate UI.",
    expected: {
      present: [
        "flow:refund-reviewer",
        "step:refund-reviewer/check-policy",
        "step:refund-reviewer/draft-decision",
        "approval:refund-reviewer",
        "ui:refund-reviewer",
      ],
      absent: [],
    },
    script: turns(
      reply("refund-reviewer", [
        cap({
          id: "refund-reviewer",
          name: "Refund Reviewer",
          intent: "Check the refund policy, draft a decision and pause for approval.",
          op: "create",
          steps: [step("check-policy"), step("draft-decision")],
          addApproval: true,
          addUi: true,
        }),
      ])
    ),
  },
  {
    id: "new-digest-and-pager",
    tags: ["net-new", "natural", "multi-flow"],
    fixture: "none",
    intent:
      "Two flows please: a nightly digest of failed jobs, and a separate one that pages the on-call engineer when the error rate spikes.",
    expected: {
      present: [
        "flow:failed-jobs-digest",
        "step:failed-jobs-digest/collect-failures",
        "flow:oncall-pager",
        "step:oncall-pager/watch-error-rate",
        "step:oncall-pager/page-oncall",
      ],
      absent: [],
    },
    script: turns(
      reply("failed-jobs-digest", [
        cap({
          id: "failed-jobs-digest",
          name: "Failed Jobs Digest",
          intent: "Collect the failed jobs of the night and summarise them.",
          op: "create",
          steps: [step("collect-failures"), step("summarise")],
        }),
        cap({
          id: "oncall-pager",
          name: "On-call Pager",
          intent: "Page the on-call engineer when the error rate spikes.",
          op: "create",
          steps: [step("watch-error-rate"), step("page-oncall")],
        }),
      ])
    ),
  },
  {
    id: "new-report-builder",
    tags: ["net-new", "grammar", "compute"],
    fixture: "none",
    intent: "Create a report-builder. Step gather data. Step render report. Deploy on cloudrun.",
    expected: {
      present: [
        "flow:report-builder",
        "step:report-builder/gather-data",
        "step:report-builder/render-report",
      ],
      absent: [],
    },
    script: turns({
      content: JSON.stringify({
        name: "report-builder",
        capabilities: [
          cap({
            id: "report-builder",
            name: "Report Builder",
            intent: "Gather data and render a report.",
            op: "create",
            steps: [step("gather-data"), step("render-report")],
          }),
        ],
        compute: { target: "cloudrun" },
      }),
      stopReason: "end_turn",
    }),
  },
  {
    id: "edit-triage-escalate",
    tags: ["brownfield", "natural", "extend"],
    fixture: "support-desk",
    intent: "Add a step to the triage flow that escalates urgent tickets to a human.",
    expected: { present: ["step:triage/escalate-urgent"], absent: [] },
    script: turns(
      reply("triage", [
        cap({
          id: "triage",
          name: "Triage",
          intent: "Add a step that escalates urgent tickets to a human.",
          op: "extend",
          steps: [step("escalate-urgent")],
        }),
      ])
    ),
  },
  {
    id: "edit-refunds-ui",
    tags: ["brownfield", "natural", "ui", "repair"],
    fixture: "support-desk",
    intent: "Make the refunds flow also publish a live status panel in the UI.",
    expected: { present: ["ui:refunds"], absent: [] },
    // Turn 0 mistakes the existing flow for a new one (the semantic validator rejects it: "already exists");
    // turn 1 answers the repair prompt correctly. This is the one case that exercises self-repair.
    script: turns(
      reply("refunds", [
        cap({
          id: "refunds",
          name: "Refunds",
          intent: "Publish a live status panel.",
          op: "create",
          steps: [step("run")],
          addUi: true,
        }),
      ]),
      reply("refunds", [
        cap({
          id: "refunds",
          name: "Refunds",
          intent: "Publish a live status panel.",
          op: "extend",
          steps: [],
          addUi: true,
        }),
      ])
    ),
  },
  {
    id: "edit-triage-approval",
    tags: ["brownfield", "natural", "approval"],
    fixture: "support-desk",
    intent: "Triage should pause for human approval before it routes anything.",
    expected: { present: ["approval:triage"], absent: [] },
    script: turns(
      reply("triage", [
        cap({
          id: "triage",
          name: "Triage",
          intent: "Pause for human approval before routing.",
          op: "extend",
          steps: [],
          addApproval: true,
        }),
      ])
    ),
  },
  {
    id: "edit-new-notifier",
    tags: ["brownfield", "grammar", "ui", "create"],
    fixture: "support-desk",
    intent: "Create a shipping-notifier. Step notify customer. Generate UI.",
    expected: {
      present: [
        "flow:shipping-notifier",
        "step:shipping-notifier/notify-customer",
        "ui:shipping-notifier",
      ],
      absent: [],
    },
    script: turns(
      reply("shipping-notifier", [
        cap({
          id: "shipping-notifier",
          name: "Shipping Notifier",
          intent: "Notify the customer about shipping.",
          op: "create",
          steps: [step("notify-customer")],
          addUi: true,
        }),
      ])
    ),
  },
  {
    id: "edit-remove-digest",
    tags: ["brownfield", "delete"],
    fixture: "support-desk",
    intent: "Remove the digest flow.",
    expected: { present: [], absent: ["flow:digest"] },
    // The planner prompt and schema (`@loom/appgen-model`) offer create / extend / modify only: there is no way to
    // say "delete", so a sensible model that follows the prompt answers with a no-op extend. PROVENANCE.md records
    // this as a measured gap of the model arm (the deterministic arm does handle `remove <flow>`).
    script: turns(
      reply("digest", [
        cap({
          id: "digest",
          name: "Digest",
          intent: "Remove the digest flow.",
          op: "extend",
          steps: [],
        }),
      ])
    ),
  },
  {
    id: "edit-digest-publish",
    tags: ["brownfield", "natural", "extend", "approval", "ui"],
    fixture: "support-desk",
    intent:
      "Add a publish-summary step to the digest flow, and give it an approval gate and a status UI.",
    expected: {
      present: ["step:digest/publish-summary", "approval:digest", "ui:digest"],
      absent: [],
    },
    script: turns(
      reply("digest", [
        cap({
          id: "digest",
          name: "Digest",
          intent: "Publish the summary behind an approval gate and a status UI.",
          op: "extend",
          steps: [step("publish-summary")],
          addApproval: true,
          addUi: true,
        }),
      ])
    ),
  },
];
