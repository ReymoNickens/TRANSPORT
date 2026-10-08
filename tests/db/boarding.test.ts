import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { createSql, type Tx } from "@/lib/db";
import { idempotent } from "@/lib/api/idempotency";
import type { Actor } from "@/lib/auth/permissions";
import { createConcession } from "@/server/fares";
import { assignStaff, createOneOffJourney } from "@/server/journeys";
import {
  boardManually,
  boardWithOverride,
  closePaperManifest,
  enterPaperBoardings,
  exportPaperManifest,
  getManifest,
  listStaffJourneys,
  lookupPassengers,
  requireJourneyAccess,
  scanTicket,
  updateJourneyStatus,
  type BoardingResult,
} from "@/server/boarding";
import { as, daysFromToday, liveCorridor, type Operator } from "./fixtures";
import { staff, trips, type Ticket, type Trip } from "./trips";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";

const TICKET_SECRET = process.env.TICKET_TOKEN_SECRET!;
let owner: Sql;
let wide: Sql;
let op: Operator;
let conductor: Operator;
let outsider: Operator;

let trip: Trip;
let otherTrip: Trip;
let studentId: string;
/** Bookings are made while the journey is on sale, before boarding starts. */
let booked: Record<string, Ticket[]>;
let newTrip: ReturnType<typeof trips>["newTrip"];
let bookAndPay: ReturnType<typeof trips>["bookAndPay"];

const scan = (token: string, confirm: boolean, t = trip, sql?: Sql) => staff(conductor, (tx) => scanTicket(tx, t.journeyId, { token, confirm }), { sql });

async function ticketState(id: string) {
  const [row] = await owner`select t.state, s.state as seat_state from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id where t.id = ${id}`;
  return { ticket: row.state as string, seat: row.seat_state as string };
}

async function refusalsFor(ticketId: string | null) {
  const [row] = await owner`select count(*)::int as n from app.audit_logs where action = 'ticket.board_refused' and entity_id is not distinct from ${ticketId}`;
  return row.n as number;
}

function actorFor(who: Operator, codes: string[]): Actor {
  return {
    userId: who.actorUserId,
    organisationId: who.organisationId,
    kind: "staff",
    grants: codes.map((code) => ({ code, scopeType: "organisation", scopeId: null, highRisk: false })),
    secondFactorRequired: false,
    assuranceLevel: "aal1",
    secondFactorAt: null,
  };
}

beforeAll(async () => {
  owner = connectAsOwner();
  wide = createSql(inject("testDatabaseUrl"), { max: 20 });
  const app = connectAsApp();
  const org = await createOrganisation(owner);
  op = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Operations Manager")).userId };
  conductor = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Conductor")).userId };
  outsider = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Conductor")).userId };
  ({ newTrip, bookAndPay } = trips(op, owner, "20"));
  await owner`update app.users set full_name = 'Kofi Boateng' where id = ${conductor.actorUserId}`;
  // Tests run a day ahead of departure, so boarding opens early for this organisation.
  await owner`update app.settings set value = '3000' where organisation_id = ${org} and key = 'boarding.opens_minutes_before'`;
  await owner`update app.settings set value = '72' where organisation_id = ${org} and key = 'boarding.manifest_export_hours'`;

  trip = await newTrip("bd", "GR-7100-26");
  otherTrip = await newTrip("bd2", "GR-7101-26");
  await as(op, (tx: Tx) => assignStaff(tx, trip.journeyId, { userId: conductor.actorUserId, staffRole: "conductor" }));
  const concession = await as(op, (tx: Tx) =>
    createConcession(tx, op.actorUserId, { name: "Student", code: "student", discountKind: "percent", discountBasisPoints: 1_000, requiresReference: true, checkAtBoarding: true }),
  );
  studentId = concession.id;

  booked = {};
  for (const [key, seats, options] of [
    ["first", ["1A", "1B"], {}],
    ["elsewhere", null, {}],
    ["student", ["3A"], { concession: "student" }],
    ["reversed", ["4A"], {}],
    ["cancelled", ["5A"], {}],
    ["race", ["6A"], {}],
    ["retry", ["7A"], {}],
    ["direct", ["8A"], {}],
    ["lookup", ["9A", "9B"], { name: "Yaw Asante" }],
  ] as const) {
    booked[key] = key === "elsewhere" ? await bookAndPay(otherTrip, ["2A"]) : await bookAndPay(trip, [...seats!], options);
  }
});

