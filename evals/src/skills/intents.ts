// Labelled intents for the skill-discovery eval: one EXPECTED skill each (hit@1) and an ACCEPTABLE set
// that always contains it (hit@3). Written from the user side and labelled from the skill descriptions in
// `skills.ts` before any ranker was run. See PROVENANCE.md.

export interface SkillIntent {
  readonly id: string;
  readonly intent: string;
  readonly expected: string;
  /** Every skill that would be a defensible answer; includes `expected`. */
  readonly acceptable: readonly string[];
}

export const INTENTS: readonly SkillIntent[] = [
  {
    id: "i01",
    intent: "the site is down and alerts are firing",
    expected: "incident-triage",
    acceptable: ["incident-triage"],
  },
  {
    id: "i02",
    intent: "queries on the orders table take forever",
    expected: "db-performance-tuning",
    acceptable: ["db-performance-tuning"],
  },
  {
    id: "i03",
    intent: "a customer wants their money back for a double charge",
    expected: "customer-refund-handling",
    acceptable: ["customer-refund-handling"],
  },
  {
    id: "i04",
    intent: "ship version 2.4 to production",
    expected: "release-management",
    acceptable: ["release-management"],
  },
  {
    id: "i05",
    intent: "we have a new engineer starting on Monday",
    expected: "onboarding-new-hire",
    acceptable: ["onboarding-new-hire"],
  },
  {
    id: "i06",
    intent: "she is leaving the company on Friday",
    expected: "offboarding-employee",
    acceptable: ["offboarding-employee"],
  },
  {
    id: "i07",
    intent: "check whether the API keys are leaked in the repo",
    expected: "security-review",
    acceptable: ["security-review"],
  },
  {
    id: "i08",
    intent: "I need a chart of monthly signups as a spreadsheet",
    expected: "data-report-builder",
    acceptable: ["data-report-builder"],
  },
  {
    id: "i09",
    intent: "look over this pull request before it merges",
    expected: "code-review",
    acceptable: ["code-review"],
  },
  {
    id: "i10",
    intent: "a new ticket just came in and needs to go to the right team",
    expected: "support-ticket-triage",
    acceptable: ["support-ticket-triage"],
  },
  {
    id: "i11",
    intent: "set up a call with everyone next week",
    expected: "meeting-scheduler",
    acceptable: ["meeting-scheduler"],
  },
  {
    id: "i12",
    intent: "our cloud bill is too high, find the waste",
    expected: "cost-optimization",
    acceptable: ["cost-optimization"],
  },
  {
    id: "i13",
    intent: "write a how-to guide for the deploy process",
    expected: "documentation-writer",
    acceptable: ["documentation-writer", "release-management"],
  },
  {
    id: "i14",
    intent: "restore the database after someone deleted a table",
    expected: "backup-and-recovery",
    acceptable: ["backup-and-recovery"],
  },
  {
    id: "i15",
    intent: "which customers have not paid their invoices",
    expected: "invoice-collections",
    acceptable: ["invoice-collections"],
  },
  {
    id: "i16",
    intent: "roll back the bad release",
    expected: "release-management",
    acceptable: ["release-management", "incident-triage"],
  },
  {
    id: "i17",
    intent: "the database is slow and the pager is going off",
    expected: "db-performance-tuning",
    acceptable: ["db-performance-tuning", "incident-triage"],
  },
  {
    id: "i18",
    intent: "give the new hire access to the repos and send a welcome note",
    expected: "onboarding-new-hire",
    acceptable: ["onboarding-new-hire"],
  },
  {
    id: "i19",
    intent: "revoke everything this contractor can touch and archive their files",
    expected: "offboarding-employee",
    acceptable: ["offboarding-employee"],
  },
  {
    id: "i20",
    intent: "are our permissions too wide and is there SQL injection",
    expected: "security-review",
    acceptable: ["security-review"],
  },
  {
    id: "i21",
    intent: "export last quarter's revenue numbers",
    expected: "data-report-builder",
    acceptable: ["data-report-builder"],
  },
  {
    id: "i22",
    intent: "does this change have enough tests",
    expected: "code-review",
    acceptable: ["code-review"],
  },
  {
    id: "i23",
    intent: "customer says login is broken, have we seen this before",
    expected: "support-ticket-triage",
    acceptable: ["support-ticket-triage"],
  },
  {
    id: "i24",
    intent: "find a slot for the design review and invite the team",
    expected: "meeting-scheduler",
    acceptable: ["meeting-scheduler"],
  },
  {
    id: "i25",
    intent: "servers sitting idle, can we shrink them",
    expected: "cost-optimization",
    acceptable: ["cost-optimization"],
  },
  {
    id: "i26",
    intent: "update the runbook for the paging process",
    expected: "documentation-writer",
    acceptable: ["documentation-writer", "incident-triage"],
  },
  {
    id: "i27",
    intent: "is the nightly backup actually working",
    expected: "backup-and-recovery",
    acceptable: ["backup-and-recovery"],
  },
  {
    id: "i28",
    intent: "send reminders to accounts that are late and escalate the rest",
    expected: "invoice-collections",
    acceptable: ["invoice-collections"],
  },
  {
    id: "i29",
    intent: "refund or issue a credit note for the returned order",
    expected: "customer-refund-handling",
    acceptable: ["customer-refund-handling"],
  },
  {
    id: "i30",
    intent: "who should we page, how bad is this",
    expected: "incident-triage",
    acceptable: ["incident-triage"],
  },
];
