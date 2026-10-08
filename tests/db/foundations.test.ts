import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOrganisation } from "@/lib/db";
import { loadActor } from "@/lib/auth/actor";
import { connectAsOwner, createAuthUser, createOrganisation, createStaff, randomGhanaPhone, type Sql } from "./helpers";

let sql: Sql;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  sql = connectAsOwner();
  orgA = await createOrganisation(sql);
  orgB = await createOrganisation(sql);
});

afterAll(async () => {
  await sql.end();
});

describe("creating an organisation", () => {
  it("seeds every setting and the default roles of spec section 5", async () => {
    const [{ settings }] = await sql`select count(*)::int as settings from app.settings where organisation_id = ${orgA}`;
    const [{ definitions }] = await sql`select count(*)::int as definitions from app.setting_definitions`;
    expect(settings).toBe(definitions);

    const roles = await sql<{ name: string; requires_second_factor: boolean }[]>`
      select name, requires_second_factor from app.roles where organisation_id = ${orgA} order by name`;
    expect(roles.map((r) => r.name)).toEqual([
      "Administrator", "Conductor", "Driver", "Finance", "Operations Manager", "Passenger", "Station Agent", "Support",
    ]);
    expect(roles.filter((r) => r.requires_second_factor).map((r) => r.name)).toEqual([
      "Administrator", "Finance", "Operations Manager",
    ]);

    const financePermissions = await sql`
      select rp.permission_code from app.role_permissions rp join app.roles r on r.id = rp.role_id
      where r.organisation_id = ${orgA} and r.name = 'Finance'`;
    expect(financePermissions.map((p) => p.permission_code)).toContain("refund.approve");
  });
});

