import { API, type ApproveRequest, MISSION_ID, type ServerFrame, type StartRequest } from "../wire";

// Thin client for the server's HTTP + SSE API. All durable execution happens on
// the server; the client only starts missions, streams surface updates, and
// posts approvals.

export async function startMission(goal: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(API.missions, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal } satisfies StartRequest),
  });
  return { ok: res.ok, status: res.status };
}

export async function approve(approved: boolean): Promise<void> {
  await fetch(API.approve(MISSION_ID), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved } satisfies ApproveRequest),
  });
}

// Server-Sent Events: the server pushes a snapshot on connect, then one frame
// per A2UI patch. EventSource reconnects automatically on a dropped connection
// (the server replies with a fresh snapshot).
export function openStream(onFrame: (frame: ServerFrame) => void): EventSource {
  const es = new EventSource(API.stream(MISSION_ID));
  es.onmessage = (e: MessageEvent<string>) => {
    onFrame(JSON.parse(e.data) as ServerFrame);
  };
  return es;
}
