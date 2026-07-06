import * as http from "node:http";
import type { EventStore } from "@loom/event-runtime";
import { describeState, foldAt } from "./core";
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
<label>Execution id <input id=exec placeholder="executionId" style="width:20rem"></label>
<button onclick="load()">load</button>
<div id=meta></div>
<input id=slider type=range min=0 value=0 oninput="show()">
<div id=timeline></div><pre id=state></pre>
<script>
let trace=null;
async function load(){const id=document.getElementById('exec').value;
 const r=await fetch('/api/trace/'+encodeURIComponent(id));if(!r.ok){alert('not found');return;}
 trace=await r.json();document.getElementById('meta').textContent='workflow '+trace.workflowId+' — '+trace.finalStatus;
 const s=document.getElementById('slider');s.max=trace.timeline.length-1;s.value=trace.timeline.length-1;show();}
async function show(){if(!trace)return;const i=+document.getElementById('slider').value;
 document.getElementById('timeline').innerHTML=trace.timeline.map((e,j)=>
  '<span class="ev'+(e.suspend?' suspend':'')+(j===i?' cur':'')+'">#'+e.sequence+' '+e.eventType+'</span>').join(' ');
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
 * `foldAt` engine as `loom debug`). The backing store is passed in, so
 * `loom dev`/`loom inspect` reuse this over SQLite.
 */
export function serveInspector(
  eventStore: EventStore,
  options: { port?: number } = {}
): InspectorServer {
  let resolvedPort = options.port ?? 0;

  const server = http.createServer((req, res): void => {
    void (async () => {
      const url = req.url ?? "/";
      try {
        if (url === "/" || url === "/index.html") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(PAGE);
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
        json(res, 500, { error: String(err instanceof Error ? err.message : err) });
      }
    })();
  });

  return {
    get url() {
      return `http://localhost:${resolvedPort}`;
    },
    get port() {
      return resolvedPort;
    },
    start() {
      return new Promise<void>((resolve) => {
        server.listen(options.port ?? 0, () => {
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
