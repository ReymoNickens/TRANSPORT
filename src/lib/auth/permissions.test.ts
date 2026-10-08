import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/errors";
import { hasPermission, requireFreshConfirmation, requirePermission, RECONFIRM_WINDOW_MS, type Actor } from "./permissions";
import { lastSecondFactor } from "./actor";

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
    secondFactorAt: null,
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

describe("high-risk confirmation (spec 5)", () => {
  const now = new Date("2026-10-08T10:00:00Z");

  it("needs a reason", () => {
    expect(codeOf(() => requireFreshConfirmation(actor({ secondFactorAt: now }), undefined, now))).toBe("validation_failed");
    expect(codeOf(() => requireFreshConfirmation(actor({ secondFactorAt: now }), "  no ", now))).toBe("validation_failed");
  });

  it("needs the second factor entered within the last few minutes", () => {
    const stale = new Date(now.getTime() - RECONFIRM_WINDOW_MS - 1000);
    expect(codeOf(() => requireFreshConfirmation(actor({ secondFactorAt: stale }), "Bus broke down", now))).toBe("reconfirmation_required");
    expect(codeOf(() => requireFreshConfirmation(actor({ secondFactorAt: null }), "Bus broke down", now))).toBe("reconfirmation_required");
    expect(requireFreshConfirmation(actor({ secondFactorAt: new Date(now.getTime() - 60_000) }), " Bus broke down ", now)).toBe("Bus broke down");
  });

  it("reads the latest authenticator entry from the token", () => {
    expect(lastSecondFactor([{ method: "password", timestamp: 100 }, { method: "totp", timestamp: 200 }, { method: "totp", timestamp: 150 }]))
      .toEqual(new Date(200_000));
    expect(lastSecondFactor([{ method: "password", timestamp: 100 }])).toBeNull();
    expect(lastSecondFactor(undefined)).toBeNull();
  });
});