afterAll(async () => {
  await owner.end();
  await wide.end();
  await op.app.end();
});

describe("access", () => {
  it("only the crew, or staff with organisation-wide lookup, see a journey's passengers", async () => {
    await staff(conductor, (tx) => requireJourneyAccess(tx, actorFor(conductor, ["ticket.scan"]), trip.journeyId));
    await expect(staff(outsider, (tx) => requireJourneyAccess(tx, actorFor(outsider, ["ticket.scan"]), trip.journeyId))).rejects.toMatchObject({ code: "forbidden" });
    await staff(op, (tx) => requireJourneyAccess(tx, actorFor(op, ["booking.view.scope"]), trip.journeyId));

    const mine = await staff(conductor, (tx) => listStaffJourneys(tx, actorFor(conductor, ["ticket.scan"])));
    expect(mine.map((j) => j.id)).toEqual([trip.journeyId]);
    expect(mine[0].crewRole).toBe("conductor");
  });
});

describe("scanning (14.3, 14.3a)", () => {
  let tickets: Ticket[];
  beforeAll(() => {
    tickets = booked.first;
  });

  it("refuses before boarding opens, and records the refusal", async () => {
    const result = await scan(tickets[0].qr, true);
    expect(result).toMatchObject({ outcome: "refused", code: "not_open", message: "Boarding has not opened." });
    expect(await refusalsFor(tickets[0].id)).toBe(1);
    expect((await ticketState(tickets[0].id)).ticket).toBe("VALID");
  });

  it("boarding starts from the bus", async () => {
    const result = await staff(conductor, (tx) => updateJourneyStatus(tx, trip.journeyId, { to: "BOARDING" }));
    expect(result.state).toBe("BOARDING");
    await expect(staff(conductor, (tx) => updateJourneyStatus(tx, trip.journeyId, { to: "BOARDING" }))).rejects.toThrow(/already started/);
    await expect(staff(conductor, (tx) => updateJourneyStatus(tx, otherTrip.journeyId, { to: "COMPLETED" }))).rejects.toThrow(/Record departure/);
  });

  it("a scan shows the passenger first, and boards only on confirm", async () => {
    const check = await scan(tickets[0].qr, false);
    expect(check.outcome).toBe("ok");
    expect(check.ticket).toMatchObject({ ticketNumber: tickets[0].ticketNumber, passengerName: "Passenger 1A", seatNumber: "1A", fareType: "Standard", checkStudentId: false });
    expect((await ticketState(tickets[0].id)).ticket).toBe("VALID");

    const boarded = await scan(tickets[0].qr, true);
    expect(boarded.outcome).toBe("boarded");
    expect(await ticketState(tickets[0].id)).toEqual({ ticket: "BOARDED", seat: "BOARDED" });
    const [record] = await owner`select method, boarded_by, device from app.boarding_records where ticket_id = ${tickets[0].id}`;
    expect(record).toMatchObject({ method: "scan", boarded_by: conductor.actorUserId, device: "test-device" });
  });

  it("a second scan is refused with when and by whom", async () => {
    const again = await scan(tickets[0].qr, true);
    expect(again.outcome).toBe("refused");
    expect(again.code).toBe("already_boarded");
    expect(again.message).toMatch(/^Already boarded at \d\d:\d\d by Kofi\.$/);
    expect(again.ticket?.seatNumber).toBe("1A");
    const [row] = await owner`select count(*)::int as n from app.boarding_records where ticket_id = ${tickets[0].id}`;
    expect(row.n).toBe(1);
  });

  it("an unknown token is not valid, and is recorded", async () => {
    const before = await refusalsFor(null);
    const result = await scan("not-a-real-token-0123456789", true);
    expect(result).toMatchObject({ outcome: "refused", code: "invalid", message: "This ticket is not valid.", ticket: null });
    expect(await refusalsFor(null)).toBe(before + 1);
  });

  it("a ticket for another journey says which journey", async () => {
    const [elsewhere] = booked.elsewhere;
    const result = await scan(elsewhere.qr, true);
    expect(result.code).toBe("wrong_journey");
    expect(result.message).toMatch(/^This ticket is for a different journey: Corridor bd2, \d\d \w{3} 08:00\.$/);
    expect(result.ticket).toBeNull();
  });

  it("a revoked credential is not valid", async () => {
    await owner`update app.ticket_credentials set revoked_at = now(), revoke_reason = 'test rotation' where ticket_id = ${tickets[1].id} and revoked_at is null`;
    expect((await scan(tickets[1].qr, false)).code).toBe("invalid");
  });

  it("a student fare asks for the student ID", async () => {
    const [student] = booked.student;
    const result = await scan(student.qr, false);
    expect(result.ticket).toMatchObject({ fareType: "Student", checkStudentId: true });
    expect(studentId).toBeTruthy();
  });

  it("a reversed payment sends the passenger to the desk", async () => {
    const [ticket] = booked.reversed;
    await owner`update app.payments set state = 'REVERSED' where booking_id = ${ticket.bookingId}`;
    const result = await scan(ticket.qr, true);
    expect(result).toMatchObject({ outcome: "refused", code: "payment_attention" });
    expect((await ticketState(ticket.id)).ticket).toBe("VALID");

    // A manager may board against the failed check, with a reason (14.4).
    await expect(staff(op, (tx) => boardWithOverride(tx, trip.journeyId, { ticketId: ticket.id, reason: "x" }))).rejects.toThrow(/reason/);
    const override = await staff(op, (tx) => boardWithOverride(tx, trip.journeyId, { ticketId: ticket.id, reason: "Paid cash at the desk, receipt 0042" }), {
      reason: "Paid cash at the desk, receipt 0042",
    });
    expect(override.outcome).toBe("boarded");
    const [record] = await owner`select method, reason from app.boarding_records where ticket_id = ${ticket.id}`;
    expect(record).toMatchObject({ method: "override", reason: "Paid cash at the desk, receipt 0042" });
  });

  it("a cancelled ticket is refused", async () => {
    const [ticket] = booked.cancelled;
    await owner`update app.tickets set state = 'CANCELLED' where id = ${ticket.id}`;
    expect(await scan(ticket.qr, true)).toMatchObject({ outcome: "refused", code: "ticket_cancelled", message: "This ticket was cancelled." });
  });

  it("simultaneous boarding: 20 confirmations give one boarding and 19 duplicate refusals", async () => {
    const [ticket] = booked.race;
    const results = await Promise.all(Array.from({ length: 20 }, () => scan(ticket.qr, true, trip, wide)));
    expect(results.filter((r) => r.outcome === "boarded")).toHaveLength(1);
    const refused = results.filter((r) => r.outcome === "refused");
    expect(refused).toHaveLength(19);
    expect(refused.every((r) => r.code === "already_boarded")).toBe(true);
    const [row] = await owner`select count(*)::int as n from app.boarding_records where ticket_id = ${ticket.id}`;
    expect(row.n).toBe(1);
    expect(await refusalsFor(ticket.id)).toBe(19);
    expect((await ticketState(ticket.id)).ticket).toBe("BOARDED");
  });

  it("a lost reply retried with the same idempotency key returns the original result", async () => {
    const [ticket] = booked.retry;
    const confirm = () =>
      staff(conductor, async (tx) =>
        (await idempotent(tx, { organisationId: op.organisationId, operation: "board_ticket", key: "retry-key-0001", request: { token: ticket.qr } }, () =>
          scanTicket(tx, trip.journeyId, { token: ticket.qr, confirm: true }),
        )).result,
      );
    const first: BoardingResult = await confirm();
    const second: BoardingResult = await confirm();
    expect(first.outcome).toBe("boarded");
    expect(second).toEqual(first);
  });
});

