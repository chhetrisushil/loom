import { createRoot } from "react-dom/client";
import { buildCore } from "../wiring";
import { App } from "./App";
import { buildRegistry } from "./registry";

// Reuse the surface-agnostic core (projections + composer) verbatim; only the
// rendering surface is new. The registry maps the blueprint's widgets to charts.
const core = buildCore();
const registry = buildRegistry();

const el = document.getElementById("root");
if (!el) throw new Error("No #root element found");
createRoot(el).render(<App core={core} registry={registry} />);
