import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOrganisation, type Tx } from "@/lib/db";
import { createLayout, createVehicle, createVehicleInput, publishLayout } from "@/server/fleet";
import { getSeatMap, holdInput, holdSeats } from "@/server/bookings";
import { changeVehicle, previewVehicleChange } from "@/server/vehicle-change";
import { as, coach, daysFromToday, liveCorridor, type Operator } from "./fixtures";
import { copyFareTable, listFareTables, replaceFareRules, setFareTableStatus } from "@/server/fares";
import { createOneOffJourney, publishJourney } from "@/server/journeys";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";
import { staff, trips, type Ticket, type Trip } from "./trips";

let owner: Sql;
let op: Operator;
let helpers: ReturnType<typeof trips>;
const ctx = () => ({ organisationId: op.organisationId, correlationId: "test" });

/** A bus with a seat-by-seat layout, for unusual plans. */
async function customBus(registration: string, seats: { seatNumber: string; rowNumber: number; columnNumber: number; seatType?: "standard" | "accessible" }[]) {
  return as(op, async (tx: Tx) => {
    const vehicle = await createVehicle(tx, op.actorUserId, createVehicleInput.parse({ registration, vehicleType: "minibus", capacity: seats.length }));
    const layout = await createLayout(tx, op.actorUserId, vehicle.id, {
      name: "custom",
      rowCount: Math.max(...seats.map((s) => s.rowNumber)),
      columnCount: Math.max(...seats.map((s) => s.columnNumber)),
      seats: seats.map((s) => ({ ...s, seatType: s.seatType ?? "standard", position: null, bookable: true })),
    });
    await publishLayout(tx, layout.id);
    return vehicle.id;
  });
}

async function hold(trip: Trip, seat: string) {
  const input = holdInput.parse({
    journeyId: trip.journeyId, originStopId: trip.stops[0].id, destinationStopId: trip.stops[2].id,
    purchaser: { name: "Abena", phone: "+233205550001" },
    seats: [{ journeySeatId: trip.seatMap.get(seat), passenger: { fullName: "Abena", phone: "+233205550001" } }],
  });
  return withOrganisation(ctx(), (tx) => holdSeats(tx, input, { userId: null, address: null, source: "passenger_app" }), op.app);
}

const preview = (trip: Trip, vehicleId: string, choices: Parameters<typeof previewVehicleChange>[2]["choices"] = []) =>
  staff(op, (tx) => previewVehicleChange(tx, trip.journeyId, { vehicleId, choices }));

beforeAll(async () => {
  owner = connectAsOwner();
  const org = await createOrganisation(owner);
  op = { app: connectAsApp(), organisationId: org, actorUserId: (await createStaff(owner, org, "Operations Manager")).userId };
  helpers = trips(op, owner, "24");
});

afterAll(async () => {
  await owner.end();
  await op.app.end();
});

