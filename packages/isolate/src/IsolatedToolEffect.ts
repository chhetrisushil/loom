import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import { EgressDeniedError, brokeredFetch } from "./broker";
import type { ChildToParent, IsolatedToolSpec, ParentToChild } from "./types";

/**
 * K7 — the isolated executor, implemented AT the effect position: `Effect` is
 * the innermost link of the chain, so K2 (authorize), K3 (meter) and K6
 * (validate) all run on the KERNEL side of the boundary — nothing inside the
 * isolate can forge them (K7.5 as amended).
 *
 * The boundary is a pooled (persistent, warm) child process per tool:
 *  - **authority**: the child gets a SCRUBBED environment — exactly the
 *    credentials injected for this tool (K7.2/K7.4) plus PATH — and holds no
 *    store handles (structural: nothing is marshaled but scalars).
 *  - **egress**: the tool's `ctx.fetch` marshals to {@link brokeredFetch} on
 *    the parent side, where the static allowlist is enforced BEFORE any
 *    connection (durable `EGRESS_DENIED` on refusal) and requests are
 *    dispatched resolve-and-pin. The runner additionally blocks ambient
 *    network modules as defense-in-depth.
 *  - **kill path**: `ctx.signal` abort (or `timeoutMs`) SIGKILLs the child —
 *    the kernel's only NON-cooperative termination (K8 cross-reference).
 *  - **emits**: forwarded over the ordered IPC channel, so every emit a
 *    completing tool sent is journaled before its result (A3).
 *
 * Runs are serialized per child (one in flight); the process stays warm
 * across calls and respawns on death.
 */
export class IsolatedToolEffect implements Effect {
  readonly kind = "tool" as const;
  readonly idempotent?: boolean;

  private readonly allowlist: ReadonlySet<string>;
  private child: ChildProcess | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextRunId = 1;

  constructor(private readonly spec: IsolatedToolSpec) {
    if (spec.idempotent !== undefined) {
      this.idempotent = spec.idempotent;
    }
    this.allowlist = new Set(spec.egress ?? []);
    // Pre-warm at construction when opted in — the child is up before the first
    // execute, so no run pays the fork + module-load cold start (A4).
    if (spec.warm === true) this.warm();
  }

  /**
   * Advisory pre-warm (A4): spawn the persistent child NOW so the first
   * `execute` doesn't pay the ~fork + `require(tool)` cold start. Idempotent —
   * a live child is reused; a dead one respawns. Off the durable path, no
   * effect on outcomes. Call at boot/registration, or ahead of a scheduled run.
   */
  warm(): void {
    this.ensureChild();
  }

  execute(input: unknown, ctx: EffectContext): Promise<unknown> {
    // Serialize runs on the warm child; each queued run starts only after the
    // previous settles (rejections don't poison the queue).
    const run = this.queue.then(
      () => this.runIsolated(input, ctx),
      () => this.runIsolated(input, ctx)
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Kill the warm child (tests / graceful shutdown). Respawns on next use. */
  close(): void {
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }

  private ensureChild(): ChildProcess {
    if (this.child !== undefined && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    // The runner is compiled output. From dist it sits alongside this file;
    // when this module runs from src (vitest), fall back to ../dist/runner.js.
    const sibling = path.join(__dirname, "runner.js");
    const runnerPath = existsSync(sibling)
      ? sibling
      : path.join(__dirname, "..", "dist", "runner.js");
    // K7.2/K7.4 — scrubbed env: ONLY this tool's injected credentials (+ PATH,
    // so `node` subprocess basics work). The parent's environment — and every
    // other tool's secrets — are simply not there to read.
    this.child = fork(runnerPath, [], {
      env: { ...this.spec.env, PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    return this.child;
  }

  private runIsolated(input: unknown, ctx: EffectContext): Promise<unknown> {
    const child = this.ensureChild();
    const runId = this.nextRunId++;

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        child.removeListener("message", onMessage);
        child.removeListener("exit", onExit);
        ctx.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const kill = (reason: Error): void => {
        // A5 — the non-cooperative kill path: the boundary, not the tool's
        // goodwill, ends the work.
        child.kill("SIGKILL");
        this.child = undefined;
        settle(() => reject(reason));
      };

      const onAbort = (): void => {
        const reason = ctx.signal?.reason;
        kill(reason instanceof Error ? reason : new Error("isolated tool aborted"));
      };

      const onExit = (): void => {
        this.child = undefined;
        settle(() => reject(new Error(`isolated tool "${this.spec.id}" crashed mid-run`)));
      };

      const onMessage = (raw: unknown): void => {
        const msg = raw as ChildToParent;
        if (msg.type === "emit" && msg.runId === runId) {
          ctx.emit(msg.eventType, msg.payload);
          return;
        }
        if (msg.type === "fetch" && msg.runId === runId) {
          void this.handleFetch(child, msg.fetchId, msg.url, msg.init, ctx);
          return;
        }
        if (msg.type === "result" && msg.runId === runId) {
          settle(() => resolve(msg.output));
          return;
        }
        if (msg.type === "error" && msg.runId === runId) {
          settle(() => reject(new Error(msg.message)));
        }
      };

      if (ctx.signal?.aborted === true) {
        onAbort();
        return;
      }
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("message", onMessage);
      child.once("exit", onExit);
      if (this.spec.timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            kill(
              new Error(`isolated tool "${this.spec.id}" exceeded timeoutMs=${this.spec.timeoutMs}`)
            ),
          this.spec.timeoutMs
        );
      }

      const runMsg: ParentToChild = {
        type: "run",
        runId,
        modulePath: this.spec.modulePath,
        ...(this.spec.exportName !== undefined && { exportName: this.spec.exportName }),
        input,
        ctx: {
          executionId: ctx.executionId,
          stepId: ctx.stepId,
          workflowId: ctx.workflowId,
          attempt: ctx.attempt,
          ...(ctx.idempotencyKey !== undefined && { idempotencyKey: ctx.idempotencyKey }),
        },
      };
      child.send(runMsg);
    });
  }

  private async handleFetch(
    child: ChildProcess,
    fetchId: number,
    url: string,
    init: Parameters<typeof brokeredFetch>[3],
    ctx: EffectContext
  ): Promise<void> {
    try {
      const res = await brokeredFetch(this.spec.id, this.allowlist, url, init);
      const reply: ParentToChild = {
        type: "fetch-result",
        fetchId,
        ok: true,
        status: res.status,
        headers: res.headers,
        body: res.body,
      };
      child.send(reply);
    } catch (err) {
      if (err instanceof EgressDeniedError) {
        // K7.3 — the violation is a durable, auditable fact (folded like
        // EFFECT_DENIED), refused before any connection was opened.
        ctx.emit("EGRESS_DENIED", {
          toolId: this.spec.id,
          stepId: ctx.stepId,
          target: err.target,
          reason: err.reason,
        });
      }
      const reply: ParentToChild = {
        type: "fetch-result",
        fetchId,
        ok: false,
        error: String(err),
      };
      child.send(reply);
    }
  }
}
