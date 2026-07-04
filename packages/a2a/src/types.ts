export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
  capabilities: { streaming?: boolean };
  skills: AgentSkill[];
}

export interface A2AMessagePart {
  type: "text";
  text: string;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2AMessagePart[];
}

export interface A2ATask {
  id: string;
  message: A2AMessage;
  metadata?: Record<string, unknown>;
}

export type A2ATaskStatus = "submitted" | "working" | "completed" | "failed";

export interface A2ATaskResult {
  id: string;
  status: A2ATaskStatus;
  artifacts?: Array<{ name?: string; parts: A2AMessagePart[] }>;
  error?: string;
}