describe("replacing a bus after seats are sold (15.1)", () => {
  let trip: Trip;
  let group: Ticket[];
  let single: Ticket;
  let back: Ticket;
  let newBus: string;

  beforeAll(async () => {
    // The journey's bus is a 2+1 coach (seats A, B | C); the new one a 2+2 coach of 13 rows (A, B | C, D).
    trip = await helpers.newTrip("vc1", "GR-2201-26");
    group = await helpers.bookAndPay(trip, ["1A", "1B", "1C"]);
    [single] = await helpers.bookAndPay(trip, ["5A"]);
    [back] = await helpers.bookAndPay(trip, ["30C"]);
    await hold(trip, "6B");
    newBus = (await coach(op, "GR-2202-26")).vehicleId;
  });

  it("matches each passenger by the rules, in booking order, the same way every time", async () => {
    const first = await preview(trip, newBus);
    const second = await preview(trip, newBus);
    expect(second.rows).toEqual(first.rows);
    expect(second.planFingerprint).toBe(first.planFingerprint);
    expect(first.rows.map((r) => [r.oldSeatNumber, r.newSeatNumber, r.rule])).toEqual([
      ["1A", "1A", 1], ["1B", "1B", 1], ["1C", "1C", 1],
      ["5A", "5A", 1],
      // Row 30 does not exist on the new bus: the nearest window seat, at the back.
      ["30C", "13D", 4],
      // An unpaid hold that is still live keeps its seat too.
      ["6B", "6B", 1],
    ]);
    expect(first.needsChoice).toBe(0);
  });

  it("is refused without the preview the manager saw", async () => {
    await expect(staff(op, (tx) => changeVehicle(tx, trip.journeyId, { vehicleId: newBus, reason: "Coach needs a new tyre", choices: [], planFingerprint: "0".repeat(64) })))
      .rejects.toThrow(/changed since you looked/);
  });

  it("moves everyone in one step, keeps tickets and codes, and records every move", async () => {
    const credentialsBefore = await owner`select ticket_id, id from app.ticket_credentials where ticket_id = any(${[...group, single, back].map((t) => t.id)}) and revoked_at is null order by ticket_id`;
    const { planFingerprint } = await preview(trip, newBus);
    const result = await staff(op, (tx) => changeVehicle(tx, trip.journeyId, { vehicleId: newBus, reason: "Coach needs a new tyre", choices: [], planFingerprint }));
    expect(result).toMatchObject({ moved: 6, refunded: 0 });

    // The new seats are the only live ones; the old snapshot is retired, not deleted.
    const [counts] = await owner`select count(*) filter (where retired_at is null)::int as live, count(*) filter (where retired_at is not null)::int as retired
                                 from app.journey_seats where journey_id = ${trip.journeyId}`;
    expect(counts).toEqual({ live: 52, retired: 90 });
    const seatMap = await staff(op, (tx) => getSeatMap(tx, trip.journeyId, { origin: trip.stops[0].id, destination: trip.stops[2].id }));
    expect(seatMap.seats).toHaveLength(52);
    const taken = seatMap.seats.filter((s) => s.status !== "available").map((s) => s.seatNumber).sort();
    expect(taken).toEqual(["13D", "1A", "1B", "1C", "5A", "6B"].sort());

    // Tickets and QR credentials are unchanged (15.1 rule 2).
    const credentialsAfter = await owner`select ticket_id, id from app.ticket_credentials where ticket_id = any(${[...group, single, back].map((t) => t.id)}) and revoked_at is null order by ticket_id`;
    expect(credentialsAfter).toEqual(credentialsBefore);
    const [moved] = await owner`select js.seat_number, js.retired_at from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id
                                join app.journey_seats js on js.id = s.journey_seat_id where t.id = ${back.id}`;
    expect(moved).toMatchObject({ seat_number: "13D", retired_at: null });

    const [held] = await owner`select c.state, c.expires_at is not null as expires from app.seat_claims c join app.journey_seats js on js.id = c.journey_seat_id
                               where c.journey_id = ${trip.journeyId} and js.seat_number = '6B' and js.retired_at is null`;
    expect(held).toEqual({ state: "HELD", expires: true });

    const assignments = await owner`select state, reason from app.vehicle_assignments where journey_id = ${trip.journeyId} order by assigned_at`;
    expect(assignments.map((a) => a.state)).toEqual(["REPLACED", "ACTIVE"]);
    const [remaps] = await owner`select count(*)::int as n from app.seat_remaps where journey_id = ${trip.journeyId}`;
    expect(remaps.n).toBe(6);
    await expect(owner`update app.seat_remaps set rule = 1 where journey_id = ${trip.journeyId}`).rejects.toThrow();

    // Each paid booking is told, once.
    const messages = await owner`select payload ->> 'bookingId' as booking from app.outbox where event_type = 'seat_changed'
                                 and payload ->> 'assignmentId' = ${result.assignmentId}`;
    expect(messages.map((m) => m.booking).sort()).toEqual([group[0].bookingId, single.bookingId, back.bookingId].sort());
  });

  it("a bus with coming departures cannot be retired (15.5)", async () => {
    await expect(staff(op, (tx) => tx`update app.vehicles set status = 'retired' where id = ${newBus}`)).rejects.toThrow(/assigned to 1 journeys/);
    // The replaced bus has no passengers left on this departure, so it can go.
    const [old] = await owner`select vehicle_id from app.vehicle_assignments where journey_id = ${trip.journeyId} and state = 'REPLACED'`;
    await staff(op, (tx) => tx`update app.vehicles set status = 'retired' where id = ${old.vehicle_id}`);
  });

  it("an old seat can never be sold or unblocked again", async () => {
    const [old] = await owner`select id from app.journey_seats where journey_id = ${trip.journeyId} and retired_at is not null limit 1`;
    await expect(owner`update app.journey_seats set state = 'BOOKABLE' where id = ${old.id}`).rejects.toThrow(/previous bus/);
  });
});

