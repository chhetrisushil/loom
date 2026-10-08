import { randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ConversationHub,
  ConversationNotFoundError,
  type Conversations,
  InvalidCursorError,
  InvalidTurnError,
  SubscriberLimitError,
  followConversation,
  isValidConversationId,
  parseCursor,
} from "@loom/conversation";
import { BadRequestError, exposeError } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import {
  ExecutionDeniedError,
  InboxClosedError,
  InboxFullError,
  InboxMessageRefusedError,
} from "@loom/workflow-runtime";
import { SseSink, frame } from "./sse";

// ── The end-user gateway of a conversation (ADR 0122 D6) ────────────────────────────────────────────
//
//   POST /conversations                  start one (the SERVER mints the id)
//   GET  /conversations/:id              status
//   POST /conversations/:id/turns        send a turn (a barge-in if one is running)   { text, messageId? }
//   POST /conversations/:id/close        close it
//   GET  /conversations/:id/history      a bounded page   ?limit&cursor&direction
//   GET  /conversations/:id/events       the SSE stream   Last-Event-ID | ?cursor
//
// SECURITY MODEL. Fail closed at every step, and say nothing a caller was not entitled to.
//   * AUTHENTICATION: every route needs `authenticate(req)` to return a principal with an `actor`;
//     the server REFUSES TO BE CREATED without it unless `insecure: true` (never under strict).
//   * AUTHORIZATION is the runtime's, per conversation: `send` and `query` judged against the
//     conversation's recorded owner (ADR 0111). There is no second ACL here to drift.
//   * EXISTENCE IS HIDDEN: a conversation the caller may not touch and one that does not exist both
//     answer 404 `{"error":"not found"}`.
//   * ISOLATION: a stream is keyed by one conversation id; the live hub and the log reader are both
//     keyed by it, and a cursor is a position INSIDE that conversation's chain, so a cursor from
//     another conversation cannot read it.
//   * LOOPBACK by default. CSRF: a browser request with an `Origin` outside `allowedOrigins` (and not
//     same-origin) is refused, and POST bodies must be `application/json`.
//   * LIMITS: connections (total, per principal), live subscribers per conversation (the hub's),
//     request body, per-connection pending bytes (a slow reader is closed), stream lifetime. A
//     connection is re-authenticated periodically; a revoked token ends the stream.

export interface ConversationSseOptions {
  conversations: Conversations;
  /** Where live deltas come from (the same hub the model effect's `onDelta` feeds). */
  hub: ConversationHub;
  /** The store the conversations' runtime appends to: its subscription wakes the stream. */
  eventStore: EventStore;
  port?: number;
  /** Interface to bind. Default `"127.0.0.1"` (loopback only). */
  host?: string;
  /**
   * Authenticate AND identify the caller from connection facts (a verified bearer token, an mTLS
   * peer): return its principal (`actor` required) or `undefined` to refuse (401). Never derive it
   * from the body or the URL.
   */
  authenticate?: (
    req: http.IncomingMessage
  ) => PrincipalChain | undefined | Promise<PrincipalChain | undefined>;
  /** Explicit opt-out of authentication: any caller that can reach the socket converses. Warned; refused under `strict`. */
  insecure?: boolean;
  /** Fail closed on a principal-less caller (default from `conversations`' runtime is not visible here: set it for strict deployments). */
  strict?: boolean;
  warn?: (message: string) => void;
  /** Browser origins allowed to call this server (exact match). Same-origin requests need no entry. Default none. */
  allowedOrigins?: readonly string[];
  /** Path prefix. Default `/conversations`. */
  basePath?: string;
  /** Concurrent streams, all callers. Default 256. */
  maxConnections?: number;
  /** Concurrent streams per principal (tenant + actor). Default 8. */
  maxConnectionsPerPrincipal?: number;
  /** Bytes a slow client may leave unread before its stream is closed. Default 1 MiB. */
  maxPendingBytes?: number;
  /** Request body cap, bytes. Default 64 KiB. */
  maxBodyBytes?: number;
  /** Comment heartbeat period, ms. Default 15 000. */
  heartbeatMs?: number;
  /** A stream is ended (the client reconnects with Last-Event-ID) after this long, ms. Default 15 min. */
  maxStreamMs?: number;
  /** How often an open stream re-authenticates and re-authorizes, ms. Default 30 000. */
  reauthMs?: number;
  /** Safety-net poll of the log when no notification arrives, ms. Default 2 000. */
  pollMs?: number;
  /** Real error behind a 500, with the `errorId` the caller was given. */
  onError?: (errorId: string, err: unknown) => void;
}