describe("boarding records are evidence", () => {
  it("cannot be changed or removed, even by the owner", async () => {
    const [row] = await owner`select id from app.boarding_records limit 1`;
    await expect(owner`update app.boarding_records set method = 'manual' where id = ${row.id}`).rejects.toThrow();
    await expect(owner`delete from app.boarding_records where id = ${row.id}`).rejects.toThrow();
  });

  it("a ticket is never marked boarded except by the boarding function", async () => {
    const [ticket] = booked.direct;
    await expect(owner`update app.tickets set state = 'BOARDED' where id = ${ticket.id}`).rejects.toThrow(/boarding function/);
  });

  it("the database allows one boarding record per ticket", async () => {
    const [row] = await owner`select * from app.boarding_records limit 1`;
    await expect(owner`
      insert into app.boarding_records (organisation_id, ticket_id, journey_id, booked_seat_id, boarded_by, boarding_location_id, method)
      values (${row.organisation_id}, ${row.ticket_id}, ${row.journey_id}, ${row.booked_seat_id}, ${row.boarded_by}, ${row.boarding_location_id}, 'manual')`).rejects.toThrow(/unique|duplicate/);
  });
});

describe("manual lookup (14.4)", () => {
  let tickets: Ticket[];
  beforeAll(() => {
    tickets = booked.lookup;
  });
  const find = (q: string) => staff(conductor, (tx) => lookupPassengers(tx, TICKET_SECRET, trip.journeyId, q));

  it("finds by reference, ticket number, boarding code, phone and name", async () => {
    expect((await find(tickets[0].reference)).map((r) => r.ticketId).sort()).toEqual(tickets.map((t) => t.id).sort());
    expect((await find(tickets[0].ticketNumber)).map((r) => r.ticketId)).toEqual([tickets[0].id]);
    expect((await find(tickets[1].code.toLowerCase())).map((r) => r.ticketId)).toEqual([tickets[1].id]);
    expect((await find(`0${tickets[0].phone.slice(4)}`)).length).toBe(2);
    expect((await find("yaw asa")).length).toBe(2);
    expect(await find("nobody here")).toEqual([]);
  });

  it("boards by manual lookup with the method recorded", async () => {
    const check = await staff(conductor, (tx) => boardManually(tx, trip.journeyId, { ticketId: tickets[0].id, confirm: false }));
    expect(check.outcome).toBe("ok");
    const done = await staff(conductor, (tx) => boardManually(tx, trip.journeyId, { ticketId: tickets[0].id, confirm: true }));
    expect(done.outcome).toBe("boarded");
    const [record] = await owner`select method from app.boarding_records where ticket_id = ${tickets[0].id}`;
    expect(record.method).toBe("manual");
  });

  it("the manifest lists seats with boarding status", async () => {
    const manifest = await staff(conductor, (tx) => getManifest(tx, trip.journeyId));
    const row = manifest.rows.find((r) => r.ticketId === tickets[0].id)!;
    expect(row).toMatchObject({ state: "BOARDED", boardedBy: "Kofi", method: "manual", paymentConfirmed: true, passengerName: "Yaw Asante" });
    expect(manifest.rows.find((r) => r.ticketId === tickets[1].id)?.state).toBe("VALID");
  });
});

