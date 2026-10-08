import "server-only";
import { AppError } from "@/lib/api/errors";
import { withOrganisation, type Tx } from "@/lib/db";
import { currentOrganisation } from "@/lib/organisation";
import type { Actor, Grant } from "./permissions";
import { supabaseServer } from "./supabase";

type Identity = {
  authUserId: string;
  phone: string | null;
  assuranceLevel: "aal1" | "aal2";
  /** When an authenticator-app code was last entered; null if never in this session. */
  secondFactorAt?: Date | null;
};

/** The verified identity from the Supabase session, or null when signed out. */
export async function currentIdentity(): Promise<Identity | null> {
  const supabase = await supabaseServer();
  // getClaims verifies the token's signature; never trust an unverified session.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const claims = data.claims;
  return {
    authUserId: claims.sub,
    // Supabase stores phone numbers without the leading +.
    phone: claims.phone ? `+${String(claims.phone).replace(/^\+/, "")}` : null,
    assuranceLevel: claims.aal === "aal2" ? "aal2" : "aal1",
    secondFactorAt: lastSecondFactor(claims.amr),
  };
}

/** The most recent authenticator-app entry in the token's authentication methods. */
export function lastSecondFactor(amr: unknown): Date | null {
  if (!Array.isArray(amr)) return null;
  const times = amr
    .filter((entry): entry is { method: string; timestamp: number } =>
      typeof entry === "object" && entry !== null && (entry as { method?: unknown }).method === "totp")
    .map((entry) => entry.timestamp)
    .filter((t) => typeof t === "number");
  return times.length ? new Date(Math.max(...times) * 1000) : null;
}

/**
 * The signed-in person with their permissions. A first-time passenger
 * (phone sign-in) gets a passenger record and the Passenger role. Staff
 * records are only made by invitation, never here.
 */
export async function currentActor(context: { correlationId?: string } = {}): Promise<Actor | null> {
  const identity = await currentIdentity();
  if (!identity) return null;
  const organisation = await currentOrganisation();
  return withOrganisation({ organisationId: organisation.id, correlationId: context.correlationId }, (tx) =>
    loadActor(tx, organisation.id, identity),
  );
}

export async function requireActor(context: { correlationId?: string } = {}): Promise<Actor> {
  const actor = await currentActor(context);
  if (!actor) throw new AppError("unauthenticated");
  return actor;
}

export async function loadActor(tx: Tx, organisationId: string, identity: Identity): Promise<Actor | null> {
  let [user] = await tx<{ id: string; kind: "passenger" | "staff"; status: string }[]>`
    select id, kind, status from app.users where auth_user_id = ${identity.authUserId}
  `;
  if (!user && identity.phone) {
    const [created] = await tx<{ id: string }[]>`select app.ensure_passenger(${identity.authUserId}, ${identity.phone}) as id`;
    user = { id: created.id, kind: "passenger", status: "active" };
  }
  if (!user || user.status !== "active") return null;

  const rows = await tx<
    { permissionCode: string; scopeType: Grant["scopeType"]; scopeId: string | null; highRisk: boolean; requiresSecondFactor: boolean }[]
  >`select * from app.user_permissions(${user.id})`;

  return {
    userId: user.id,
    organisationId,
    kind: user.kind,
    grants: rows.map((row) => ({
      code: row.permissionCode,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      highRisk: row.highRisk,
    })),
    secondFactorRequired: rows.some((row) => row.requiresSecondFactor),
    assuranceLevel: identity.assuranceLevel,
    secondFactorAt: identity.secondFactorAt ?? null,
  };
}
