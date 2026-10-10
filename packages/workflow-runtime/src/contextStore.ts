import * as asyncHooks from "node:async_hooks";

/**
 * The slice of `AsyncLocalStorage` the runtime uses: the value of the CURRENT async context, and
 * running a function inside a new one.
 */
export interface ContextStore<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

/** Thrown when a step/decide scope is entered where there is no `AsyncLocalStorage` (a browser bundle). */
export class AsyncContextUnavailableError extends Error {
  constructor() {
    super(
      "@loom/workflow-runtime: entering a step/decide scope needs AsyncLocalStorage (node:async_hooks), " +
        "which this environment does not provide. Run the durable runtime on the server."
    );
    this.name = "AsyncContextUnavailableError";
  }
}

/**
 * A context store that does not touch `node:async_hooks` until first use, so merely LOADING this
 * package in a browser bundle (where a bundler externalizes `node:async_hooks` to an empty module)
 * no longer throws. Where `AsyncLocalStorage` exists (Node, Deno, Bun, workers with
 * nodejs_compat) it IS one, so Node behaviour is unchanged.
 *
 * Where it does not exist there is no scope to read (`getStore()` is `undefined`, the root scope)
 * and ENTERING one (`run`) throws {@link AsyncContextUnavailableError}. A synchronous stack would
 * lose the scope at the first `await`, so a parallel branch's or a decide's steps would be
 * recorded under the wrong scope: wrong step identities and broken replay, silently. Failing
 * loudly is the only safe answer.
 */
export function createContextStore<T>(): ContextStore<T> {
  let als: ContextStore<T> | undefined;
  let missing = false;
  const init = (): void => {
    if (als !== undefined || missing) return;
    let C: unknown;
    try {
      C = (asyncHooks as { AsyncLocalStorage?: unknown }).AsyncLocalStorage;
    } catch {
      C = undefined;
    }
    if (typeof C === "function") als = new (C as new () => ContextStore<T>)();
    else missing = true;
  };
  return {
    getStore() {
      init();
      return als?.getStore();
    },
    run(store, fn) {
      init();
      if (als === undefined) throw new AsyncContextUnavailableError();
      return als.run(store, fn);
    },
  };
}