describe("paper manifest with no signal (14.7, D28)", () => {
  it("is numbered, carries boarding codes, and is entered after the trip", async () => {
    const t = await newTrip("bd3", "GR-7102-26", "14:00");
    await as(op, (tx: Tx) => assignStaff(tx, t.journeyId, { userId: conductor.actorUserId, staffRole: "conductor" }));
    const [a, b] = await bookAndPay(t, ["1A", "1B"]);
    const [c] = await bookAndPay(t, ["2A"]);

    const sheet = await staff(conductor, (tx) => exportPaperManifest(tx, TICKET_SECRET, t.journeyId));
    const second = await staff(conductor, (tx) => exportPaperManifest(tx, TICKET_SECRET, t.journeyId));
    expect(second.sheetNumber).toBe(sheet.sheetNumber + 1);
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows.find((r) => r.ticketId === a.id)?.boardingCode).toBe(a.code);
    const [audit] = await owner`select count(*)::int as n from app.audit_logs where entity_type = 'manifest_exports' and entity_id = ${sheet.exportId}`;
    expect(audit.n).toBe(1);

    // Paper boardings are entered once boarding has started.
    const early = await staff(conductor, (tx) => enterPaperBoardings(tx, t.journeyId, sheet.exportId, { entries: [{ ticketId: a.id, boardedAt: new Date().toISOString() }] }));
    expect(early.results[0].code).toBe("not_open");

    await staff(conductor, (tx) => updateJourneyStatus(tx, t.journeyId, { to: "BOARDING" }));
    await staff(conductor, (tx) => scanTicket(tx, t.journeyId, { token: b.qr, confirm: true }));
    await staff(conductor, (tx) => updateJourneyStatus(tx, t.journeyId, { to: "DEPARTED" }));
    // Online scanning stops once the bus has left.
    expect((await staff(conductor, (tx) => scanTicket(tx, t.journeyId, { token: a.qr, confirm: false }))).code).toBe("journey_left");

    // Ticket c is cancelled after the sheet was printed.
    await owner`update app.tickets set state = 'CANCELLED' where id = ${c.id}`;
    const ticked = "2026-10-08T06:12:00Z";
    const entered = await staff(conductor, (tx) =>
      enterPaperBoardings(tx, t.journeyId, sheet.exportId, {
        entries: [
          { ticketId: a.id, boardedAt: ticked },
          { ticketId: b.id, boardedAt: ticked },
          { ticketId: c.id, boardedAt: ticked },
        ],
      }),
    );
    expect(entered.boarded).toBe(1);
    expect(entered.results.map((r) => r.code)).toEqual([null, "already_boarded", "cancelled_after_export"]);
    const [record] = await owner`select method, device_recorded_at, manifest_export_id from app.boarding_records where ticket_id = ${a.id}`;
    expect(record).toMatchObject({ method: "manual_offline", manifest_export_id: sheet.exportId });
    expect(new Date(record.device_recorded_at).toISOString()).toBe("2026-10-08T06:12:00.000Z");
    const [flag] = await owner`select count(*)::int as n from app.exceptions where dedupe_key = ${`boarded_after_cancellation:${c.id}`}`;
    expect(flag.n).toBe(1);

    // Entering the same sheet again changes nothing and raises nothing new.
    const repeat = await staff(conductor, (tx) =>
      enterPaperBoardings(tx, t.journeyId, sheet.exportId, { entries: [{ ticketId: a.id, boardedAt: ticked }, { ticketId: c.id, boardedAt: ticked }] }),
    );
    expect(repeat.boarded).toBe(0);
    const [flags] = await owner`select count(*)::int as n from app.exceptions where dedupe_key = ${`boarded_after_cancellation:${c.id}`}`;
    expect(flags.n).toBe(1);

    let manifest = await staff(conductor, (tx) => getManifest(tx, t.journeyId));
    expect(manifest.openSheets).toHaveLength(2);
    await staff(conductor, (tx) => closePaperManifest(tx, t.journeyId, sheet.exportId));
    await expect(staff(conductor, (tx) => closePaperManifest(tx, t.journeyId, sheet.exportId))).rejects.toThrow(/already been marked/);
    manifest = await staff(conductor, (tx) => getManifest(tx, t.journeyId));
    expect(manifest.openSheets.map((s) => s.id)).toEqual([second.exportId]);

    await staff(conductor, (tx) => updateJourneyStatus(tx, t.journeyId, { to: "COMPLETED" }));
  });

  it("is refused for a journey that is not on sale", async () => {
    const corridor = await liveCorridor(op, "bd4");
    const journey = await as(op, (tx: Tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(5)}T08:00:00Z` }));
    await expect(staff(op, (tx) => exportPaperManifest(tx, TICKET_SECRET, journey.id))).rejects.toThrow(/on sale or boarding/);
  });
});
