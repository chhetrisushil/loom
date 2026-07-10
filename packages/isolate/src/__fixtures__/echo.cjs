// A well-behaved isolated tool: computes, emits, reads its marshaled ctx.
module.exports = async (input, ctx) => {
  ctx.emit("TOOL_NOTE", { seen: input, stepId: ctx.stepId });
  return { echoed: input, key: ctx.idempotencyKey ?? null, attempt: ctx.attempt };
};
