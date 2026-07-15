// Headless driver: three simulated days of sentinel wakes, printed. The real
// proof lives in test/sentinel.test.ts (the 12-month acceptance suite).
import { FINDING_RECORDED, type Finding } from "./domain";
import { deploySentinel, fireOccurrence, newWorld } from "./harness";
import { occurrenceId } from "./sentinel";
import { DAY, HOUR, SIM_START } from "./substrate";

async function main(): Promise<void> {
  const world = newWorld();
  const deploy = deploySentinel(world, 1, {
    onOffload: (info) =>
      console.log(`  · offloaded ${info.size}B → ${info.contentAddress.slice(0, 20)}…`),
  });

  // Start on Jan 5 so the run crosses the monthly anomaly day (the 7th).
  const start = SIM_START + 4 * DAY;
  for (let t = start; t < start + 3 * DAY; t += 6 * HOUR) {
    const { state } = await fireOccurrence(deploy, t);
    console.log(`wake ${new Date(t).toISOString()} → ${state.status}`);
  }

  let findings = 0;
  for (let t = start; t < start + 3 * DAY; t += 6 * HOUR) {
    for (const e of await world.eventStore.read(occurrenceId(t))) {
      if (e.eventType === FINDING_RECORDED) {
        const f = e.payload as Finding;
        findings++;
        console.log(
          `FINDING ${f.severity} ${f.category}: lag ${f.observed.maxLagMs}ms, evidence ${f.evidence[0]?.__loomContent.slice(0, 20)}…`
        );
      }
    }
  }
  const carry = await world.stateStore.load("sentinel:pg-sentinel");
  console.log(
    `\n${findings} finding(s); carry state rev ${carry?.revision}: ${JSON.stringify(carry?.payload)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
