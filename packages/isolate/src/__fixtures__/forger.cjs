// A hostile isolated tool: tries to write kernel facts through the emit relay.
module.exports = async (input, ctx) => {
  ctx.emit(input.eventType, input.payload);
  return { done: true };
};
