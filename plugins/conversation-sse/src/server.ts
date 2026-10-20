import { randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { unwrapTainted } from "@loom/classify";
import {
  type ConversationHub,
  ConversationNotFoundError,
  type Conversations,
  InvalidCursorError,
  InvalidTurnError,
  ParticipantLimitError,
  QueueFullError,
  SubscriberLimitError,
  followConversation,
  isValidConversationId,
  parseCursor,
  parseIdentity,
} from "@loom/conversation";
import { BadRequestError, exposeError } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import { type ReasoningReader, readReasoning } from "@loom/llm";
import {
  ExecutionDeniedError,
  InboxClosedError,
  InboxFullError,
  InboxMessageRefusedError,
} from "@loom/workflow-runtime";
import { SseSink, frame } from "./sse";

// ── The end-user gateway of a conversation (ADR 0122 D6, D10) ───────────────────────────────────────
//
//   POST /conversations                          start one (the SERVER mints the id)
//   GET  /conversations/:id                      status
//   POST /conversations/:id/turns                send a turn   { text, messageId?, editOf? }
//   POST /conversations/:id/close                close it
//   GET  /conversations/:id/history              a bounded page   ?limit&cursor&direction
//   GET  /conversations/:id/events               the SSE stream   Last-Event-ID | ?cursor
//   GET  /conversations/:id/reasoning?cursor=    a reply's durable model reasoning (opt-in, ADR 0133 D6)
//   shared mode:
//   GET  /conversations/:id/participants         the participant set        (owner / manager)
//   POST /conversations/:id/participants         { actor, tenant?, onBehalfOf? }  add
//   POST /conversations/:id/participants/remove  { actor, tenant?, onBehalfOf? }  remove
//
// SECURITY MODEL. Fail closed at every step, and say nothing a caller was not entitled to.
//   * AUTHENTICATION: every route needs `authenticate(req)` to return a principal with an `actor`;
//     the server REFUSES TO BE CREATED without it unless `insecure: true` (never under strict), and
//     refuses a runtime with no fail-closed execution authorizer unless `allowNoRuntimeAuthz`.
//   * AUTHORIZATION is `@loom/conversation`'s, per conversation: OWNER-ONLY by default (the identity that
//     started it), or the explicit participant set of a shared conversation. There is no second ACL here.
//   * EXISTENCE IS HIDDEN: a conversation the caller may not touch and one that does not exist both
//     answer 404 `{"error":"not found"}`, on every route including the stream.
//   * ISOLATION: a stream is keyed by one conversation id; the live hub and the log reader are both
//     keyed by it, and a cursor is a position INSIDE that conversation's chain. Shared mode filters
//     every entry, the stream's deltas and the partial reply PER VIEWER.
//   * REASONING (ADR 0133 D6) is OFF by default, live and durable. When on, it goes to the turn's ASKER ONLY
//     (in shared mode never to another participant, the owner included), over its own SSE event types
//     (`reasoning`, `reasoning-partial`) and its own endpoint; a caller who may not have it gets the same 404
//     as a missing conversation. It is model-derived text restating what the asker's turn saw: it is
//     unwrapped from its untrusted wrapper HERE, at the transport edge, and nowhere earlier.
//   * LOOPBACK by default; a loopback `Host` allowlist protects an unauthenticated server from DNS
//     rebinding. CSRF/CORS: a request carrying an `Origin` must name one of `allowedOrigins` (the
//     `Host` header is never trusted to prove same-origin), POST bodies must be `application/json`.
//   * LIMITS: connections (total, per principal), live subscribers per conversation (the hub's),
//     request body and timeouts, a POST rate limit per principal, per-connection pending bytes (a slow
//     reader is closed), stream lifetime. A connection is re-authenticated periodically; a revoked token
//     or a removed participant ends the stream.

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
  /** Fail closed on a principal-less caller. DEFAULTS from the runtime (`requiresPrincipal`), as the A2A server does. */
  strict?: boolean;
  /**
   * Serve a runtime that has no fail-closed execution authorizer (`security.strict` / `executionAuthz:
   * { requirePrincipal: true }`). Refused by default: this server is an edge, and an edge in front of a
   * runtime that admits anonymous calls is a hole the application would have to remember.
   */
  allowNoRuntimeAuthz?: boolean;
  warn?: (message: string) => void;
  /**
   * Browser origins allowed to call this server, matched exactly. A request with an `Origin` that is
   * not listed is refused: `Host` is attacker-influenced and never proves same-origin. Default none.
   */
  allowedOrigins?: readonly string[];
  /** Send `access-control-allow-credentials: true` to the listed origins (cookies / `EventSource` `withCredentials`). Default false. */
  allowCredentials?: boolean;
  /**
   * `Host` header values accepted (hostname, port ignored). Default: the loopback names when `insecure`
   * (DNS-rebinding protection for an unauthenticated server); unchecked otherwise.
   */
  allowedHosts?: readonly string[];
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
  /** POSTs (start, turns, close, participants) one principal may make per window. Default 120 per minute. */
  rateLimit?: { max?: number; windowMs?: number };
  /** The clock the rate limit reads (tests). Default `Date.now`. */
  now?: () => number;
  /** Time a client may take to send its request, ms (slowloris). Default 30 000. */
  requestTimeoutMs?: number;
  /** Time a client may take to send its headers, ms. Default 15 000. */
  headersTimeoutMs?: number;
  /** Open sockets the server accepts at all (`http.Server.maxConnections`). Default 4096. */
  maxSockets?: number;
  /**
   * ADR 0133 D6 - serve the model's reasoning. OFF by default. `true` (or `{ live: true }`) streams the
   * `reasoning` / `reasoning-partial` SSE events; `{ store }` also serves a reply's durable reasoning at
   * `GET <base>/:id/reasoning?cursor=<the reply's history cursor>` (the `ReasoningStore` the model effect
   * captured into). In SHARED mode only the turn's asker receives any of it.
   */
  reasoning?: boolean | { live?: boolean; store?: ReasoningReader };
  /** Real error behind a 500, with the `errorId` the caller was given. */
  onError?: (errorId: string, err: unknown) => void;
}

