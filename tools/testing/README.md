# @loom/testing

Testing kit for Loom apps - spin up an in-memory app, wait on surfaces, capture golden logs, record/replay LLM calls, and **drive time** (timers, sleeps, suspend timeouts) deterministically, all over `defineConfig`.

## Entry points

- `@loom/testing`

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## Time travel: `ctx.sleep(1 day)` without waiting

`createTestApp({ clock: true })` gives the app a controllable clock as its `execution.now` and an in-memory timer store, with the `TimerService` **not polling on its own** (`autostart: false`). `advanceTime(app, ms)` moves the clock and then runs one poll of the app's real `TimerService` (`app.timerService.tick(clock.now())`), so a sleep, a `suspend({ timeout })` or a cron occurrence fires through the same code production runs. Advancing less than the remaining time fires nothing.

```ts
import { advanceTime, createTestApp } from "@loom/testing";

const app = createTestApp({ clock: true, flows: [reminderFlow] });
const handle = await app.runtime.start(reminderFlow, { who: "ada" });
await handle.waitForSuspend();

await advanceTime(app, 24 * 60 * 60 * 1000 - 1); // not due yet: still suspended
await advanceTime(app, 1); // due: the flow wakes and completes
const state = await app.runtime.loadState(handle.executionId);
await app.close();
```

`clock` is `true` (a fresh clock starting 2030-01-01T00:00:00Z), a number (the start, epoch ms) or your own `TestClock` (`createTestClock(start)`, with `now` / `advanceBy` / `advanceTo`). Your own `execution.now`, `timers` or `autostart` win over these defaults. `fireDueTimers(app)` polls without moving the clock. The clock is a minimal copy of the `now` / `advanceBy` shape of `@loom/dst`'s `virtualClock`, so this package does not depend on the simulation kit; reach for `@loom/dst` when you need fault injection or discrete-event simulation.

`loom new flow <name> --template approval|timer|saga` scaffolds flows whose tests use exactly this.

## Status / See also

- API reference: section "`@loom/testing` - the testing kit" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
- Source: `tools/testing/src`.
