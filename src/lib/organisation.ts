import "server-only";
import { AppError } from "@/lib/api/errors";
import { db, type Sql } from "@/lib/db";
import { env } from "@/lib/env";

export type Organisation = { id: string; name: string; slug: string; timezone: string; currency: string };

let cached: { slug: string; organisation: Organisation } | undefined;

/**
 * The organisation this deployment serves. Release 1 runs one organisation,
 * chosen by ORGANISATION_SLUG. This lookup runs before row-level security
 * can apply, because it is what decides the organisation.
 */
export async function currentOrganisation(sql: Sql = db(), slug = env().ORGANISATION_SLUG): Promise<Organisation> {
  if (cached?.slug === slug) return cached.organisation;
  const [row] = await sql<Organisation[]>`
    select id, name, slug, timezone, currency
    from app.organisations
    where slug = ${slug} and status = 'active'
  `;
  if (!row) throw new AppError("organisation_unavailable");
  cached = { slug, organisation: row };
  return row;
}
