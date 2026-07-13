# angular-command-center — the same durable backend, in Angular

The incident command center rendered with **Angular** — proof that Loom is
frontend-framework-agnostic. The durable runtime, the flow, and the projection stream are identical to
the React [`cloud-command-center`](../cloud-command-center); only the view layer differs.

## What it shows

- **`defineConfig` as the composition root** (`src/app/loom.service.ts`) — an Angular service assembles
  the runtime once. `@loom/app` lazy-loads the SQLite stores behind an opaque require, so a browser
  build stays clean on the in-memory path.
- **The investigate-incident flow** (`src/app/incident.flow.ts`) — gather metrics + logs, triage, and a
  human-approved remediation with durable `ctx.suspend` / resume.
- **The projection stream into Angular signals** — events fold into an `InMemoryProjectionRuntime`;
  the service bridges surface state into Angular `signal()`s (inside `NgZone`) so the component
  re-renders reactively.
- **Telemetry** — a `ConsoleTelemetryAdapter` taps the event stream.

## Run it

```sh
pnpm --filter angular-command-center dev     # Vite + Angular dev server
pnpm --filter angular-command-center build
```

Compare `src/app/loom.service.ts` here with `src/main.tsx` in `cloud-command-center`: the Loom wiring is
the same `defineConfig` call — the framework glue (an Angular service + signals vs. a React provider +
hooks) is the only difference.
