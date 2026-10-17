// Labelled queries for the tool-search eval. Each query was written from the USER-intent side, and its
// relevant set was labelled by reading the tool descriptions in `catalogue.ts` BEFORE any ranker was run.
// See PROVENANCE.md for the labelling rules and the (empty) list of post-measurement label edits.

export type QueryKind =
  /** Plain phrasing close to a tool's own words. */
  | "plain"
  /** Phrasing full of function words, so the default stoplist matters (ADR 0125 D15). */
  | "stoplist"
  /** Phrasing that appears only in a HOST annotation, so `toolSearch.annotations` must steer it. */
  | "annotation";

export interface ToolQuery {
  readonly id: string;
  readonly kind: QueryKind;
  readonly query: string;
  /** Every tool a competent engineer would accept as a correct answer. */
  readonly relevant: readonly string[];
}

export const QUERIES: readonly ToolQuery[] = [
  // ── plain ──
  { id: "t01", kind: "plain", query: "refund the customer's card", relevant: ["refund_payment"] },
  { id: "t02", kind: "plain", query: "show me the slowest database queries", relevant: ["list_slow_queries"] },
  { id: "t03", kind: "plain", query: "reclaim disk space in a table", relevant: ["vacuum_table"] },
  { id: "t04", kind: "plain", query: "undo the last deployment", relevant: ["rollback_deployment"] },
  { id: "t05", kind: "plain", query: "stop a deploy that is in progress", relevant: ["cancel_deployment"] },
  { id: "t06", kind: "plain", query: "what does this error code mean", relevant: ["lookup_error_code"] },
  { id: "t07", kind: "plain", query: "find past tickets similar to this problem", relevant: ["find_similar_tickets"] },
  { id: "t08", kind: "plain", query: "make a backup of the database", relevant: ["create_db_backup"] },
  { id: "t09", kind: "plain", query: "put the database back from last night's backup", relevant: ["restore_db_backup"] },
  { id: "t10", kind: "plain", query: "how far behind is the read replica", relevant: ["check_replication_lag"] },
  { id: "t11", kind: "plain", query: "publish an incident update for customers", relevant: ["post_status_page_update"] },
  { id: "t12", kind: "plain", query: "send a text message to a phone", relevant: ["send_sms"] },
  { id: "t13", kind: "plain", query: "remove someone's access to the repository", relevant: ["revoke_access"] },
  { id: "t14", kind: "plain", query: "give Dana the editor role", relevant: ["grant_role"] },
  { id: "t15", kind: "plain", query: "show the columns and indexes of the orders table", relevant: ["describe_table_schema"] },
  { id: "t16", kind: "plain", query: "create an index to speed up lookups", relevant: ["add_database_index"] },
  { id: "t17", kind: "plain", query: "mute a noisy alert for an hour", relevant: ["silence_alert"] },
  { id: "t18", kind: "plain", query: "which alerts are firing right now", relevant: ["list_firing_alerts"] },
  { id: "t19", kind: "plain", query: "a download link for a stored file", relevant: ["generate_download_link"] },
  { id: "t20", kind: "plain", query: "open a pull request", relevant: ["create_pull_request"] },
  { id: "t21", kind: "plain", query: "remove a user and their personal data", relevant: ["delete_user"] },
  { id: "t22", kind: "plain", query: "get rid of a file in object storage", relevant: ["delete_file"] },
  { id: "t23", kind: "plain", query: "delete a git branch", relevant: ["delete_branch"] },
  { id: "t24", kind: "plain", query: "reduce what the customer owes without moving any money", relevant: ["issue_credit_note"] },
  { id: "t25", kind: "plain", query: "what is the error rate and latency of the service", relevant: ["get_error_rate", "query_metrics"] },
  { id: "t26", kind: "plain", query: "sign the user out everywhere", relevant: ["list_active_sessions", "revoke_access"] },
  { id: "t27", kind: "plain", query: "undo a bad release", relevant: ["rollback_deployment", "cancel_deployment"] },
  { id: "t28", kind: "plain", query: "make slow queries faster", relevant: ["add_database_index", "vacuum_table", "list_slow_queries"] },

  // ── stoplist: function-word-heavy phrasings ──
  { id: "t29", kind: "stoplist", query: "bill the customer", relevant: ["charge_invoice"] },
  { id: "t30", kind: "stoplist", query: "restart the stuck worker", relevant: ["restart_worker"] },
  { id: "t31", kind: "stoplist", query: "send the customer a reminder that it is overdue", relevant: ["send_invoice_reminder"] },
  { id: "t32", kind: "stoplist", query: "get the logs from the pod that is failing", relevant: ["get_pod_logs"] },
  { id: "t33", kind: "stoplist", query: "what is the balance of the account for this customer", relevant: ["get_customer_balance"] },
  { id: "t34", kind: "stoplist", query: "turn on a feature for ten percent of the users", relevant: ["set_feature_flag"] },
  { id: "t35", kind: "stoplist", query: "look at the trace for a request", relevant: ["trace_request"] },
  { id: "t36", kind: "stoplist", query: "list all of the files in the bucket", relevant: ["list_files"] },
  { id: "t37", kind: "stoplist", query: "change the number of replicas of the service", relevant: ["scale_service"] },
  { id: "t38", kind: "stoplist", query: "restart the service and wait for it to be healthy", relevant: ["restart_service"] },

  // ── annotation: vocabulary that only a host annotation supplies ──
  { id: "t39", kind: "annotation", query: "bounce the job runner", relevant: ["restart_worker"] },
  { id: "t40", kind: "annotation", query: "take a server out of rotation", relevant: ["drain_node"] },
  { id: "t41", kind: "annotation", query: "wake someone up, the site is down", relevant: ["page_oncall"] },
  { id: "t42", kind: "annotation", query: "stop the noise", relevant: ["silence_alert"] },
  { id: "t43", kind: "annotation", query: "the customer wants to leave", relevant: ["cancel_subscription"] },
  { id: "t44", kind: "annotation", query: "make her an admin", relevant: ["grant_role"] },
  { id: "t45", kind: "annotation", query: "is the replica stale", relevant: ["check_replication_lag"] },
  { id: "t46", kind: "annotation", query: "stale assets are showing for visitors", relevant: ["flush_cdn_cache"] },
  { id: "t47", kind: "annotation", query: "unblock the stuck transaction", relevant: ["kill_db_session"] },
  { id: "t48", kind: "annotation", query: "collect payment on the open invoice", relevant: ["charge_invoice"] },
];
