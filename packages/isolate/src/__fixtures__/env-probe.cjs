// Reports what the child can see: its injected credential and (hopefully not)
// the parent's secret.
module.exports = async () => ({
  injected: process.env.TOOL_SECRET ?? null,
  leakedParentSecret: process.env.PARENT_SECRET ?? null,
  envKeys: Object.keys(process.env).sort(),
});
