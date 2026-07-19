import * as http from "node:http";

// ── An in-process MCP telemetry server (offline, deterministic) ───────────────
// Speaks the JSON-RPC subset McpClient uses (initialize / tools/list / tools/call)
// and serves RAW telemetry in backend-native shapes — deliberately DIFFERENT from
// the projection-state shapes the dashboard binds to, so the sandboxed reshaping
// scripts have real work to do. `upgradeReplicationTool()` simulates a backend
// deploy that changes one tool's input schema: the plan's pinned hash no longer
// matches, and the hydration flow must repair in-band (typed schemaDrift).

interface RawTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  result: () => unknown;
}

/** Per-tool input schema — distinct per tool, so every plan pin is distinct too. */
function windowSchema(subject: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      window: { type: "string", description: `sample window over ${subject}, e.g. 5m` },
    },
  };
}

function makeTools(): Map<string, RawTool> {
  const tools: RawTool[] = [
    {
      name: "db.cpu",
      description: "CPU utilization samples for the primary",
      inputSchema: windowSchema("cpu samples"),
      result: () => ({
        window: "5m",
        samples: [42, 55, 68, 79, 91].map((pct, i) => ({ t: i * 60, pct })),
      }),
    },
    {
      name: "db.connections",
      description: "Connection pool occupancy",
      inputSchema: windowSchema("pool occupancy"),
      result: () => ({ in_use: 98, queued: 12, max: 100 }),
    },
    {
      name: "db.replication",
      description: "Replica apply lag",
      inputSchema: windowSchema("replica lag"),
      result: () => ({
        write_rate: "rising",
        replicas: [
          { name: "replica-a", lag_ms: 320 },
          { name: "replica-b", lag_ms: 240 },
        ],
      }),
    },
    {
      name: "db.queries",
      description: "Top CPU-consuming statements",
      inputSchema: windowSchema("statement load"),
      result: () => ({
        observed_total: 3800,
        top: [
          { sql: "SELECT * FROM orders o JOIN line_items li ON …", cpu_pct: 61, n_calls: 1240 },
          { sql: "UPDATE inventory SET qty = qty - $1 WHERE …", cpu_pct: 18, n_calls: 880 },
        ],
      }),
    },
  ];
  return new Map(tools.map((t) => [t.name, t]));
}

export interface TelemetryMcpServer {
  url: string;
  /** tools/call invocations per tool name (observability for tests/narration). */
  calls: Map<string, number>;
  /** Simulate a backend deploy: db.replication's input schema gains a field → its hash moves. */
  upgradeReplicationTool: () => void;
  close: () => Promise<void>;
}

export function startTelemetryMcpServer(): Promise<TelemetryMcpServer> {
  const tools = makeTools();
  const calls = new Map<string, number>();

  const server = http.createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        method: string;
        id: number;
        params?: Record<string, unknown>;
      };
      let result: unknown;
      if (body.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: {} };
      } else if (body.method === "tools/list") {
        result = {
          tools: [...tools.values()].map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        };
      } else if (body.method === "tools/call") {
        const name = body.params?.name as string;
        const tool = tools.get(name);
        calls.set(name, (calls.get(name) ?? 0) + 1);
        result = {
          content: [{ type: "text", text: JSON.stringify(tool ? tool.result() : null) }],
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      resolve({
        url: `http://localhost:${port}`,
        calls,
        upgradeReplicationTool: () => {
          const replication = tools.get("db.replication");
          if (replication) {
            const base = windowSchema("replica lag");
            replication.inputSchema = {
              ...base,
              properties: {
                ...(base.properties as Record<string, unknown>),
                include_wal: { type: "boolean", description: "include WAL apply detail" },
              },
            };
          }
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
