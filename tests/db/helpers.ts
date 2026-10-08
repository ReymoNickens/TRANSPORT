import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { createSql } from "@/lib/db";

export type Sql = postgres.Sql;

/** Connects as the owner (superuser in tests), which bypasses row-level security. */
export function connectAsOwner(): Sql {
  return postgres(inject("testDatabaseUrl"), { max: 4, onnotice: () => {} });
}

/** Connects the way the app does (camelCase rows, numeric pesewas), still as the owner. */
export function connectAsApp(): Sql {
  return createSql(inject("testDatabaseUrl"), { max: 4 });
}

export async function createOrganisation(sql: Sql, slug = `org-${randomUUID().slice(0, 8)}`) {
  const [row] = await sql<{ id: string }[]>`select app.create_organisation(${`Org ${slug}`}, ${slug}) as id`;
  return row.id;
}

export async function createAuthUser(sql: Sql, phone?: string) {
  const [row] = await sql<{ id: string }[]>`insert into auth.users (phone) values (${phone ?? null}) returning id`;
  return row.id;
}

export async function createStaff(sql: Sql, organisationId: string, roleName: string) {
  const authUserId = await createAuthUser(sql);
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organisation_id', ${organisationId}, true)`;
    const [user] = await tx<{ id: string }[]>`
      insert into app.users (organisation_id, auth_user_id, kind, full_name, email)
      values (${organisationId}, ${authUserId}, 'staff', 'Test Staff', ${`${authUserId}@example.com`})
      returning id`;
    await tx`
      insert into app.user_roles (organisation_id, user_id, role_id, scope_type)
      select ${organisationId}, ${user.id}, id, 'organisation' from app.roles
      where organisation_id = ${organisationId} and name = ${roleName}`;
    return { userId: user.id, authUserId };
  });
}

export function randomGhanaPhone() {
  return `+23324${Math.floor(1000000 + Math.random() * 8999999)}`;
}
