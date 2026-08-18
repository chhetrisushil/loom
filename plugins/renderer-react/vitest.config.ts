import react from "@vitejs/plugin-react";
import { loomTest } from "../../vitest.shared";

// The only package that renders components: jsdom + the react plugin.
export default loomTest({
  plugins: [react()],
  test: { environment: "jsdom", globals: true },
});
