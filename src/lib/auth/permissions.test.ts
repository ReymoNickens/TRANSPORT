import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/errors";
import { hasPermission, requirePermission, type Actor } from "./permissions";

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "u1",
    organisationId: "o1",
    kind: "staff",
    grants: [
      { code: "booking.view.scope", scopeType: "organisation", scopeId: null, highRisk: false },
      { code: "ticket.scan", scopeType: "journey", scopeId: "j1", highRisk: false },
    ],
    secondFactorRequired: false,
    assuranceLevel: "aal1",
    ...overrides,
  };
}

function codeOf(fn: () => void) {
  try {
    fn();
  } catch (error) {
    return (error as AppError).code;
  }
  return null;
}

describe("permissions", () => {
  it("an organisation-wide grant covers every scope", () => {
    expect(hasPermission(actor(), "booking.view.scope")).toBe(true);
    expect(hasPermission(actor(), "booking.view.scope", { type: "journey", id: "j9" })).toBe(true);
  });

  it("a journey grant covers only that journey", () => {
    expect(hasPermission(actor(), "ticket.scan", { type: "journey", id: "j1" })).toBe(true);
    expect(hasPermission(actor(), "ticket.scan", { type: "journey", id: "j2" })).toBe(false);
    expect(hasPermission(actor(), "ticket.scan")).toBe(false);
  });

  it("refuses a permission the actor does not hold", () => {
    expect(codeOf(() => requirePermission(actor(), "refund.approve"))).toBe("forbidden");
  });

  it("requires the second factor when a role demands it", () => {
    const needsIt = actor({ secondFactorRequired: true });
    expect(codeOf(() => requirePermission(needsIt, "booking.view.scope"))).toBe("second_factor_required");
    expect(codeOf(() => requirePermission({ ...needsIt, assuranceLevel: "aal2" }, "booking.view.scope"))).toBeNull();
  });
});