describe("capacity and accessibility (15.1, 15.5)", () => {
  it("a smaller bus is refused until every passenger has a place or a refund", async () => {
    const trip = await helpers.newTrip("vc2", "GR-2203-26");
    const a = await helpers.bookAndPay(trip, ["1A", "1B", "1C"]);
    const [b] = await helpers.bookAndPay(trip, ["2A"]);
    const small = await customBus("GR-2204-26", [
      { seatNumber: "1A", rowNumber: 1, columnNumber: 1 }, { seatNumber: "1B", rowNumber: 1, columnNumber: 2 },
      { seatNumber: "2A", rowNumber: 2, columnNumber: 1 },
    ]);
    const plan = await preview(trip, small);
    expect(plan.rows.map((r) => [r.oldSeatNumber, r.newSeatNumber, r.outcome])).toEqual([
      ["1A", "1A", "moved"], ["1B", "1B", "moved"], ["1C", "2A", "moved"], ["2A", null, "needs_choice"],
    ]);
    await expect(staff(op, (tx) => changeVehicle(tx, trip.journeyId, { vehicleId: small, reason: "Only the minibus is free", choices: [], planFingerprint: plan.planFingerprint })))
      .rejects.toThrow(/Choose a seat or a refund/);
    await expect(owner`select app.change_vehicle(${trip.journeyId}, ${small}, 'Only the minibus is free', '[]')`).rejects.toThrow(/has 3 seats but 4 are sold/);

    const choices = [{ bookedSeatId: (await owner`select booked_seat_id from app.tickets where id = ${b.id}`)[0].booked_seat_id as string, refund: true as const }];
    const settled = await preview(trip, small, choices);
    expect(settled.needsChoice).toBe(0);
    const result = await staff(op, (tx) => changeVehicle(tx, trip.journeyId, { vehicleId: small, reason: "Only the minibus is free", choices, planFingerprint: settled.planFingerprint }));
    expect(result).toMatchObject({ moved: 3, refunded: 1 });
    const [refund] = await owner`select kind, state from app.refunds where booking_id = ${b.bookingId}`;
    expect(refund).toEqual({ kind: "operator_cancellation", state: "APPROVED" });
    void a;
  });

  it("an accessible seat only ever goes to an accessible seat", async () => {
    // A route whose fares include accessible seats, and a journey on a bus with an accessible seat 1A.
    const corridor = await liveCorridor(op, "vc3");
    await as(op, async (tx: Tx) => {
      const live = await listFareTables(tx, { routeId: corridor.routeId, status: "active", page: 1, pageSize: 5 });
      const copy = await copyFareTable(tx, live.items[0].id, { name: "With accessible seats" });
      await replaceFareRules(tx, copy.id, {
        rules: copy.rules.flatMap((r) => [
          { originStopId: r.originStopId, destinationStopId: r.destinationStopId, seatType: "standard" as const, amountPesewas: r.amountPesewas },
          { originStopId: r.originStopId, destinationStopId: r.destinationStopId, seatType: "accessible" as const, amountPesewas: r.amountPesewas },
        ]),
      });
      await setFareTableStatus(tx, copy.id, "active");
    });
    const accessibleBus = await customBus("GR-2206-26", [
      { seatNumber: "1A", rowNumber: 1, columnNumber: 1, seatType: "accessible" }, { seatNumber: "1B", rowNumber: 1, columnNumber: 2 },
      { seatNumber: "2A", rowNumber: 2, columnNumber: 1 }, { seatNumber: "2B", rowNumber: 2, columnNumber: 2 },
    ]);
    const journey = await as(op, (tx: Tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(1)}T11:00:00Z`, vehicleId: accessibleBus }));
    await as(op, (tx: Tx) => publishJourney(tx, journey.id));
    const live = await owner`select id, seat_number from app.journey_seats where journey_id = ${journey.id}`;
    const trip = { journeyId: journey.id, stops: corridor.stops, seatMap: new Map(live.map((r) => [r.seat_number as string, r.id as string])) };
    const current = trip;
    const [passenger] = await helpers.bookAndPay(current, ["1A"]);
    const [bookedSeat] = await owner`select booked_seat_id from app.tickets where id = ${passenger.id}`;

    // The new bus has no accessible seat: the rules never put them in a standard one.
    const plain = await customBus("GR-2207-26", [
      { seatNumber: "1A", rowNumber: 1, columnNumber: 1 }, { seatNumber: "1B", rowNumber: 1, columnNumber: 2 },
    ]);
    const plan = await preview(current, plain);
    expect(plan.rows.map((r) => [r.oldSeatNumber, r.oldSeatType, r.outcome])).toEqual([["1A", "accessible", "needs_choice"]]);

    // Nor can the manager, by hand; a refund is the way out.
    const byHand = [{ bookedSeatId: bookedSeat.booked_seat_id as string, seatNumber: "1A" }];
    const handPlan = await preview(current, plain, byHand);
    await expect(staff(op, (tx) => changeVehicle(tx, trip.journeyId, { vehicleId: plain, reason: "Accessible bus broke down", choices: byHand, planFingerprint: handPlan.planFingerprint })))
      .rejects.toThrow(/needs an accessible seat/);
    const refund = [{ bookedSeatId: bookedSeat.booked_seat_id as string, refund: true as const }];
    const refundPlan = await preview(current, plain, refund);
    const done = await staff(op, (tx) => changeVehicle(tx, trip.journeyId, { vehicleId: plain, reason: "Accessible bus broke down", choices: refund, planFingerprint: refundPlan.planFingerprint }));
    expect(done).toMatchObject({ moved: 0, refunded: 1 });
  });
});
