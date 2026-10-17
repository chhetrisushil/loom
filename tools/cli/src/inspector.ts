import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { exposeError } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { describeState, foldAt } from "./core";
import { LS_STATUSES, scanExecutions } from "./ls";
import { buildTrace } from "./trace";

export interface InspectorServer {
  readonly url: string;
  readonly port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// A single-file, dependency-free timeline + time-travel slider. The reusable
// engine (buildTrace/foldAt) and the /api endpoints are unit-tested; this thin
// view is a static asset. A richer renderer-react inspector is a deferred follow-on.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>loom inspector</title>
<style>body{font:14px system-ui;margin:2rem;max-width:900px}input{width:100%}
.ev{padding:2px 6px;border-radius:4px}.ev.suspend{background:#fee}.cur{background:#def}
pre{background:#f6f6f6;padding:1rem;border-radius:6px;white-space:pre-wrap}</style></head>
<body><h1>loom inspector</h1>
<h2>executions</h2>
<label>status <select id=status onchange="list()"><option value="">any</option></select></label>
<div id=list>loading…</div>
<label>Execution id <input id=exec placeholder="executionId" style="width:20rem"></label>
<button onclick="load()">load</button>
<div id=meta></div>
<input id=slider type=range min=0 value=0 oninput="show()">
<div id=timeline></div><pre id=state></pre>
<script>
let trace=null;
/* Everything in the list is log data (ids, workflow names, event types): textContent only. */
async function list(){const st=document.getElementById('status');const box=document.getElementById('list');
 const q=st.value?'?status='+encodeURIComponent(st.value):'';
 const r=await fetch('/api/executions'+q);if(!r.ok){box.textContent='could not list executions';return;}
 const d=await r.json();box.textContent='';
 if(!st.options[1])for(const s of d.statuses){const o=document.createElement('option');o.value=s;o.textContent=s;st.appendChild(o);}
 d.executions.forEach(x=>{const a=document.createElement('a');a.href='#';
  a.textContent=x.executionId+'  ['+x.workflowId+']  '+x.status+'  #'+x.sequence+(x.waiting?'  waiting on '+x.waiting.on+(x.waiting.wakeAt?' @ '+new Date(x.waiting.wakeAt).toISOString():''):'');
  a.onclick=e=>{e.preventDefault();document.getElementById('exec').value=x.executionId;load();};
  box.appendChild(a);box.appendChild(document.createElement('br'));});
 const note=document.createElement('div');note.textContent=d.executions.length+' shown, '+d.scanned+' scanned'+(d.truncated?' (truncated: '+d.truncated+')':'');box.appendChild(note);}
list();
async function load(){const id=document.getElementById('exec').value;
 const r=await fetch('/api/trace/'+encodeURIComponent(id));if(!r.ok){alert('not found');return;}
 trace=await r.json();document.getElementById('meta').textContent='workflow '+trace.workflowId+' — '+trace.finalStatus;
 const s=document.getElementById('slider');s.max=trace.timeline.length-1;s.value=trace.timeline.length-1;show();}
async function show(){if(!trace)return;const i=+document.getElementById('slider').value;
 const tl=document.getElementById('timeline');tl.textContent='';
 trace.timeline.forEach((e,j)=>{const sp=document.createElement('span');
  sp.className='ev'+(e.suspend?' suspend':'')+(j===i?' cur':'');
  /* textContent, not innerHTML: eventType is log data. ctx.emit() and the A2A
     provideInput path both put caller-influenced strings there, so building markup
     from it let stored content run with access to /api/trace/* — every event log. */
  sp.textContent='#'+e.sequence+' '+e.eventType;
  tl.appendChild(sp);tl.appendChild(document.createTextNode(' '));});
 const seq=trace.timeline[i].sequence;
 const r=await fetch('/api/state/'+encodeURIComponent(trace.executionId)+'/'+seq);
 document.getElementById('state').textContent=await r.text();}
</script></body></html>`;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Serve a local inspector over the durable log: `/` (timeline + time-travel
 * slider), `/api/trace/:executionId` (the render model), and
 * `/api/state/:executionId/:seq` (the folded state at a sequence — the same
 * `foldAt` engine as `loom debug`), and `/api/executions[?status=&limit=]` (the read-only
 * list behind the page's clickable index — the same scan as `loom ls`). The backing store is passed in, so
 * `loom dev`/`loom inspect` reuse this over SQLite.
 */
export function serveInspector(
  eventStore: EventStore,
  options: { port?: number; host?: string } = {}
): InspectorServer {
  let resolvedPort = options.port ?? 0;
  // Bind to loopback by default.
  //
  // `server.listen(port)` with no host binds ALL interfaces, and this server has no
  // authentication and serves `/api/trace/:id` — an execution's entire durable log,
  // including every step input and output. Running `loom inspect` on a laptop therefore
  // published the complete event history to anyone who could reach the port, while the
  // startup banner said "http://localhost:…" and implied otherwise.
  //
  // Exposing it is now an explicit choice (`host: "0.0.0.0"`), not the default.
  const host = options.host ?? "127.0.0.1";

  const server = http.createServer((req, res): void => {
    void (async () => {
      const url = req.url ?? "/";
      try {
        if (url === "/" || url === "/index.html") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(PAGE);
          return;
        }
        const listing = /^\/api\/executions(?:\?(.*))?$/.exec(url);
        if (listing) {
          const q = new URLSearchParams(listing[1] ?? "");
          const status = q.get("status") ?? undefined;
          if (status !== undefined && !(LS_STATUSES as readonly string[]).includes(status)) {
            json(res, 400, { error: "unknown status" });
            return;
          }
          if (
            eventStore.listExecutions === undefined &&
            eventStore.listExecutionsPage === undefined
          ) {
            json(res, 501, { error: "this store cannot enumerate executions" });
            return;
          }
          const limit = Math.min(
            Math.max(Number.parseInt(q.get("limit") ?? "50", 10) || 50, 1),
            500
          );
          const result = await scanExecutions(eventStore, {
            limit,
            ...(status !== undefined && { status: status as (typeof LS_STATUSES)[number] }),
          });
          json(res, 200, {
            statuses: LS_STATUSES,
            executions: result.rows,
            scanned: result.scanned,
            ...(result.truncated !== undefined && { truncated: result.truncated }),
          });
          return;
        }
        const trace = /^\/api\/trace\/([^/]+)$/.exec(url);
        if (trace) {
          const events = await eventStore.read(decodeURIComponent(trace[1]!));
          if (events.length === 0) {
            json(res, 404, { error: "not found" });
            return;
          }
          json(res, 200, buildTrace(events));
          return;
        }
        const state = /^\/api\/state\/([^/]+)\/(\d+)$/.exec(url);
        if (state) {
          const events = await eventStore.read(decodeURIComponent(state[1]!));
          if (events.length === 0) {
            json(res, 404, { error: "not found" });
            return;
          }
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(describeState(foldAt(events, Number.parseInt(state[2]!, 10))));
          return;
        }
        json(res, 404, { error: "not found" });
      } catch (err) {
        const exposed = exposeError(err, randomUUID);
        if (exposed.internal !== undefined) {
          // A dev tool, but the same rule: the response says nothing internal, and the
          // detail goes where the operator is already looking.
          console.error(`[inspector] ${exposed.body.errorId}`, exposed.internal);
        }
        json(res, exposed.status, exposed.body);
      }
    })();
  });

  return {
    get url() {
      // Report the interface actually bound, so the banner cannot claim loopback while
      // listening on everything.
      return `http://${host === "0.0.0.0" || host === "::" ? "0.0.0.0" : "localhost"}:${resolvedPort}`;
    },
    get port() {
      return resolvedPort;
    },
    start() {
      return new Promise<void>((resolve) => {
        server.listen(options.port ?? 0, host, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") resolvedPort = addr.port;
          resolve();
        });
      });
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err !== undefined ? reject(err) : resolve()));
      });
    },
  };
}

/** Exported for tests: the page is a literal, so its DOM sinks are assertable. */
export const INSPECTOR_PAGE_FOR_TEST = PAGE;
