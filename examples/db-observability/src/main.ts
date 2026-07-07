import { buildApp } from "./app";

// Ask the observability assistant a few questions. Each one is analysed by the agent,
// categorised, and answered with a DYNAMICALLY-generated dashboard (WHAT + WHY),
// rendered headlessly to the terminal. Offline, no API key.

const QUESTIONS = [
  "Why is the CPU utilization high?",
  "What is the connection saturation level?",
  "Is replica lag a problem right now?",
  "Which slow queries are hurting us?",
];

async function main(): Promise<void> {
  const { composer, renderer, executionId } = buildApp();

  for (const question of QUESTIONS) {
    const result = await composer.answer(question);
    console.log(
      `\n\x1b[2m# "${question}" → topic=${result.classification.topic} kind=${result.classification.kind}\x1b[0m`
    );
    console.log(renderer.render(result.blueprint, executionId));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
