// A synthetic tool menu in the shape of the loom-examples `tool-search-mcp-menu` one: nine domains
// (billing, infra, database, comms, search, identity, observability, storage, repo), with overlapping
// vocabulary ON PURPOSE (restart a worker / a service / a database, delete a user / a file / a branch,
// refund / credit note / charge). Every tool is first-party, so its own tags are trusted vocabulary.
//
// Written from the tool-author side only, before any ranker was run over it (see PROVENANCE.md).

export interface ToolSpec {
  readonly id: string;
  readonly description: string;
  /** The tool author's own tags (a domain label, sometimes one extra). */
  readonly tags?: readonly string[];
}

export const TOOLS: readonly ToolSpec[] = [
  // ── billing ──
  {
    id: "charge_invoice",
    description: "Charge the customer's saved payment method for an open invoice.",
    tags: ["billing", "payments"],
  },
  {
    id: "create_invoice",
    description: "Create a new draft invoice for a customer with line items.",
    tags: ["billing"],
  },
  {
    id: "send_invoice_reminder",
    description: "Email the customer a reminder that an invoice is overdue.",
    tags: ["billing"],
  },
  {
    id: "refund_payment",
    description: "Refund a captured payment back to the customer's card, in full or in part.",
    tags: ["billing", "payments"],
  },
  {
    id: "issue_credit_note",
    description: "Issue a credit note that reduces what the customer owes without moving money.",
    tags: ["billing"],
  },
  {
    id: "list_overdue_invoices",
    description: "List invoices that are past their due date, oldest first.",
    tags: ["billing"],
  },
  {
    id: "get_customer_balance",
    description: "Look up the current account balance a customer owes or is owed.",
    tags: ["billing"],
  },
  {
    id: "update_payment_method",
    description: "Replace the card or bank account stored for a customer.",
    tags: ["billing", "payments"],
  },
  {
    id: "cancel_subscription",
    description: "Cancel a customer's recurring subscription at the end of the billing period.",
    tags: ["billing"],
  },
  {
    id: "apply_discount_code",
    description: "Apply a promotional discount code to a customer's subscription or invoice.",
    tags: ["billing"],
  },

  // ── infra ──
  {
    id: "restart_worker",
    description: "Restart a stuck background worker process.",
    tags: ["infra"],
  },
  {
    id: "restart_service",
    description: "Restart a deployed service and wait for it to report healthy.",
    tags: ["infra"],
  },
  {
    id: "scale_service",
    description: "Change the number of running replicas of a service.",
    tags: ["infra"],
  },
  {
    id: "drain_node",
    description: "Cordon a cluster node and move its workloads elsewhere before maintenance.",
    tags: ["infra", "cluster"],
  },
  {
    id: "list_running_pods",
    description: "List pods currently running in a namespace with their status.",
    tags: ["infra", "cluster"],
  },
  {
    id: "get_pod_logs",
    description: "Fetch recent log lines from a pod's container.",
    tags: ["infra", "cluster"],
  },
  {
    id: "rollback_deployment",
    description: "Roll a service back to its previous deployed version.",
    tags: ["infra", "deploy"],
  },
  {
    id: "deploy_release",
    description: "Deploy a built release artifact to an environment.",
    tags: ["infra", "deploy"],
  },
  {
    id: "rotate_tls_certificate",
    description: "Issue a new TLS certificate and swap it in before the old one expires.",
    tags: ["infra", "security"],
  },
  {
    id: "flush_cdn_cache",
    description: "Purge cached content from the CDN edge so fresh files are served.",
    tags: ["infra"],
  },
  {
    id: "set_feature_flag",
    description: "Turn a feature flag on or off for an environment or a percentage of users.",
    tags: ["infra"],
  },
  {
    id: "cancel_deployment",
    description: "Abort a deployment that is currently in progress.",
    tags: ["infra", "deploy"],
  },

  // ── database ──
  {
    id: "run_sql_query",
    description: "Run a read-only SQL query against the analytics database and return rows.",
    tags: ["database"],
  },
  {
    id: "list_slow_queries",
    description: "List the slowest database queries over a time window.",
    tags: ["database", "performance"],
  },
  {
    id: "kill_db_session",
    description: "Terminate a runaway database session holding locks.",
    tags: ["database"],
  },
  {
    id: "vacuum_table",
    description: "Vacuum and analyze a table to reclaim space and refresh statistics.",
    tags: ["database", "maintenance"],
  },
  {
    id: "create_db_backup",
    description: "Take a snapshot backup of a database.",
    tags: ["database", "backup"],
  },
  {
    id: "restore_db_backup",
    description: "Restore a database from a previous backup snapshot.",
    tags: ["database", "backup"],
  },
  {
    id: "describe_table_schema",
    description: "Show the columns, types and indexes of a table.",
    tags: ["database"],
  },
  {
    id: "add_database_index",
    description: "Create an index on a table column to speed up lookups.",
    tags: ["database", "performance"],
  },
  {
    id: "check_replication_lag",
    description: "Report how far a read replica is behind its primary.",
    tags: ["database"],
  },
  {
    id: "run_migration",
    description: "Apply pending schema migrations to a database.",
    tags: ["database"],
  },

  // ── comms ──
  {
    id: "send_email",
    description: "Send an email message to one or more recipients.",
    tags: ["comms"],
  },
  {
    id: "send_slack_message",
    description: "Post a message to a Slack channel.",
    tags: ["comms", "chat"],
  },
  {
    id: "page_oncall",
    description: "Page the on-call engineer through the paging service.",
    tags: ["comms", "incident"],
  },
  {
    id: "create_calendar_event",
    description: "Schedule a meeting on a shared calendar and invite attendees.",
    tags: ["comms", "calendar"],
  },
  { id: "send_sms", description: "Send a text message to a phone number.", tags: ["comms"] },
  {
    id: "create_support_ticket",
    description: "Open a new ticket in the support desk for a customer issue.",
    tags: ["support"],
  },
  {
    id: "close_support_ticket",
    description: "Mark a support ticket as resolved and notify the requester.",
    tags: ["support"],
  },
  {
    id: "post_status_page_update",
    description: "Publish an incident update on the public status page.",
    tags: ["comms", "incident"],
  },
  {
    id: "schedule_meeting_reminder",
    description: "Send attendees a reminder before a scheduled meeting.",
    tags: ["comms", "calendar"],
  },
  {
    id: "translate_text",
    description: "Translate a piece of text into another language.",
    tags: ["language"],
  },

  // ── search and knowledge ──
  {
    id: "search_documents",
    description: "Full-text search over the company wiki and documents.",
    tags: ["search"],
  },
  {
    id: "search_code",
    description: "Search the source code repositories for a symbol or string.",
    tags: ["search", "repo"],
  },
  {
    id: "search_customers",
    description: "Find customers by name, email or account number.",
    tags: ["search"],
  },
  {
    id: "summarize_document",
    description: "Produce a short summary of a document.",
    tags: ["search", "language"],
  },
  {
    id: "fetch_webpage",
    description: "Download a web page and return its readable text.",
    tags: ["search"],
  },
  {
    id: "lookup_error_code",
    description: "Look up what an application error code means and how to fix it.",
    tags: ["search"],
  },
  {
    id: "find_similar_tickets",
    description: "Find past support tickets that resemble a given problem.",
    tags: ["search", "support"],
  },
  {
    id: "get_runbook",
    description: "Retrieve the operations runbook for an alert or system.",
    tags: ["search", "incident"],
  },

  // ── identity and access ──
  { id: "create_user", description: "Create a new user account.", tags: ["identity"] },
  {
    id: "delete_user",
    description: "Delete a user account and its personal data.",
    tags: ["identity"],
  },
  { id: "reset_password", description: "Send a user a password reset link.", tags: ["identity"] },
  {
    id: "grant_role",
    description: "Give a user a role or permission group.",
    tags: ["identity", "access"],
  },
  {
    id: "revoke_access",
    description: "Remove a user's access to a system or resource.",
    tags: ["identity", "access"],
  },
  {
    id: "list_active_sessions",
    description: "List the sign-in sessions currently active for a user.",
    tags: ["identity"],
  },
  {
    id: "enable_two_factor",
    description: "Require a second authentication factor for a user account.",
    tags: ["identity", "security"],
  },

  // ── observability ──
  {
    id: "query_metrics",
    description: "Query time-series metrics such as CPU, latency and error rate.",
    tags: ["observability"],
  },
  {
    id: "list_firing_alerts",
    description: "List alerts that are currently firing.",
    tags: ["observability", "incident"],
  },
  {
    id: "silence_alert",
    description: "Mute a noisy alert for a fixed period.",
    tags: ["observability"],
  },
  {
    id: "create_dashboard",
    description: "Create a dashboard of charts from metric queries.",
    tags: ["observability"],
  },
  {
    id: "trace_request",
    description: "Show the distributed trace for a request id.",
    tags: ["observability"],
  },
  {
    id: "get_error_rate",
    description: "Report the error rate of a service over the last hour.",
    tags: ["observability"],
  },

  // ── storage ──
  { id: "upload_file", description: "Upload a file to object storage.", tags: ["storage"] },
  { id: "delete_file", description: "Delete a file from object storage.", tags: ["storage"] },
  { id: "list_files", description: "List files in a storage bucket or folder.", tags: ["storage"] },
  {
    id: "generate_download_link",
    description: "Create a time-limited download link for a stored file.",
    tags: ["storage"],
  },
  {
    id: "export_report_csv",
    description: "Export a report's data as a CSV file.",
    tags: ["storage", "reporting"],
  },

  // ── repository ──
  { id: "create_pull_request", description: "Open a pull request from a branch.", tags: ["repo"] },
  { id: "merge_pull_request", description: "Merge an approved pull request.", tags: ["repo"] },
  { id: "delete_branch", description: "Delete a git branch.", tags: ["repo"] },
  {
    id: "run_ci_pipeline",
    description: "Trigger a CI pipeline run for a branch.",
    tags: ["repo", "deploy"],
  },
];

/**
 * HOST annotations (the operator's own vocabulary for a tool, `toolSearch.annotations`): user phrasings
 * that a tool's name, tags and description do not contain. Trusted text, applied to any tool.
 */
export const ANNOTATIONS: Readonly<
  Record<string, { tags?: readonly string[]; aliases?: readonly string[] }>
> = {
  charge_invoice: { aliases: ["bill the customer", "collect payment"] },
  restart_worker: { aliases: ["bounce the job runner", "unstick the queue consumer"] },
  drain_node: { aliases: ["take a server out of rotation"] },
  page_oncall: { aliases: ["wake someone up", "escalate to a human"] },
  silence_alert: { aliases: ["stop the noise"], tags: ["pager fatigue"] },
  cancel_subscription: { aliases: ["customer wants to leave", "churn"] },
  grant_role: { aliases: ["make them an admin"] },
  check_replication_lag: { aliases: ["is the replica stale"] },
  flush_cdn_cache: { aliases: ["clear the edge", "stale assets showing"] },
  kill_db_session: { aliases: ["unblock the stuck transaction"] },
};
