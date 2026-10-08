import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@/lib/db";
import { assignVehicle, createOneOffJourney } from "@/server/journeys";
import { boardWithOverride, closePaperManifest, exportPaperManifest, updateJourneyStatus } from "@/server/boarding";
import {
  dismissException,
  getDashboard,
  listAttention,
  lookupBookings,
  resolveException,
  startException,
  takeException,
} from "@/server/operations";
import { as, coach, liveCorridor, type Operator } from "./fixtures";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";
import { staff, trips, type Trip } from "./trips";

let owner: Sql;
let op: Operator;
let support: Operator;
let helpers: ReturnType<typeof trips>;

/** A draft journey with no bus, departing `hours` from now. */
async function busless(suffix: string, hours: number) {
  const corridor = await liveCorridor(op, suffix);
  const departureAt = new Date(Date.now() + hours * 3_600_000);
  departureAt.setUTCSeconds(0, 0);
  return as(op, (tx: Tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: departureAt.toISOString() }));
}

const check = () => staff(op, (tx) => tx<{ n: number }[]>`select app.check_operations() as n`).then(([r]) => r.n);
const settle = () => staff(op, (tx) => tx<{ n: number }[]>`select app.settle_completed_journeys() as n`).then(([r]) => r.n);

async function exceptionFor(key: string) {
  const [row] = await owner`select id, state, owner_id, resolution, resolved_at from app.exceptions where dedupe_key = ${key}`;
  return row as { id: string; state: string; owner_id: string | null; resolution: string | null; resolved_at: Date | null } | undefined;
}

beforeAll(async () => {
  owner = connectAsOwner();
  const app = connectAsApp();
  const org = await createOrganisation(owner);
  op = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Operations Manager")).userId };
  support = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Support")).userId };
  await owner`update app.users set full_name = 'Efua Owusu' where id = ${op.actorUserId}`;
  await owner`update app.settings set value = '3000' where organisation_id = ${org} and key = 'boarding.opens_minutes_before'`;
  await owner`update app.settings set value = '72' where organisation_id = ${org} and key = 'boarding.manifest_export_hours'`;
  helpers = trips(op, owner, "21");
});

afterAll(async () => {
  await owner.end();
  await op.app.end();
});

describe("the needs-attention queue (9.11, 18.6)", () => {
  it("raises 'bus missing' for a journey within 24 hours, once, and clears it when a bus is assigned", async () => {
    const soon = await busless("op1", 5);
    const later = await busless("op2", 60);
    await check();
    await check();
    const key = `bus_missing:${soon.id}`;
    const item = await exceptionFor(key);
    expect(item?.state).toBe("OPEN");
    expect(await exceptionFor(`bus_missing:${later.id}`)).toBeUndefined();
    const [count] = await owner`select count(*)::int as n from app.exceptions where dedupe_key = ${key}`;
    expect(count.n).toBe(1);

    const attention = await staff(op, (tx) => listAttention(tx, op.actorUserId));
    const shown = attention.find((a) => a.id === item!.id)!;
    expect(shown).toMatchObject({ kind: "bus_missing", severity: "high", recommendedAction: "Assign a bus.", ownerName: null });
    expect(shown.summary).toMatch(/^Bus missing: Corridor op1, \d\d \w{3} \d\d:\d\d$/);

    const bus = await coach(op, "GR-6100-26");
    await as(op, (tx: Tx) => assignVehicle(tx, soon.id, { vehicleId: bus.vehicleId }));
    await check();
    const closed = await exceptionFor(key);
    expect(closed?.state).toBe("RESOLVED");
    expect(closed?.resolution).toMatch(/Closed automatically/);
  });

  it("is worked through its status function: take, work, resolve with a note", async () => {
    const journey = await busless("op3", 3);
    await check();
    const item = (await exceptionFor(`bus_missing:${journey.id}`))!;

    await expect(owner`update app.exceptions set state = 'RESOLVED', resolution = 'done by hand', resolved_at = now() where id = ${item.id}`).rejects.toThrow(/status function/);

    await staff(support, (tx) => takeException(tx, item.id));
    expect(await exceptionFor(`bus_missing:${journey.id}`)).toMatchObject({ state: "ACKNOWLEDGED", owner_id: support.actorUserId });
    // Taking it over is allowed and audited.
    await staff(op, (tx) => takeException(tx, item.id));
    expect((await exceptionFor(`bus_missing:${journey.id}`))?.owner_id).toBe(op.actorUserId);
    const [audits] = await owner`select count(*)::int as n from app.audit_logs where entity_type = 'exceptions' and entity_id = ${item.id}`;
    expect(audits.n).toBeGreaterThanOrEqual(3);

    await staff(op, (tx) => startException(tx, op.actorUserId, item.id));
    await expect(staff(op, (tx) => resolveException(tx, op.actorUserId, item.id, { resolution: "ok" }))).rejects.toThrow(/at least 5/);
    await staff(op, (tx) => resolveException(tx, op.actorUserId, item.id, { resolution: "Moved passengers to the 10:00 bus" }));
    const done = await exceptionFor(`bus_missing:${journey.id}`);
    expect(done).toMatchObject({ state: "RESOLVED", resolution: "Moved passengers to the 10:00 bus" });
    expect(done?.resolved_at).toBeTruthy();
    await expect(staff(op, (tx) => takeException(tx, item.id))).rejects.toThrow(/already closed/);
  });

  it("can be dismissed with a reason", async () => {
    const journey = await busless("op4", 2);
    await check();
    const item = (await exceptionFor(`bus_missing:${journey.id}`))!;
    await staff(op, (tx) => dismissException(tx, op.actorUserId, item.id, { reason: "Journey will be cancelled tomorrow" }));
    expect(await exceptionFor(`bus_missing:${journey.id}`)).toMatchObject({ state: "DISMISSED", resolution: "Journey will be cancelled tomorrow" });
  });
});

