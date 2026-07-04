export interface EventEnvelope {
  id: string;
  workflowId: string;
  executionId: string;
  eventType: string;
  sequence: number;
  timestamp: number;
  payload: unknown;
  metadata?: Record<string, unknown>;
}
