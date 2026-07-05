import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { API, type ServerFrame, type StartRequest } from "../wire";
import { createApp } from "./app";

const PORT = Number(process.env.PORT ?? 8787);

// ── HTTP helpers (mirroring @loom/a2a's A2AServer) ────────────────────────────
function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ── Durable, server-side backend + SSE fan-out ────────────────────────────────
const app = createApp({ dataDir: path.resolve(process.cwd(), ".data") });
const { orchestrator } = app;

const clients = new Set<http.ServerResponse>();
app.subscribeBroadcast((frame: ServerFrame) => {
  const line = `data: ${JSON.stringify(frame)}\n\n`;
  for (const res of clients) res.write(line);
});

// ── Static client (production: `pnpm start` serves the built bundle) ──────────
const distDir = path.resolve(process.cwd(), "dist");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};
function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(distDir, rel);
  if (!filePath.startsWith(distDir)) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(distDir, "index.html"), (err2, html) => {
        if (err2) {
          json(res, 404, { error: "not found (run `pnpm build:ui`, or use `pnpm dev`)" });
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    });
    res.end(data);
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  void (async () => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    try {
      // POST /api/missions — start (or restart) the mission for a goal.
      if (method === "POST" && url === API.missions) {
        if (orchestrator.isBusy()) {
          json(res, 409, { error: "a mission is already running" });
          return;
        }
        const body = (await parseBody(req)) as StartRequest;
        const goal = String(body?.goal ?? "").trim();
        if (!goal) {
          json(res, 400, { error: "missing goal" });
          return;
        }
        // Long-running: fire-and-forget; progress streams over SSE.
        void orchestrator.run(goal).catch((err) => console.error("[mission] failed:", err));
        json(res, 202, { missionId: app.missionId });
        return;
      }

      // GET /api/missions/:id/stream — SSE: snapshot on connect, then patches.
      if (method === "GET" && url === API.stream(app.missionId)) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        clients.add(res);
        // Register first, THEN snapshot in the same tick — no patch can interleave.
        const snapshot: ServerFrame = { kind: "snapshot", snapshot: app.snapshot() };
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        req.on("close", () => clients.delete(res));
        return;
      }

      // POST /api/missions/:id/approve — human-in-the-loop decision.
      if (method === "POST" && url === API.approve(app.missionId)) {
        const body = (await parseBody(req)) as { approved?: boolean };
        orchestrator.resolveApproval(Boolean(body?.approved));
        json(res, 200, { ok: true });
        return;
      }

      if (url.startsWith("/api/")) {
        json(res, 404, { error: "not found" });
        return;
      }
      serveStatic(res, url.split("?")[0] ?? "/");
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`DB Command Center server on http://localhost:${PORT}`);
});

function shutdown(): void {
  server.close();
  app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
