import * as asyncHooks from "node:async_hooks";

/**
 * The slice of `AsyncLocalStorage` the runtime uses: the value of the CURRENT async context, and
 * running a function inside a new one.
 */
export interface ContextStore<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

/**
 * A context store that does not touch `node:async_hooks` until first use, so merely LOADING this
 * package in a browser bundle (where a bundler externalizes `node:async_hooks` to an empty module)
 * no longer throws. Where `AsyncLocalStorage` exists (Node, Deno, Bun, workers with
 * nodejs_compat) it IS one, so Node behaviour is unchanged.
 *
 * Where it does not exist, the fallback is a synchronous stack: the store is visible to code that
 * runs synchronously inside `run`, and NOT across an `await`. Async context propagation is
 * unavailable in such an environment, so work after an `await` falls back to the root scope (the
 * documented behaviour for detached work). Run the durable runtime on the server.
 */
export function createContextStore<T>(): ContextStore<T> {
  let als: ContextStore<T> | undefined;
  let stack: T[] | undefined;
  const ctor = (): (new () => ContextStore<T>) | undefined => {
    try {
      const c = (asyncHooks as { AsyncLocalStorage?: unknown }).AsyncLocalStorage;
      return typeof c === "function" ? (c as new () => ContextStore<T>) : undefined;
    } catch {
      return undefined;
    }
  };
  const init = (): void => {
    if (als !== undefined || stack !== undefined) return;
    const C = ctor();
    if (C !== undefined) als = new C();
    else stack = [];
  };
  return {
    getStore() {
      init();
      return als !== undefined ? als.getStore() : stack?.[stack.length - 1];
    },
    run(store, fn) {
      init();
      if (als !== undefined) return als.run(store, fn);
      const s = stack as T[];
      s.push(store);
      try {
        return fn();
      } finally {
        s.pop();
      }
    },
  };
}
