import { type TransferListItem, parentPort } from "node:worker_threads";
import { type QuickJSWASMModule, getQuickJS } from "quickjs-emscripten";
import { evalInFreshRuntime } from "./evalCore";
import {
  RUN_EVALUATING,
  RUN_FINISHED,
  STATUS_RUN_ID_INDEX,
  STATUS_STARTED_AT_OFFSET,
  STATUS_STATE_INDEX,
} from "./workerProtocol";
import type { FromWorker, ToWorker } from "./workerProtocol";

// ── ADR 0089 — the worker-side entrypoint ────────────────────────────────────
//
// The whole file: compile QuickJS once, then evaluate one script at a time on
// this thread instead of the caller's. It deliberately holds NO state between
// runs beyond the compiled WASM module — every eval still gets a fresh runtime
// from the shared `evalInFreshRuntime`, so worker mode cannot diverge from
// in-process mode on any guard.
//
// Nothing here decides outcomes. A guard kill comes back as `tripped` and the
// parent maps it to a typed channel, because the channel vocabulary is kernel
// policy and the parent is the kernel side of this boundary (K7.5).

const port = parentPort;
if (port === null) throw new Error("sandbox worker: no parentPort (not spawned as a Worker)");

const send = (msg: FromWorker, transfer: TransferListItem[] = []): void => {
  port.postMessage(msg, transfer);
};

// NOT named `module`: this file compiles to CommonJS, where `module` is already
// bound by the wrapper. A top-level `let module` is a redeclaration SyntaxError,
// and Node's answer to a file that will not parse as CommonJS is to reparse it as
// ESM — where the compiled `exports.` prologue then fails. The symptom names
// neither the variable nor the line.
let quickjs: QuickJSWASMModule | undefined;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Encode into a fresh, non-pooled buffer — a transfer detaches it, so it may not be shared. */
function toTransferable(json: string): Uint8Array {
  return encoder.encode(json);
}

async function handle(msg: ToWorker): Promise<void> {
  if (msg.type === "warm") {
    quickjs ??= await getQuickJS();
    send({ type: "ready" });
    return;
  }

  const runId = msg.runId;
  // The parent reads these from inside its kill timer, where it cannot receive a message
  // (#399). Written around the eval ONLY: booting the engine, creating the runtime and
  // seeding the input are the sandbox's own work, not the script running long — the same
  // distinction `ensureReady` draws for a cold start. So the stamp comes from the engine at
  // the instant it arms its own wall clock, never from here: stamping before the call
  // charged runtime creation and input seeding to the script (L13).
  const state = new Int32Array(msg.status, 0, 2);
  const startedAt = new Float64Array(msg.status, STATUS_STARTED_AT_OFFSET, 1);
  try {
    quickjs ??= await getQuickJS();
    // Already JSON text (the parent measured/posted it as such — evalCore.ts) — decoded,
    // not parsed-then-restringified, so the input is serialized exactly once, on the
    // parent thread, for the whole round trip.
    const inputJson = decoder.decode(msg.inputJson);
    const outcome = evalInFreshRuntime(
      quickjs,
      msg.script,
      inputJson,
      msg.limits,
      undefined,
      (at) => {
        startedAt[0] = at;
        Atomics.store(state, STATUS_RUN_ID_INDEX, runId);
        Atomics.store(state, STATUS_STATE_INDEX, RUN_EVALUATING);
      }
    );
    Atomics.store(state, STATUS_STATE_INDEX, RUN_FINISHED);
    if (!outcome.ok) {
      send({
        type: "failure",
        runId,
        message: outcome.message,
        ...(outcome.tripped !== undefined && { tripped: outcome.tripped }),
        ...(outcome.thrown !== undefined && { thrown: outcome.thrown }),
      });
      return;
    }
    if (outcome.value === undefined) {
      send({ type: "result", runId, outputJson: null });
      return;
    }
    const bytes = toTransferable(JSON.stringify(outcome.value));
    send({ type: "result", runId, outputJson: bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    // Finished either way: the parent must not kill a worker for a script that has
    // already stopped running, whatever the outcome was. The run id goes FIRST, as it does
    // when the run starts: a throw before `onScriptStart` (input parse, seeding) has not
    // stamped it yet, and the parent only honours a FINISHED that names its own run.
    Atomics.store(state, STATUS_RUN_ID_INDEX, runId);
    Atomics.store(state, STATUS_STATE_INDEX, RUN_FINISHED);
    // A throw here is the WORKER failing, not the script: the module would not
    // compile, or a value would not marshal. Untyped by design — same reasoning
    // as an environment violation inside the VM.
    send({ type: "fatal", runId, message: err instanceof Error ? err.message : String(err) });
  }
}

port.on("message", (msg: ToWorker) => {
  void handle(msg);
});
