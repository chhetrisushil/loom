/** The conversation id of an execution id: generations are `<chainId>~<n>` (ADR 0109 D2). */
export function conversationIdOf(executionId: string): string {
  const i = executionId.indexOf("~");
  return i < 0 ? executionId : executionId.slice(0, i);
}

/** The execution id of generation `g` of conversation `conversationId`. */
export function generationId(conversationId: string, g: number): string {
  return g === 0 ? conversationId : `${conversationId}~${g}`;
}

/** The generation number of an execution id of the chain (`0` for the first). */
export function generationOf(executionId: string): number {
  const i = executionId.indexOf("~");
  if (i < 0) return 0;
  const n = Number(executionId.slice(i + 1));
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A caller-chosen conversation id: no `~` (generation separator), no `::` (child separator), no reserved prefix. */
export function isValidConversationId(id: string): boolean {
  return ID.test(id) && !id.startsWith("__loom_");
}
