import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import type { IsolatedFetchInit } from "./types";

/**
 * K7.3 — an egress target was refused KERNEL-SIDE, before any connection was
 * opened. Recorded as a durable `EGRESS_DENIED` fact by the executor.
 */
export class EgressDeniedError extends Error {
  constructor(
    readonly toolId: string,
    readonly target: string,
    readonly reason: string
  ) {
    super(`egress denied for tool "${toolId}" → ${target}: ${reason}`);
    this.name = "EgressDeniedError";
    Object.setPrototypeOf(this, EgressDeniedError.prototype);
  }
}

export interface BrokeredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Settle with `p`, or reject with the signal's reason as soon as it aborts (whichever is first). */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/** Hooks a caller can attach to observe the parts of a brokered fetch it cannot cancel. */
export interface BrokeredFetchHooks {
  /**
   * Called when a DNS lookup starts, with a promise that resolves (never rejects) when that
   * lookup ACTUALLY settles — which, after an abort, is later than `brokeredFetch` returning.
   * getaddrinfo cannot be cancelled, so a caller bounding concurrency holds its slot on this.
   */
  lookupStarted?: (settled: Promise<void>) => void;
}

const noop = (): void => undefined;

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * The kernel-side egress broker (K7.3 as amended): the isolate has NO direct
 * network path in its authoring surface — its `ctx.fetch` marshals here, on the
 * parent/kernel side of the boundary, where the allowlist is enforced *before*
 * any connection and the request is dispatched **resolve-and-pin**: the
 * hostname is checked against the allowlist, resolved ONCE, and the socket is
 * opened to that pinned address (TLS still validates the certificate against
 * the original hostname via SNI/servername) — so a DNS rebind between check and
 * connect cannot redirect the request, and an IP-literal must itself be listed.
 */
export async function brokeredFetch(
  toolId: string,
  allowlist: ReadonlySet<string>,
  url: string,
  init: IsolatedFetchInit = {},
  signal?: AbortSignal,
  hooks?: BrokeredFetchHooks
): Promise<BrokeredResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressDeniedError(toolId, url, "malformed URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EgressDeniedError(toolId, url, `unsupported protocol "${parsed.protocol}"`);
  }
  const port = parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  const target = `${parsed.hostname}:${port}`;
  if (!allowlist.has(target)) {
    throw new EgressDeniedError(toolId, target, "not in the tool's static egress allowlist");
  }

  // Resolve-and-pin: connect to the address resolved NOW, not whatever the
  // name resolves to at connect time.
  signal?.throwIfAborted();
  let pinnedHost: string;
  if (isIP(parsed.hostname) !== 0) {
    pinnedHost = parsed.hostname;
  } else {
    const looked = lookup(parsed.hostname).then((r) => r.address);
    hooks?.lookupStarted?.(looked.then(noop, noop));
    pinnedHost = await abortable(looked, signal);
  }
  // The lookup itself cannot be cancelled (getaddrinfo), but we stop WAITING for it on abort;
  // check again so an abort that landed as it settled never opens a connection.
  signal?.throwIfAborted();

  const client = parsed.protocol === "https:" ? https : http;
  return new Promise<BrokeredResponse>((resolve, reject) => {
    const req = client.request(
      {
        host: pinnedHost,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? "GET",
        headers: { ...init.headers, host: parsed.host },
        ...(parsed.protocol === "https:" && { servername: parsed.hostname }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error("brokered response exceeded 10MB"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    // L24 — the caller's deadline / run-end abort tears the request down (socket included), so a
    // hung host holds nothing once the caller gives up.
    if (signal !== undefined) {
      const onAbort = (): void => {
        req.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
    }
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