describe("organisation boundary (spec 11.8 #13)", () => {
  it("shows a request only its own organisation's rows", async () => {
    await createStaff(sql, orgA, "Support");
    await createStaff(sql, orgB, "Support");

    const seen = await withOrganisation({ organisationId: orgA }, (tx) => tx`select distinct organisation_id from app.users`, sql);
    expect(seen.map((r) => r.organisation_id)).toEqual([orgA]);

    const orgs = await withOrganisation({ organisationId: orgA }, (tx) => tx`select id from app.organisations`, sql);
    expect(orgs.map((r) => r.id)).toEqual([orgA]);
  });

  it("shows nothing when the organisation was not set", async () => {
    const rows = await sql.begin(async (tx) => {
      await tx`set local role app_runtime`;
      return tx`select count(*)::int as n from app.users`;
    });
    expect(rows[0].n).toBe(0);
  });

  it("lets the runtime role find an organisation by slug, and nothing more, before the organisation is set", async () => {
    const [{ slug }] = await sql`select slug from app.organisations where id = ${orgA}`;
    const rows = await sql.begin(async (tx) => {
      await tx`set local role app_runtime`;
      return tx`select * from app.organisation_by_slug(${slug})`;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orgA);
    expect(Object.keys(rows[0]).sort()).toEqual(["currency", "id", "name", "slug", "timezone"]);
  });

  it("refuses to write a row into another organisation", async () => {
    const authUserId = await createAuthUser(sql);
    await expect(
      withOrganisation({ organisationId: orgA }, (tx) =>
        tx`insert into app.users (organisation_id, auth_user_id, kind) values (${orgB}, ${authUserId}, 'staff')`, sql),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a reference to another organisation's row, even for the owner", async () => {
    const staffA = await createStaff(sql, orgA, "Support");
    const [roleB] = await sql`select id from app.roles where organisation_id = ${orgB} limit 1`;
    await expect(
      sql`insert into app.user_roles (organisation_id, user_id, role_id, scope_type)
          values (${orgA}, ${staffA.userId}, ${roleB.id}, 'organisation')`,
    ).rejects.toThrow(/foreign key/);
  });

  it("gives Supabase's public API roles no access at all", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          return tx`select * from app.users`;
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe("audit log (spec 10.9, 19.8)", () => {
  it("cannot be updated, deleted or truncated, even by the owner", async () => {
    await expect(sql`update app.audit_logs set reason = 'tampered'`).rejects.toThrow(/append-only/);
    await expect(sql`delete from app.audit_logs`).rejects.toThrow(/append-only/);
    await expect(sql`truncate app.audit_logs`).rejects.toThrow(/append-only/);
  });

  it("records a settings change with the actor, reason and correlation id", async () => {
    const admin = await createStaff(sql, orgA, "Administrator");
    await withOrganisation(
      { organisationId: orgA, actorUserId: admin.userId, reason: "Pilot feedback", correlationId: "test-corr-1" },
      (tx) => tx`update app.settings set value = '15' where key = 'hold.minutes'`,
      sql,
    );
    const [entry] = await sql`
      select actor_type, actor_user_id, reason, correlation_id, before ->> 'value' as before, after ->> 'value' as after
      from app.audit_logs where organisation_id = ${orgA} and action = 'settings.update' and entity_id = 'hold.minutes'`;
    expect(entry).toMatchObject({
      actor_type: "user", actor_user_id: admin.userId, reason: "Pilot feedback", correlation_id: "test-corr-1", before: "10", after: "15",
    });
    const [setting] = await sql`select changed_by from app.settings where organisation_id = ${orgA} and key = 'hold.minutes'`;
    expect(setting.changed_by).toBe(admin.userId);
  });

  it("masks phone numbers and names in audit values", async () => {
    const phone = randomGhanaPhone();
    const authUserId = await createAuthUser(sql, phone);
    await withOrganisation({ organisationId: orgA }, (tx) => tx`select app.ensure_passenger(${authUserId}, ${phone})`, sql);
    const [entry] = await sql`
      select after ->> 'phone' as phone from app.audit_logs
      where action = 'users.insert' and after ->> 'auth_user_id' = ${authUserId}`;
    expect(entry.phone).not.toBe(phone);
    expect(entry.phone.endsWith(phone.slice(-2))).toBe(true);
  });
});

describe("settings", () => {
  it("refuses a value of the wrong type", async () => {
    await expect(
      withOrganisation({ organisationId: orgA }, (tx) => tx`update app.settings set value = '"ten"' where key = 'hold.minutes'`, sql),
    ).rejects.toThrow(/must be a number/);
  });

  it("are never deleted", async () => {
    await expect(sql`delete from app.settings where organisation_id = ${orgA}`).rejects.toThrow(/never deleted/);
  });
});

describe("people", () => {
  it("are deactivated, never deleted", async () => {
    const staff = await createStaff(sql, orgA, "Support");
    await expect(sql`delete from app.users where id = ${staff.userId}`).rejects.toThrow(/never deleted/);
  });

  it("a deactivated person holds no permissions", async () => {
    const staff = await createStaff(sql, orgA, "Support");
    await sql`update app.users set status = 'deactivated', deactivated_at = now() where id = ${staff.userId}`;
    const rows = await withOrganisation({ organisationId: orgA }, (tx) => tx`select * from app.user_permissions(${staff.userId})`, sql);
    expect(rows).toHaveLength(0);
  });
});

describe("passenger sign-in (loadActor)", () => {
  it("creates the passenger once, with the Passenger role", async () => {
    const phone = randomGhanaPhone();
    const authUserId = await createAuthUser(sql, phone);
    const identity = { authUserId, phone, assuranceLevel: "aal1" as const };

    const first = await withOrganisation({ organisationId: orgA }, (tx) => loadActor(tx, orgA, identity), sql);
    const second = await withOrganisation({ organisationId: orgA }, (tx) => loadActor(tx, orgA, identity), sql);

    expect(first?.userId).toBe(second?.userId);
    expect(first?.kind).toBe("passenger");
    expect(first?.secondFactorRequired).toBe(false);
    expect(first?.grants.map((g) => g.code).sort()).toEqual(["booking.create.own", "booking.view.own"]);
  });

  it("does not create a staff record from a sign-in", async () => {
    const authUserId = await createAuthUser(sql);
    const actor = await withOrganisation(
      { organisationId: orgA },
      (tx) => loadActor(tx, orgA, { authUserId, phone: null, assuranceLevel: "aal1" }),
      sql,
    );
    expect(actor).toBeNull();
  });

  it("marks staff whose role needs a second factor", async () => {
    const finance = await createStaff(sql, orgA, "Finance");
    const actor = await withOrganisation(
      { organisationId: orgA },
      (tx) => loadActor(tx, orgA, { authUserId: finance.authUserId, phone: null, assuranceLevel: "aal1" }),
      sql,
    );
    expect(actor?.secondFactorRequired).toBe(true);
    expect(actor?.grants.find((g) => g.code === "refund.approve")?.highRisk).toBe(true);
  });
});

describe("conventions", () => {
  it("makes time-ordered ids", async () => {
    const rows = await sql`select app.uuid_v7()::text as id from generate_series(1, 50)`;
    const ids = rows.map((r) => r.id as string);
    expect(new Set(ids).size).toBe(50);
    expect(ids.every((id) => id[14] === "7")).toBe(true);
    const prefixes = ids.map((id) => id.slice(0, 13));
    expect([...prefixes].sort()).toEqual(prefixes);
  });
});
