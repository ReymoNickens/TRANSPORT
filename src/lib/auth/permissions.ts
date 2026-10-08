import { AppError } from "@/lib/api/errors";

export type ScopeType = "organisation" | "station" | "journey";

export type Grant = {
  code: string;
  scopeType: ScopeType;
  /** Null for organisation scope. */
  scopeId: string | null;
  highRisk: boolean;
};

export type Actor = {
  userId: string;
  organisationId: string;
  kind: "passenger" | "staff";
  grants: Grant[];
  /** True when any role this person holds requires a second factor (spec 19.2). */
  secondFactorRequired: boolean;
  /** The session's assurance level from Supabase Auth: aal2 means a second factor was used. */
  assuranceLevel: "aal1" | "aal2";
  /** When the second factor was last entered in this session; null if never. */
  secondFactorAt: Date | null;
};

/** High-risk actions need the second factor entered within this window (spec 5, 19.2). */
export const RECONFIRM_WINDOW_MS = 5 * 60 * 1000;

/**
 * High-risk permissions need a fresh confirmation at the moment of use and a
 * reason, which is written to the audit log (spec 5).
 */
export function requireFreshConfirmation(actor: Actor, reason: string | undefined, now = new Date()): string {
  const trimmed = reason?.trim();
  if (!trimmed || trimmed.length < 5) {
    throw new AppError("validation_failed", { message: "Give a reason for this action (at least 5 characters)." });
  }
  if (!actor.secondFactorAt || now.getTime() - actor.secondFactorAt.getTime() > RECONFIRM_WINDOW_MS) {
    throw new AppError("reconfirmation_required");
  }
  return trimmed;
}

export type ScopeRef = { type: "station" | "journey"; id: string };

/** Does the actor hold the permission, for this scope if one is given? */
export function hasPermission(actor: Actor, code: string, scope?: ScopeRef): boolean {
  return actor.grants.some(
    (grant) =>
      grant.code === code &&
      (grant.scopeType === "organisation" || (scope !== undefined && grant.scopeType === scope.type && grant.scopeId === scope.id)),
  );
}

/**
 * Server-side permission check (spec 5, 19.3). Code checks a permission,
 * never a role name. Throws a stable error code when refused.
 */
export function requirePermission(actor: Actor, code: string, scope?: ScopeRef): void {
  if (actor.secondFactorRequired && actor.assuranceLevel !== "aal2") {
    throw new AppError("second_factor_required");
  }
  if (!hasPermission(actor, code, scope)) {
    throw new AppError("forbidden");
  }
}

export function isHighRisk(actor: Actor, code: string): boolean {
  return actor.grants.some((grant) => grant.code === code && grant.highRisk);
}