export interface ConversationSseServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  /** Open streams right now. */
  readonly connections: number;
}

const principalKey = (p: PrincipalChain | undefined): string =>
  p === undefined
    ? "anonymous"
    : JSON.stringify([p.tenant ?? null, p.actor ?? null, p.onBehalfOf ?? null]);

const hasActor = (p: PrincipalChain): boolean =>
  typeof p.actor === "string" && p.actor.trim().length > 0;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly headers: Record<string, string> = {}
  ) {
    super(String(body.error));
  }
}

const NOT_FOUND = new HttpError(404, { error: "not found" });

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      reject(new HttpError(415, { error: "content-type must be application/json" }));
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (c: Uint8Array) => {
      size += c.length;
      if (size > max) {
        // Answer first (a destroyed socket would turn the 413 into a connection reset), then drop
        // the rest of the upload: the response handler closes the connection once it is written.
        chunks.length = 0;
        reject(new HttpError(413, { error: `body exceeds ${max} bytes` }, { connection: "close" }));
        return;
      }
      if (size <= max) chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new BadRequestError("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createConversationSseServer(
  options: ConversationSseOptions
): ConversationSseServer {
  const { conversations, hub } = options;
  const host = options.host ?? "127.0.0.1";
  const base = (options.basePath ?? "/conversations").replace(/\/+$/, "");
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const maxConnections = options.maxConnections ?? 256;
  const maxPerPrincipal = options.maxConnectionsPerPrincipal ?? 8;
  const maxPending = options.maxPendingBytes ?? 1024 * 1024;
  const maxBody = options.maxBodyBytes ?? 64 * 1024;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxStreamMs = options.maxStreamMs ?? 15 * 60_000;
  const reauthMs = options.reauthMs ?? 30_000;
  const allowed = new Set(options.allowedOrigins ?? []);
  const strict = options.strict === true;

  if (options.authenticate === undefined) {
    if (options.insecure !== true) {
      throw new Error(
        "createConversationSseServer: refusing to create an unauthenticated server. Supply `authenticate`, or pass `insecure: true` to opt out explicitly."
      );
    }
    if (strict) {
      throw new Error(
        "createConversationSseServer: `insecure: true` is refused under strict — authenticate callers."
      );
    }
    warn(
      `[loom] WARNING: conversation gateway is running with insecure: true — NO authentication; any caller that can reach ${host} can converse.`
    );
  }

  let resolvedUrl = `http://${host.includes(":") ? `[${host}]` : host}:${options.port ?? 0}`;
  const open = new Set<{ close: () => void }>();
  const perPrincipal = new Map<string, number>();

  async function identify(req: http.IncomingMessage): Promise<PrincipalChain | undefined> {
    if (options.authenticate === undefined) return undefined; // insecure
    const p = await options.authenticate(req);
    if (p === undefined || !hasActor(p)) throw new HttpError(401, { error: "unauthorized" });
    return p;
  }

  /** A browser's cross-site request is refused before anything runs. */
  function checkOrigin(req: http.IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    if (origin === undefined) return undefined; // not a browser cross-origin request
    const same =
      req.headers.host !== undefined &&
      (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`);
    if (!same && !allowed.has(origin)) throw new HttpError(403, { error: "origin not allowed" });
    return same ? undefined : origin;
  }

  const mapError = (err: unknown, notFoundOnDeny: boolean): HttpError => {
    if (err instanceof HttpError) return err;
    if (err instanceof ConversationNotFoundError) return NOT_FOUND;
    if (err instanceof ExecutionDeniedError) {
      return notFoundOnDeny ? NOT_FOUND : new HttpError(403, { error: "forbidden" });
    }
    if (
      err instanceof InvalidTurnError ||
      err instanceof InvalidCursorError ||
      err instanceof BadRequestError ||
      err instanceof InboxMessageRefusedError
    ) {
      return new HttpError(400, { error: err.message });
    }
    if (err instanceof InboxClosedError)
      return new HttpError(409, { error: "conversation is closed" });
    if (err instanceof InboxFullError || err instanceof SubscriberLimitError) {
      return new HttpError(429, { error: "too many requests" }, { "retry-after": "1" });
    }
    const exposed = exposeError(err, randomUUID);
    if (exposed.internal !== undefined)
      options.onError?.(exposed.body.errorId as string, exposed.internal);
    return new HttpError(exposed.status, exposed.body);
  };

  async function events(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    principal: PrincipalChain | undefined,
    url: URL,
    corsOrigin: string | undefined
  ): Promise<void> {
    const callOpts = principal !== undefined ? { principal } : {};
    // AUTHORIZE FIRST: nothing below (not even a limit that would answer 429) may reveal that a
    // conversation exists to a caller who may not read it. `status` is that gate and the first frame.
    const status = await conversations.status(id, callOpts);
    const resume =
      (req.headers["last-event-id"] as string | undefined) ??
      url.searchParams.get("cursor") ??
      undefined;
    if (resume !== undefined && parseCursor(resume) === undefined) throw new InvalidCursorError();

    const key = principalKey(principal);
    if (open.size >= maxConnections || (perPrincipal.get(key) ?? 0) >= maxPerPrincipal) {
      throw new HttpError(429, { error: "too many streams" }, { "retry-after": "5" });
    }
    const ctl = new AbortController();
    // Live subscription (a limit here is still an HTTP answer), then the catch-up snapshot of the
    // in-progress reply taken in the same tick, so no delta falls between them.
    const sink = new SseSink(res, maxPending, () => end());
    const deltaFrame = (turn: number, text: string) => frame("delta", { turn, text });
    const unsubscribe = hub.subscribe(id, (ev) => {
      if (ev.type === "delta") sink.delta(ev.turn, ev.text, deltaFrame);
      else sink.send(frame("reset", { turn: ev.turn }));
    });
    const partial = hub.partialOf(id);

    perPrincipal.set(key, (perPrincipal.get(key) ?? 0) + 1);
    const handle = { close: () => end() };
    open.add(handle);
    let ended = false;
    const timers: NodeJS.Timeout[] = [];
    function end(): void {
      if (ended) return;
      ended = true;
      sink.close();
      ctl.abort();
      for (const t of timers) clearInterval(t);
      unsubscribe();
      open.delete(handle);
      const n = (perPrincipal.get(key) ?? 1) - 1;
      if (n <= 0) perPrincipal.delete(key);
      else perPrincipal.set(key, n);
      res.end();
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      ...(corsOrigin !== undefined && {
        "access-control-allow-origin": corsOrigin,
        vary: "Origin",
      }),
    });
    res.flushHeaders();
    req.on("close", end);
    res.on("error", end);
    sink.send("retry: 3000\n\n");
    sink.send(frame("status", status));
    if (partial !== undefined) sink.send(frame("partial", partial));

    timers.push(setInterval(() => sink.send(": ping\n\n"), heartbeatMs).unref());
    timers.push(
      setInterval(() => {
        void (async () => {
          try {
            const again = await identify(req);
            if (principalKey(again) !== key) throw new Error("principal changed");
            await conversations.authorizeRead(id, callOpts);
          } catch {
            sink.send(frame("error", { error: "unauthorized" }));
            end();
          }
        })();
      }, reauthMs).unref()
    );
    const lifetime = setTimeout(() => {
      sink.send(frame("reconnect", {}));
      end();
    }, maxStreamMs);
    lifetime.unref();
    timers.push(lifetime as unknown as NodeJS.Timeout);

    try {
      for await (const item of followConversation(
        { reader: conversations.reader, eventStore: options.eventStore },
        id,
        {
          ...(resume !== undefined && { cursor: resume }),
          signal: ctl.signal,
          ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
        }
      )) {
        if (item.type === "message") sink.send(frame("message", item.entry, item.entry.cursor));
        else {
          sink.send(frame("closed", {}));
          break;
        }
      }
    } catch (err) {
      if (!ended) {
        const e = mapError(err, true);
        sink.send(frame("error", e.body));
      }
    } finally {
      end();
    }
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) throw NOT_FOUND;
    const corsOrigin = checkOrigin(req);
    if (method === "OPTIONS") {
      // A preflight carries no credentials: answer it for allowed origins only.
      if (corsOrigin === undefined) throw NOT_FOUND;
      res.writeHead(204, {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, last-event-id",
        "access-control-max-age": "600",
        vary: "Origin",
      });
      res.end();
      return;
    }
    const principal = await identify(req);
    if (principal === undefined && strict) throw new HttpError(401, { error: "unauthorized" });
    const call = principal !== undefined ? { principal } : {};
    const cors =
      corsOrigin !== undefined ? { "access-control-allow-origin": corsOrigin, vary: "Origin" } : {};
    const rest = url.pathname
      .slice(base.length)
      .split("/")
      .filter((s) => s !== "");
    const decode = (s: string): string => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw NOT_FOUND;
      }
    };

    if (rest.length === 0) {
      if (method !== "POST")
        throw new HttpError(405, { error: "method not allowed" }, { allow: "POST" });
      await readJson(req, maxBody); // no fields are honoured: the server mints the id
      try {
        const { conversationId } = await conversations.start(call);
        sendJson(res, 201, { conversationId }, cors);
      } catch (err) {
        throw mapError(err, false);
      }
      return;
    }

    const id = decode(rest[0] as string);
    if (!isValidConversationId(id)) throw NOT_FOUND;
    const action = rest[1];
    try {
      if (rest.length === 1 && method === "GET") {
        sendJson(res, 200, await conversations.status(id, call), cors);
        return;
      }
      if (rest.length === 2 && action === "turns" && method === "POST") {
        const body = (await readJson(req, maxBody)) as {
          text?: unknown;
          messageId?: unknown;
        } | null;
        if (typeof body?.text !== "string") throw new BadRequestError("`text` must be a string");
        if (
          body.messageId !== undefined &&
          (typeof body.messageId !== "string" ||
            body.messageId.length === 0 ||
            body.messageId.length > 200)
        ) {
          throw new BadRequestError(
            "`messageId` must be a non-empty string of at most 200 characters"
          );
        }
        const sent = await conversations.sendTurn(id, body.text, {
          ...call,
          ...(typeof body.messageId === "string" && { messageId: body.messageId }),
        });
        sendJson(res, 202, { messageId: sent.messageId, inboxSeq: sent.inboxSeq }, cors);
        return;
      }
      if (rest.length === 2 && action === "close" && method === "POST") {
        await readJson(req, maxBody);
        const sent = await conversations.close(id, call);
        sendJson(res, 202, { messageId: sent.messageId }, cors);
        return;
      }
      if (rest.length === 2 && action === "history" && method === "GET") {
        const limit = url.searchParams.get("limit");
        const cursor = url.searchParams.get("cursor");
        const direction = url.searchParams.get("direction");
        if (direction !== null && direction !== "forward" && direction !== "backward") {
          throw new BadRequestError("`direction` must be forward or backward");
        }
        const n = limit === null ? undefined : Number(limit);
        if (n !== undefined && (!Number.isInteger(n) || n < 1))
          throw new BadRequestError("`limit` must be a positive integer");
        const page = await conversations.history(id, {
          ...call,
          ...(n !== undefined && { limit: n }),
          ...(cursor !== null && { cursor }),
          ...(direction !== null && { direction }),
        });
        sendJson(res, 200, page, cors);
        return;
      }
      if (rest.length === 2 && action === "events" && method === "GET") {
        await events(req, res, id, principal, url, corsOrigin);
        return;
      }
    } catch (err) {
      throw mapError(err, true);
    }
    throw NOT_FOUND;
  }

  const server = http.createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      const e = mapError(err, true);
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e.status === 413) res.once("finish", () => req.destroy());
      sendJson(res, e.status, e.body, e.headers);
    });
  });

  return {
    get url() {
      return resolvedUrl;
    },
    get connections() {
      return open.size;
    },
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, host, () => {
          const addr = server.address() as AddressInfo | null;
          if (addr !== null && typeof addr === "object") {
            resolvedUrl = `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`;
          }
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      for (const c of [...open]) c.close();
      server.closeAllConnections();
      return new Promise((resolve, reject) => {
        server.close((err?: Error) => (err !== undefined ? reject(err) : resolve()));
      });
    },
  };
}
