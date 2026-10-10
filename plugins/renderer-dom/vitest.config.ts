import { loomTest } from "../../vitest.shared";

// jsdom for the DOM the renderer builds (the same environment plugins/renderer-react uses).
export default loomTest({ test: { environment: "jsdom" } });
