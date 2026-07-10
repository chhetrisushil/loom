// Uses the sanctioned egress path (the brokered ctx.fetch).
module.exports = async (input, ctx) => {
  const res = await ctx.fetch(input.url);
  return { status: res.status, body: res.body };
};