describe("boarding and arrival", () => {
  let trip: Trip;
  beforeAll(async () => {
    trip = await helpers.newTrip("op5", "GR-6101-26");
  });

  it("an override boarding asks a manager to review the reason", async () => {
    const [a] = await helpers.bookAndPay(trip, ["1A"]);
    await helpers.bookAndPay(trip, ["1B", "1C"]);
    await owner`update app.payments set state = 'REVERSED' where booking_id = ${a.bookingId}`;
    await staff(op, (tx) => updateJourneyStatus(tx, trip.journeyId, { to: "BOARDING" }));
    const reason = "Passenger showed a bank receipt";
    await staff(op, (tx) => boardWithOverride(tx, trip.journeyId, { ticketId: a.id, reason }), { reason });
    const item = await exceptionFor(`boarding_override:${a.id}`);
    expect(item?.state).toBe("OPEN");
    const [row] = await owner`select summary, severity from app.exceptions where id = ${item!.id}`;
    expect(row.summary).toContain(reason);
    expect(row.severity).toBe("normal");
  });

  it("after arrival, unboarded seats become no-shows once the paper sheets are in", async () => {
    const [, b, c] = await owner`select t.id from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id
                                 join app.journey_seats js on js.id = s.journey_seat_id
                                 where t.journey_id = ${trip.journeyId} order by js.seat_number`;
    // b boards by hand; c never turns up.
    await staff(op, (tx) => tx`select app.board_ticket(${trip.journeyId}, ${b.id}, 'manual')`);
    const sheet = await staff(op, (tx) => exportPaperManifest(tx, undefined, trip.journeyId));
    await staff(op, (tx) => updateJourneyStatus(tx, trip.journeyId, { to: "DEPARTED" }));
    await staff(op, (tx) => updateJourneyStatus(tx, trip.journeyId, { to: "COMPLETED" }));
    await owner`update app.journeys set actual_arrival_at = now() - interval '7 hours' where id = ${trip.journeyId}`;

    // The open paper sheet holds everything back and needs attention.
    expect(await settle()).toBe(0);
    await check();
    expect((await exceptionFor(`paper_boardings:${trip.journeyId}`))?.state).toBe("OPEN");

    await staff(op, (tx) => closePaperManifest(tx, trip.journeyId, sheet.exportId));
    await check();
    expect((await exceptionFor(`paper_boardings:${trip.journeyId}`))?.state).toBe("RESOLVED");
    expect(await settle()).toBe(1);
    expect(await settle()).toBe(0);

    const [noShow] = await owner`select t.state, s.state as seat_state, bk.state as booking_state from app.tickets t
                                 join app.booked_seats s on s.id = t.booked_seat_id join app.bookings bk on bk.id = s.booking_id where t.id = ${c.id}`;
    expect(noShow).toMatchObject({ state: "EXPIRED", seat_state: "NO_SHOW", booking_state: "COMPLETED" });
    const [boarded] = await owner`select t.state, s.state as seat_state from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id where t.id = ${b.id}`;
    expect(boarded).toMatchObject({ state: "BOARDED", seat_state: "BOARDED" });
    // A late scan of the expired ticket is refused.
    expect((await staff(op, (tx) => tx<{ r: { code: string } }[]>`select app.board_ticket(${trip.journeyId}, ${c.id}, 'override') as r`, { reason: "late check" }))[0].r.code).toBe("journey_left");
  });
});

describe("the dashboard (8.2a)", () => {
  it("shows today's departures, problems first, and today's figures", async () => {
    // A journey later today with no bus and no crew.
    const nextHour = new Date();
    if (nextHour.getUTCHours() >= 22) return; // Too close to midnight to make a journey "later today".
    const problem = await busless("op6", 1);
    const dashboard = await staff(op, (tx) => getDashboard(tx, op.actorUserId));
    const row = dashboard.today.find((d) => d.id === problem.id)!;
    expect(row.problems).toEqual(expect.arrayContaining(["No bus", "Not on sale", "No crew"]));
    expect(dashboard.today[0].problems.length).toBeGreaterThan(0);
    expect(dashboard.figures.currency).toBe("GHS");
    expect(dashboard.figures.revenueTodayPesewas).toBeGreaterThan(0);
    // The reversed payment is not a sale; the other booking (two seats) is.
    expect(dashboard.figures.seatsSoldToday).toBe(2);
    expect(dashboard.figures.boardedToday).toBeGreaterThanOrEqual(2);
    expect(dashboard.attention.length).toBeGreaterThan(0);
  });

  it("looks up bookings by reference or phone, showing only the last digits", async () => {
    const t = await helpers.newTrip("op7", "GR-6102-26", "09:00", 2);
    const [ticket] = await helpers.bookAndPay(t, ["2A"]);
    const byRef = await staff(op, (tx) => lookupBookings(tx, ticket.reference.toLowerCase()));
    expect(byRef).toHaveLength(1);
    expect(byRef[0]).toMatchObject({ reference: ticket.reference, state: "CONFIRMED", seats: 1, phoneLastDigits: ticket.phone.slice(-3) });
    const byPhone = await staff(op, (tx) => lookupBookings(tx, `0${ticket.phone.slice(4)}`));
    expect(byPhone.map((b) => b.reference)).toContain(ticket.reference);
    await expect(staff(op, (tx) => lookupBookings(tx, "hello"))).rejects.toThrow(/booking reference/);
  });
});
