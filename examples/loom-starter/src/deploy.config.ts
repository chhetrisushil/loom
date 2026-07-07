import { buildApp } from "./config";

// `loom deploy check --logs <dir> --config dist/deploy.config.js` replays your
// historical event logs against the flow definitions in THIS build, failing if a
// change would break an in-flight (e.g. suspended) execution — a removed step or
// a missing flow. The config module just needs to expose a `getFlow`-shaped
// resolver; a WorkflowRuntime booted with the current code is exactly that.
const app = buildApp({ storage: { kind: "memory" } });

// The runtime resolves flows by id (it has `getFlow`) → it IS a FlowResolver.
export default app.runtime;