export interface ConversationSseServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  /** Open streams right now. */
  readonly connections: number;
  /** The underlying `http.Server` (timeouts and limits are set on it; exposed for operators and tests). */
  readonly http: http.Server;
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
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

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
  const strict = options.strict ?? conversations.requiresPrincipal;
  const rateMax = options.rateLimit?.max ?? 120;
  const rateWindow = options.rateLimit?.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const reasoningOpt = options.reasoning === true ? { live: true } : options.reasoning || undefined;
  const liveReasoning = reasoningOpt?.live === true;
  const reasoningStore = reasoningOpt?.store;

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
  if (
    !conversations.requiresPrincipal &&
    options.allowNoRuntimeAuthz !== true &&
    options.insecure !== true
  ) {
    throw new Error(
      "createConversationSseServer: the runtime has no fail-closed execution authorizer (executionAuthorizer + executionAuthz.requirePrincipal, i.e. security.strict). Wire one, or pass `allowNoRuntimeAuthz: true` to accept an edge in front of an open runtime."
    );
  }
  const hostAllow = new Set(
    (options.allowedHosts ?? (options.insecure === true ? LOOPBACK_HOSTS : [])).map((h) =>
      h.toLowerCase()
    )
  );

  let resolvedUrl = `http://${host.includes(":") ? `[${host}]` : host}:${options.port ?? 0}`;
  const open = new Set<{ close: () => void }>();
  const perPrincipal = new Map<string, number>();
  const rate = new Map<string, { windowStart: number; n: number }>();

  /** One window counter per principal for the POSTs; the map is bounded (expired entries are swept). */
  function takeRate(key: string): void {
    const t = now();
    if (rate.size > 10_000) {
      for (const [k, v] of rate) if (t - v.windowStart >= rateWindow) rate.delete(k);
    }
    const cur = rate.get(key);
    if (cur === undefined || t - cur.windowStart >= rateWindow) {
      rate.set(key, { windowStart: t, n: 1 });
      return;
    }
    cur.n++;
    if (cur.n > rateMax) {
      throw new HttpError(
        429,
        { error: "too many requests" },
        {
          "retry-after": String(
            Math.max(1, Math.ceil((rateWindow - (t - cur.windowStart)) / 1000))
          ),
        }
      );
    }
  }

  async function identify(req: http.IncomingMessage): Promise<PrincipalChain | undefined> {
    if (options.authenticate === undefined) return undefined; // insecure
    const p = await options.authenticate(req);
    if (p === undefined || !hasActor(p)) throw new HttpError(401, { error: "unauthorized" });
    return p;
  }

  /** DNS rebinding: an unauthenticated loopback server must not answer a request addressed to some other name. */
  function checkHost(req: http.IncomingMessage): void {
    if (hostAllow.size === 0) return;
    const raw = (req.headers.host ?? "").toLowerCase();
    const name = raw.startsWith("[")
      ? raw.slice(0, raw.indexOf("]") + 1)
      : (raw.split(":")[0] ?? "");
    if (!hostAllow.has(name)) throw new HttpError(421, { error: "misdirected request" });
  }

  /** The allowed browser origin of this request, or a refusal. `Host` is never consulted. */
  function checkOrigin(req: http.IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    if (origin === undefined) return undefined; // not a browser cross-origin request
    if (!allowed.has(origin)) throw new HttpError(403, { error: "origin not allowed" });
    return origin;
  }

  /** CORS headers for an allowed origin: ride EVERY response, errors included (a browser cannot read a 4xx without them). */
  const corsHeaders = (origin: string | undefined): Record<string, string> =>
    origin === undefined
      ? {}
      : {
          "access-control-allow-origin": origin,
          vary: "Origin",
          ...(options.allowCredentials === true && { "access-control-allow-credentials": "true" }),
        };

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
      err instanceof InboxMessageRefusedError ||
      err instanceof ParticipantLimitError
    ) {
      return new HttpError(400, { error: err.message });
    }
    if (err instanceof InboxClosedError)
      return new HttpError(409, { error: "conversation is closed" });
    if (
      err instanceof InboxFullError ||
      err instanceof SubscriberLimitError ||
      err instanceof QueueFullError
    ) {
      return new HttpError(429, { error: "too many requests" }, { "retry-after": "1" });
    }
    const exposed = exposeError(err, randomUUID);
    if (exposed.internal !== undefined) {
      options.onError?.(exposed.body.errorId as string, exposed.internal);
    }
    return new HttpError(exposed.status, exposed.body);
  };

  async function events(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    principal: PrincipalChain | undefined,
    url: URL,
    cors: Record<string, string>
  ): Promise<void> {
    const callOpts = principal !== undefined ? { principal } : {};
    // The client may hang up while we authorize. Remember it from the first instant: a `close` that
    // fires before the listener below exists would otherwise never be seen, and the slot would be held
    // for the whole stream lifetime.
    let gone = false;
    const onGone = (): void => {
      gone = true;
    };
    req.once("close", onGone);
    res.once("close", onGone);
    const dropped = (): boolean => gone || req.destroyed || res.destroyed || res.writableEnded;
    // AUTHORIZE FIRST: nothing below (not even a limit that would answer 429) may reveal that a
    // conversation exists to a caller who may not read it. `status` is that gate and the first frame.
    const status = await conversations.status(id, callOpts);
    if (dropped()) return;
    const resume =
      (req.headers["last-event-id"] as string | undefined) ??
      url.searchParams.get("cursor") ??
      undefined;
    if (resume !== undefined && parseCursor(resume) === undefined) throw new InvalidCursorError();

    const key = principalKey(principal);
    if (open.size >= maxConnections || (perPrincipal.get(key) ?? 0) >= maxPerPrincipal) {
      throw new HttpError(429, { error: "too many streams" }, { "retry-after": "5" });
    }
    const viewer = conversations.viewerKey(principal);
    const ctl = new AbortController();
    // Live subscription (a limit here is still an HTTP answer), then the catch-up snapshot of the
    // in-progress reply taken in the same tick, so no delta falls between them.
    const sink = new SseSink(res, maxPending, () => end());
    const deltaFrame = (turn: number, text: string) => frame("delta", { turn, text });
    // SHARED: a live delta streams to the ASKER alone. Whether the answer is restricted is only known when
    // the turn ends (the tools it used), so until then nobody else may see its tokens; they get the
    // durable entry (or a bare placeholder) on completion.
    const mine = (asker: string | undefined): boolean => asker === undefined || asker === viewer;
    // REASONING is stricter than a delta: in shared mode it needs a KNOWN asker that is this viewer (an
    // event with no asker is never served), in owner mode the stream is already the owner's alone.
    const reasoningFrame = (turn: number, text: string) => frame("reasoning", { turn, text });
    const askerOnly = (asker: string | undefined): boolean =>
      liveReasoning &&
      (conversations.mode !== "shared" || (asker !== undefined && asker === viewer));
    const unsubscribe = hub.subscribe(id, (ev) => {
      if (ev.type === "reasoning") {
        if (askerOnly(ev.asker)) sink.delta(ev.turn, ev.text, reasoningFrame, "reasoning");
        return;
      }
      if (!mine(ev.asker)) return;
      if (ev.type === "delta") sink.delta(ev.turn, ev.text, deltaFrame);
      else sink.send(frame("reset", { turn: ev.turn }));
    });
    const partial = hub.partialOf(id);
    const reasoningPartial = liveReasoning ? hub.reasoningPartialOf(id) : undefined;

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
    // A hang-up that raced the setup above is acted on now, and one that comes later by the listeners.
    req.once("close", end);
    res.once("close", end);
    res.on("error", end);
    if (dropped()) {
      end();
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      ...cors,
    });
    res.flushHeaders();
    sink.send("retry: 3000\n\n");
    sink.send(frame("status", status));
    if (partial !== undefined && mine(partial.asker)) {
      sink.send(frame("partial", { turn: partial.turn, text: partial.text }));
    }
    if (reasoningPartial !== undefined && askerOnly(reasoningPartial.asker)) {
      sink.send(
        frame("reasoning-partial", { turn: reasoningPartial.turn, text: reasoningPartial.text })
      );
    }

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
        // Membership is judged for EVERY delivered message, not only at the periodic re-authorization: a
        // participant removed a moment ago must not be handed the next entry in the interval.
        if (!(await conversations.isParticipant(id, principal))) {
          sink.send(frame("error", { error: "unauthorized" }));
          break;
        }
        if (item.type === "message") {
          // The per-viewer filter: a restricted entry reaches this viewer as a bare placeholder.
          const [entry] = await conversations.filterEntries([item.entry], principal);
          if (entry !== undefined) sink.send(frame("message", entry, item.entry.cursor));
        } else {
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

  const identityBody = (body: unknown) => {
    const identity = parseIdentity(body);
    if (identity === undefined) throw new BadRequestError("`actor` must be a non-empty string");
    return identity;
  };

  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    corsRef: { cors: Record<string, string> }
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) throw NOT_FOUND;
    checkHost(req);
    const corsOrigin = checkOrigin(req);
    corsRef.cors = corsHeaders(corsOrigin);
    const cors = corsRef.cors;
    if (method === "OPTIONS") {
      // A preflight carries no credentials: answer it for allowed origins only.
      if (corsOrigin === undefined) throw NOT_FOUND;
      res.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, last-event-id",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    const principal = await identify(req);
    if (principal === undefined && strict) throw new HttpError(401, { error: "unauthorized" });
    const call = principal !== undefined ? { principal } : {};
    if (method === "POST") takeRate(principalKey(principal));
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
      if (method !== "POST") {
        throw new HttpError(405, { error: "method not allowed" }, { allow: "POST" });
      }
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
          editOf?: unknown;
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
        if (
          body.editOf !== undefined &&
          (typeof body.editOf !== "number" || !Number.isSafeInteger(body.editOf) || body.editOf < 1)
        ) {
          throw new BadRequestError(
            "`editOf` must be a positive integer (the ord of an earlier turn)"
          );
        }
        const sent = await conversations.sendTurn(id, body.text, {
          ...call,
          ...(typeof body.editOf === "number" && { editOf: body.editOf }),
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
      if (action === "participants") {
        if (rest.length === 2 && method === "GET") {
          sendJson(res, 200, { participants: await conversations.participants(id, call) }, cors);
          return;
        }
        if (rest.length === 2 && method === "POST") {
          await conversations.addParticipant(id, identityBody(await readJson(req, maxBody)), call);
          sendJson(res, 202, { ok: true }, cors);
          return;
        }
        if (rest.length === 3 && rest[2] === "remove" && method === "POST") {
          await conversations.removeParticipant(
            id,
            identityBody(await readJson(req, maxBody)),
            call
          );
          sendJson(res, 202, { ok: true }, cors);
          return;
        }
      }
      if (rest.length === 2 && action === "history" && method === "GET") {
        const limit = url.searchParams.get("limit");
        const cursor = url.searchParams.get("cursor");
        const direction = url.searchParams.get("direction");
        if (direction !== null && direction !== "forward" && direction !== "backward") {
          throw new BadRequestError("`direction` must be forward or backward");
        }
        const n = limit === null ? undefined : Number(limit);
        if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
          throw new BadRequestError("`limit` must be a positive integer");
        }
        // A read stops when its client does: a hung-up request must not keep walking the log.
        const gone = new AbortController();
        res.once("close", () => gone.abort());
        const page = await conversations.history(id, {
          ...call,
          signal: gone.signal,
          ...(n !== undefined && { limit: n }),
          ...(cursor !== null && { cursor }),
          ...(direction !== null && { direction }),
        });
        sendJson(res, 200, page, cors);
        return;
      }
      if (rest.length === 2 && action === "reasoning" && method === "GET") {
        // Disabled unless the host gave a store: indistinguishable from a route that does not exist.
        if (reasoningStore === undefined) throw NOT_FOUND;
        const cursor = url.searchParams.get("cursor");
        if (cursor === null)
          throw new BadRequestError("`cursor` (the reply's history cursor) is required");
        // The audience decision is the conversation's: the asker in shared mode, the owner otherwise.
        const target = await conversations.reasoningTarget(id, cursor, call);
        const steps = (
          await readReasoning(options.eventStore, reasoningStore, {
            executionId: target.executionId,
          })
        ).filter((s) => target.stepPrefix === undefined || s.stepId.startsWith(target.stepPrefix));
        sendJson(
          res,
          200,
          {
            steps: steps.map((s) => ({
              stepId: s.stepId,
              ...(s.recordedAttempt !== undefined && { recordedAttempt: s.recordedAttempt }),
              attempts: s.attempts.map((a) => ({
                attempt: a.attempt,
                provider: a.provider,
                ...(a.model !== undefined && { model: a.model }),
                recorded: a.recorded,
                parts: a.parts.map((p) => ({
                  kind: p.kind,
                  status: p.status,
                  // The transport edge: the one place the untrusted wrapper comes off.
                  ...(p.text !== undefined && { text: unwrapTainted(p.text) }),
                })),
              })),
            })),
          },
          cors
        );
        return;
      }
      if (rest.length === 2 && action === "events" && method === "GET") {
        await events(req, res, id, principal, url, cors);
        return;
      }
    } catch (err) {
      throw mapError(err, true);
    }
    throw NOT_FOUND;
  }

  const server = http.createServer((req, res) => {
    const corsRef: { cors: Record<string, string> } = { cors: {} };
    void route(req, res, corsRef).catch((err: unknown) => {
      const e = mapError(err, true);
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e.status === 413) res.once("finish", () => req.destroy());
      sendJson(res, e.status, e.body, { ...corsRef.cors, ...e.headers });
    });
  });
  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  server.headersTimeout = options.headersTimeoutMs ?? 15_000;
  server.maxConnections = options.maxSockets ?? 4096;

  return {
    get url() {
      return resolvedUrl;
    },
    get connections() {
      return open.size;
    },
    http: server,
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
