import type { DecoratorPlan } from "./installOptional";
import type { EventStore, OptionalEventStoreMethod } from "./types";

// ── Compile-time proof that a DecoratorPlan cannot silently drop a method ────────
//
// This is a SOURCE file on purpose: `pnpm typecheck` (tsc --build) excludes `*.test.ts`, so a
// type-level negative in a test file would never be checked. If `DecoratorPlan` ever lets a
// plan omit an optional method again (a homomorphic mapped type over `EventStore` inherits the
// methods' `?` and makes every key optional), the `@ts-expect-error` below becomes unused and
// the build fails. Nothing here runs; it exports nothing.

type Plan = DecoratorPlan<EventStore, OptionalEventStoreMethod>;

const complete = {
  appendBatch: "forward",
  readRange: "forward",
  head: "forward",
  acquireFence: "forward",
  acquireFenceIf: "forward",
  appendIfUnchanged: "forward",
  storeNow: "forward",
  sealingCapability: "forward",
  copyPrefix: "forward",
  deleteExecution: "forward",
  truncatePrefix: "forward",
  truncatePrefixKeeping: "forward",
  listExecutions: "forward",
  listExecutionsPage: { refuse: "a refusal is a decision, and still a key" },
} satisfies Plan;
void complete;

// @ts-expect-error — listExecutionsPage is missing: a plan must decide every optional method.
const missingOne: Plan = {
  appendBatch: "forward",
  readRange: "forward",
  head: "forward",
  acquireFence: "forward",
  acquireFenceIf: "forward",
  appendIfUnchanged: "forward",
  storeNow: "forward",
  sealingCapability: "forward",
  copyPrefix: "forward",
  deleteExecution: "forward",
  truncatePrefix: "forward",
  truncatePrefixKeeping: "forward",
  listExecutions: "forward",
};
void missingOne;
