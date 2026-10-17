// 15 synthetic skills (id, name, one-line description, tags) for the discovery eval. The descriptions
// overlap on purpose (billing words in refund handling and in invoice collections, access words in
// onboarding, offboarding and security review, alert words in incident triage and runbook writing).
//
// Written before any ranker was run over them (see PROVENANCE.md).

export interface SkillSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

export const SKILLS: readonly SkillSpec[] = [
  {
    id: "incident-triage",
    name: "Incident triage",
    description:
      "Triage a production incident: gather alerts, recent deploys and error rates, then decide severity and who to page.",
    tags: ["incident", "oncall"],
  },
  {
    id: "db-performance-tuning",
    name: "Database performance tuning",
    description:
      "Diagnose slow database queries, missing indexes and bloated tables, and recommend fixes.",
    tags: ["database", "performance"],
  },
  {
    id: "customer-refund-handling",
    name: "Customer refund handling",
    description:
      "Handle a customer refund request: verify the payment, check policy, issue the refund or a credit note.",
    tags: ["billing", "support"],
  },
  {
    id: "release-management",
    name: "Release management",
    description:
      "Plan and ship a release: build the artifact, deploy to staging then production and roll back if checks fail.",
    tags: ["deploy", "release"],
  },
  {
    id: "onboarding-new-hire",
    name: "Onboarding a new hire",
    description:
      "Set up a new employee: create accounts, grant roles, schedule orientation meetings and send the welcome email.",
    tags: ["people", "access"],
  },
  {
    id: "offboarding-employee",
    name: "Offboarding an employee",
    description:
      "Remove a departing employee's access, reassign their work and archive their data.",
    tags: ["people", "access"],
  },
  {
    id: "security-review",
    name: "Security review",
    description:
      "Review code or configuration for security problems such as exposed secrets, weak permissions and injection.",
    tags: ["security"],
  },
  {
    id: "data-report-builder",
    name: "Data report builder",
    description:
      "Build a report from the analytics database: write the query, chart the results and export a CSV.",
    tags: ["analytics", "reporting"],
  },
  {
    id: "code-review",
    name: "Code review",
    description:
      "Review a pull request for correctness, style and test coverage and leave actionable comments.",
    tags: ["repo", "quality"],
  },
  {
    id: "support-ticket-triage",
    name: "Support ticket triage",
    description:
      "Read a new support ticket, find similar past tickets, set priority and route it to the right team.",
    tags: ["support"],
  },
  {
    id: "meeting-scheduler",
    name: "Meeting scheduler",
    description:
      "Find a time that works for all attendees, create the calendar event and send reminders.",
    tags: ["calendar"],
  },
  {
    id: "cost-optimization",
    name: "Cost optimization",
    description:
      "Find cloud waste: idle servers, oversized instances and unused storage, and propose savings.",
    tags: ["cloud", "finops"],
  },
  {
    id: "documentation-writer",
    name: "Documentation writer",
    description:
      "Write or update documentation: READMEs, runbooks and how-to guides from the code and tickets.",
    tags: ["docs"],
  },
  {
    id: "backup-and-recovery",
    name: "Backup and recovery",
    description: "Plan and verify database backups and restore from a backup after data loss.",
    tags: ["database", "reliability"],
  },
  {
    id: "invoice-collections",
    name: "Invoice collections",
    description:
      "Chase overdue invoices: list what is late, send reminders and escalate unpaid accounts.",
    tags: ["billing", "finance"],
  },
];
