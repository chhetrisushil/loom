import { describe, expect, it } from "vitest";
import { BadRequestError, exposeError } from "./exposure";

const ids = () => {
  let n = 0;
  return () => `id-${n++}`;
};

describe("exposeError", () => {
  it("keeps a client error's message — it describes the caller's own request", () => {
    const exposed = exposeError(new BadRequestError("request body is not valid JSON"), ids());
    expect(exposed).toEqual({ status: 400, body: { error: "request body is not valid JSON" } });
    // Nothing to log server-side: the caller already has the whole story.
    expect(exposed.internal).toBeUndefined();
  });

  it("reveals nothing about an internal error, but stays diagnosable", () => {
    const cause = new Error('relation "events" does not exist at /srv/app/db.ts:41');
    const exposed = exposeError(cause, ids());
    expect(exposed.status).toBe(500);
    expect(exposed.body.error).toBe("internal error");
    // The response must not carry the table name, the path, or the message.
    const wire = JSON.stringify(exposed.body);
    expect(wire).not.toContain("relation");
    expect(wire).not.toContain("/srv/app");
    // …but the operator can still tie the response to the real error.
    expect(exposed.body.errorId).toBe("id-0");
    expect(exposed.internal).toBe(cause);
  });

  it("mints a distinct id per internal error", () => {
    const next = ids();
    expect(exposeError(new Error("a"), next).body.errorId).toBe("id-0");
    expect(exposeError(new Error("b"), next).body.errorId).toBe("id-1");
  });

  it("treats a non-Error throw as internal", () => {
    const exposed = exposeError({ secret: "s3cr3t" }, ids());
    expect(exposed.status).toBe(500);
    expect(JSON.stringify(exposed.body)).not.toContain("s3cr3t");
  });

  it("classifies by TYPE, not by message text", () => {
    // A message that merely looks client-ish is still internal; only the thrown type decides.
    expect(exposeError(new Error("request body is not valid JSON"), ids()).status).toBe(500);
    expect(new BadRequestError("x")).toBeInstanceOf(Error);
  });
});
