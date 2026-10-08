import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/permissions";
import { AppError } from "./errors";

const state: { actor: Actor | null; ranWith: unknown } = { actor: null, ranWith: undefined };

vi.mock("@/lib/auth/actor", () => ({
  requireActor: async () => {
    if (!state.actor) throw new AppError("unauthenticated");
    return state.actor;
  },
}));
vi.mock("@/lib/db", () => ({
  withOrganisation: async (context: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    state.ranWith = context;
    return fn({});
  },
}));

const { opsRoute, idParams } = await import("./ops");

function staff(codes: string[], overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "u1",
    organisationId: "o1",
    kind: "staff",
    grants: codes.map((code) => ({ code, scopeType: "organisation", scopeId: null, highRisk: false })),
    secondFactorRequired: false,
    assuranceLevel: "aal2",
    ...overrides,
  };
}

const handler = opsRoute({ permission: "fleet.manage", params: idParams }, async ({ params }) => ({ id: params.id }));
const call = (id = "0190a5c4-0000-7000-8000-000000000001") =>
  handler(new Request("https://example.test/api/ops/x", { headers: { "x-forwarded-for": "41.66.1.2, 10.0.0.1" } }), {
    params: Promise.resolve({ id }),
  });

describe("opsRoute", () => {
  beforeEach(() => {
    state.actor = null;
    state.ranWith = undefined;
  });

  it("refuses someone signed out", async () => {
    expect((await call()).status).toBe(401);
  });

  it("refuses a passenger even if they somehow held the permission", async () => {
    state.actor = { ...staff(["fleet.manage"]), kind: "passenger" };
    expect((await call()).status).toBe(403);
  });

  it("refuses staff without the permission", async () => {
    state.actor = staff(["route.manage"]);
    const response = await call();
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("asks for the second factor when the role needs it", async () => {
    state.actor = staff(["fleet.manage"], { secondFactorRequired: true, assuranceLevel: "aal1" });
    expect((await (await call()).json()).error.code).toBe("second_factor_required");
  });

  it("treats a malformed id as not found", async () => {
    state.actor = staff(["fleet.manage"]);
    expect((await call("not-a-uuid")).status).toBe(404);
  });

  it("runs in the actor's organisation, recording who acted and from where", async () => {
    state.actor = staff(["fleet.manage"]);
    const response = await call();
    expect(response.status).toBe(200);
    expect(state.ranWith).toMatchObject({ organisationId: "o1", actorUserId: "u1", sourceAddress: "41.66.1.2" });
  });
});
