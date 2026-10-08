import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "./errors";
import { apiRoute, readJson } from "./handler";

const request = (init?: RequestInit & { headers?: Record<string, string> }) => new Request("https://example.test/api/x", init);

describe("apiRoute", () => {
  it("wraps data in the standard shape with a correlation id", async () => {
    const response = await apiRoute(async () => ({ data: { hello: "world" } }))(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { hello: "world" } });
    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a well-formed correlation id from the client", async () => {
    const response = await apiRoute(async () => ({ data: null }))(request({ headers: { "x-correlation-id": "abc12345-req" } }));
    expect(response.headers.get("x-correlation-id")).toBe("abc12345-req");
  });

  it("maps an AppError to its stable code and status", async () => {
    const response = await apiRoute(async () => {
      throw new AppError("forbidden");
    })(request());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
    expect(body.error.correlationId).toBe(response.headers.get("x-correlation-id"));
  });

  it("never leaks internal error details", async () => {
    const response = await apiRoute(async () => {
      throw new Error("connection to db.internal:5432 refused");
    })(request());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("db.internal");
    expect(JSON.parse(text).error.code).toBe("internal_error");
  });

  it("passes a business rule's plain message through, and hides other database detail", async () => {
    const rule = await apiRoute(async () => {
      throw Object.assign(new Error("Stops can only be changed while the route is a draft."), { code: "BR001" });
    })(request());
    expect(rule.status).toBe(422);
    expect((await rule.json()).error).toMatchObject({ code: "rule_violation", message: "Stops can only be changed while the route is a draft." });

    const duplicate = await apiRoute(async () => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint_name: "vehicles_organisation_id_registration_key" });
    })(request());
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.message).toBe("A vehicle with this registration already exists.");
  });

  it("reports validation failures with field paths", async () => {
    const schema = z.object({ seats: z.number().int().min(1) });
    const response = await apiRoute(async ({ request: r }) => ({ data: await readJson(r, schema) }))(
      request({ method: "POST", body: JSON.stringify({ seats: 0 }) }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details[0].path).toBe("seats");
  });
});
