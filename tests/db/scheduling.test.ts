import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@/lib/db";
import { copyFareTable, replaceFareRules, setFareTableStatus } from "@/server/fares";
import { createLayout, publishLayout, updateVehicle } from "@/server/fleet";
import {
  addScheduleException,
  applyScheduleChange,
  createSchedule,
  newScheduleVersion,
  previewScheduleChange,
} from "@/server/schedules";
import {
  assignStaff,
  assignVehicle,
  cancelJourney,
  createOneOffJourney,
  getJourney,
  listJourneys,
  publishJourney,
  setSeatState,
} from "@/server/journeys";
import { as, coach, daysFromToday, isoDay, liveCorridor, type Operator } from "./fixtures";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";

let owner: Sql;
let op: Operator;
let other: Operator;

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

async function expectRule(promise: Promise<unknown>, message: RegExp) {
  const error = await promise.then(
    () => null,
    (e: { code?: string; message?: string }) => e,
  );
  expect(error, "expected the operation to be refused").not.toBeNull();
  expect(["BR001", "rule_violation"]).toContain(error?.code);
  expect(error?.message).toMatch(message);
}

/** Generates journeys for a fixed window starting tomorrow, as the nightly job does. */
function generate(o: Operator, days: number, from = daysFromToday(1)) {
  return as(o, async (tx) => {
    const [row] = await tx<{ created: number; putOnSale: number }[]>`
      select * from app.generate_journeys(${o.organisationId}, ${from}::date, ${days})`;
    return row;
  });
}

function journeysOf(tx: Tx, scheduleId: string) {
  return tx<{ id: string; serviceDate: string; state: string; scheduledDepartureAt: Date; scheduleVersion: number }[]>`
    select id, service_date::text as service_date, state, scheduled_departure_at, schedule_version
    from app.journeys where schedule_id = ${scheduleId} order by service_date`;
}

/** Moves a journey through the one status function, as the app will. */
function move(o: Operator, journeyId: string, to: string) {
  return as(o, (tx) => tx`select app.move_journey(${journeyId}, ${to}, 'test')`);
}

beforeAll(async () => {
  owner = connectAsOwner();
  const app = connectAsApp();
  const orgA = await createOrganisation(owner);
  const orgB = await createOrganisation(owner);
  op = { app, organisationId: orgA, actorUserId: (await createStaff(owner, orgA, "Operations Manager")).userId };
  other = { app, organisationId: orgB, actorUserId: (await createStaff(owner, orgB, "Operations Manager")).userId };
});

afterAll(async () => {
  await owner.end();
  await op.app.end();
});

describe("checkpoint: journeys generate once (D23, 10.4)", () => {
  it("generates one journey per day, puts it on sale with its default bus, and never duplicates", async () => {
    const corridor = await liveCorridor(op, "g1");
    const bus = await coach(op, "GR-1001-26");
    const schedule = await as(op, (tx) =>
      createSchedule(tx, op.actorUserId, { routeId: corridor.routeId, name: "Morning g1", departureTime: "06:30", daysOfWeek: ALL_DAYS, defaultVehicleId: bus.vehicleId }),
    );

    expect(await generate(op, 7)).toEqual({ created: 7, putOnSale: 7 });
    expect(await generate(op, 7)).toEqual({ created: 0, putOnSale: 0 });

    const journeys = await as(op, (tx) => journeysOf(tx, schedule.id));
    expect(journeys).toHaveLength(7);
    expect(journeys.every((j) => j.state === "SCHEDULED")).toBe(true);
    // 06:30 in Africa/Accra.
    expect(journeys[0].scheduledDepartureAt.toISOString()).toBe(`${daysFromToday(1)}T06:30:00.000Z`);

    const detail = await as(op, (tx) => getJourney(tx, journeys[0].id));
    expect(detail.seats).toHaveLength(52);
    expect(detail.fareCount).toBe(3);
    expect(detail.vehicleRegistration).toBe("GR-1001-26");
    expect(detail.scheduledArrivalAt.getTime() - detail.scheduledDepartureAt.getTime()).toBe(165 * 60_000);
    expect(detail.bookingOpensAt.getTime()).toBe(detail.scheduledDepartureAt.getTime() - 30 * 24 * 3600_000);
    expect(detail.events.map((e) => e.eventType)).toEqual(["created", "vehicle_assigned", "state_changed"]);
  });

  it("leaves a journey as a draft that needs a bus when its default bus is busy", async () => {
    const corridor = await liveCorridor(op, "g2");
    const bus = await coach(op, "GR-1002-26");
    await as(op, (tx) =>
      createSchedule(tx, op.actorUserId, { routeId: corridor.routeId, name: "Early g2", departureTime: "05:00", daysOfWeek: ALL_DAYS, defaultVehicleId: bus.vehicleId }),
    );
    // 06:30 is inside 05:00 + 165 min + 60 min turnaround, so the same bus cannot run it.
    const clash = await as(op, (tx) =>
      createSchedule(tx, op.actorUserId, { routeId: corridor.routeId, name: "Clash g2", departureTime: "06:30", daysOfWeek: ALL_DAYS, defaultVehicleId: bus.vehicleId }),
    );
    await generate(op, 2);
    const drafts = await as(op, (tx) => listJourneys(tx, { routeId: corridor.routeId, needsAttention: "true", page: 1, pageSize: 25 }));
    expect(drafts.items.map((j) => j.scheduleId)).toEqual([clash.id, clash.id]);
    expect(drafts.items.every((j) => j.needsBus && j.state === "DRAFT")).toBe(true);
  });

  it("skips days outside the pattern and follows exceptions", async () => {
    const corridor = await liveCorridor(op, "g3");
    const tomorrow = daysFromToday(1);
    const schedule = await as(op, (tx) =>
      createSchedule(tx, op.actorUserId, { routeId: corridor.routeId, name: "Weekly g3", departureTime: "09:00", daysOfWeek: [isoDay(tomorrow)] }),
    );
    // The day after tomorrow is not in the pattern: add an extra run that day.
    await as(op, (tx) =>
      addScheduleException(tx, op.actorUserId, schedule.id, { serviceDate: daysFromToday(2), kind: "extra", departureTime: "10:15", reason: "Exam week" }),
    );
    await generate(op, 7);
    let journeys = await as(op, (tx) => journeysOf(tx, schedule.id));
    expect(journeys.map((j) => j.serviceDate)).toEqual([daysFromToday(1), daysFromToday(2)]);
    expect(journeys[1].scheduledDepartureAt.toISOString()).toBe(`${daysFromToday(2)}T10:15:00.000Z`);

    // A holiday on a generated day cancels that journey (it has no bookings).
    await as(op, (tx) => addScheduleException(tx, op.actorUserId, schedule.id, { serviceDate: tomorrow, kind: "skip", reason: "Public holiday" }));
    journeys = await as(op, (tx) => journeysOf(tx, schedule.id));
    expect(journeys[0].state).toBe("CANCELLED");
  });
});

describe("checkpoint: assignments cannot overlap (11.8 #3, #4)", () => {
  it("refuses a bus on two journeys closer than the turnaround buffer", async () => {
    const corridor = await liveCorridor(op, "a1");
    const bus = await coach(op, "GR-2001-26");
    const day = daysFromToday(3);
    const one = (time: string) => as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${day}T${time}:00Z` }));

    const first = await one("06:00"); // busy until 08:45 + 60 min = 09:45
    const tooSoon = await one("09:30");
    const justRight = await one("09:45");

    await as(op, (tx) => assignVehicle(tx, first.id, { vehicleId: bus.vehicleId }));
    await expectRule(as(op, (tx) => assignVehicle(tx, tooSoon.id, { vehicleId: bus.vehicleId })), /already on another journey .* 60-minute turnaround/);
    const ok = await as(op, (tx) => assignVehicle(tx, justRight.id, { vehicleId: bus.vehicleId }));
    expect(ok.vehicleRegistration).toBe("GR-2001-26");
  });

  it("keeps one active bus per journey, replacing the old one while a draft", async () => {
    const corridor = await liveCorridor(op, "a2");
    const busA = await coach(op, "GR-2002-26");
    const busB = await coach(op, "GR-2003-26");
    const journey = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(4)}T07:00:00Z`, vehicleId: busA.vehicleId }));
    await as(op, (tx) => assignVehicle(tx, journey.id, { vehicleId: busB.vehicleId, reason: "Bus A to the workshop" }));
    const rows = await owner`select state, vehicle_id from app.vehicle_assignments where journey_id = ${journey.id} order by assigned_at`;
    expect(rows.map((r) => r.state)).toEqual(["REPLACED", "ACTIVE"]);
    await expect(
      owner`insert into app.vehicle_assignments (organisation_id, journey_id, vehicle_id, occupied_during)
            values (${op.organisationId}, ${journey.id}, ${busA.vehicleId}, tstzrange(now() + interval '20 days', now() + interval '21 days'))`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("frees the bus when a journey is cancelled, and refuses to retire a bus with upcoming journeys", async () => {
    const corridor = await liveCorridor(op, "a3");
    const bus = await coach(op, "GR-2004-26");
    const day = daysFromToday(5);
    const first = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${day}T06:00:00Z`, vehicleId: bus.vehicleId }));
    const second = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${day}T07:00:00Z` }));

    await expectRule(as(op, (tx) => updateVehicle(tx, bus.vehicleId, { status: "retired" })), /assigned to 1 journeys that have not run/);
    await as(op, (tx) => cancelJourney(tx, first.id, { reason: "Low demand" }), "Low demand");
    const reassigned = await as(op, (tx) => assignVehicle(tx, second.id, { vehicleId: bus.vehicleId }));
    expect(reassigned.vehicleRegistration).toBe("GR-2004-26");
    const cancelled = await as(op, (tx) => getJourney(tx, first.id));
    expect(cancelled).toMatchObject({ state: "CANCELLED", cancellationReason: "Low demand", vehicleRegistration: null });
  });

  it("never puts one person on two overlapping journeys, and only staff", async () => {
    const corridor = await liveCorridor(op, "a4");
    const conductor = await createStaff(owner, op.organisationId, "Conductor");
    const day = daysFromToday(6);
    const j1 = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${day}T06:00:00Z` }));
    const j2 = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${day}T08:00:00Z` }));
    await as(op, (tx) => assignStaff(tx, j1.id, { userId: conductor.userId, staffRole: "conductor" }));
    await expectRule(as(op, (tx) => assignStaff(tx, j2.id, { userId: conductor.userId, staffRole: "conductor" })), /already on another journey/);

    const [authUser] = await owner`insert into auth.users default values returning id`;
    const [passenger] = await owner`
      insert into app.users (organisation_id, auth_user_id, kind, phone)
      values (${op.organisationId}, ${authUser.id}, 'passenger', '+233249999001') returning id`;
    await expectRule(as(op, (tx) => assignStaff(tx, j2.id, { userId: passenger.id as string, staffRole: "driver" })), /Only active staff/);
  });
});

describe("checkpoint: snapshots hold (10.4, 27.3, 27.4)", () => {
  it("keeps a journey's fares and seats when the fare table and seat layout change", async () => {
    const corridor = await liveCorridor(op, "s1");
    const bus = await coach(op, "GR-3001-26");
    const journey = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(7)}T06:00:00Z`, vehicleId: bus.vehicleId }));
    await as(op, (tx) => publishJourney(tx, journey.id));
    const before = await owner`select origin_stop_id, destination_stop_id, amount_pesewas from app.journey_fares where journey_id = ${journey.id} order by amount_pesewas`;

    // New prices go live for the route.
    await as(op, async (tx) => {
      const draft = await copyFareTable(tx, corridor.fareTableId, { name: "Raised s1" });
      await replaceFareRules(tx, draft.id, {
        rules: draft.rules.map((r) => ({ originStopId: r.originStopId, destinationStopId: r.destinationStopId, seatType: r.seatType, amountPesewas: r.amountPesewas + 1_000 })),
      });
      await setFareTableStatus(tx, draft.id, "active");
    });
    // A new seat layout is published for the bus.
    await as(op, async (tx) => {
      const v2 = await createLayout(tx, op.actorUserId, bus.vehicleId, { name: "2+1", pattern: { left: 2, right: 1, rows: 12, fullBackRow: false } });
      await publishLayout(tx, v2.id);
    });

    const after = await owner`select origin_stop_id, destination_stop_id, amount_pesewas from app.journey_fares where journey_id = ${journey.id} order by amount_pesewas`;
    expect(after).toEqual(before);
    const seats = await owner`select count(*)::int as n from app.journey_seats where journey_id = ${journey.id}`;
    expect(seats[0].n).toBe(52);
  });

  it("refuses any edit to the snapshots except blocking a seat", async () => {
    const corridor = await liveCorridor(op, "s2");
    const bus = await coach(op, "GR-3002-26");
    const journey = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(8)}T06:00:00Z`, vehicleId: bus.vehicleId }));
    await as(op, (tx) => publishJourney(tx, journey.id));

    await expect(owner`update app.journey_fares set amount_pesewas = 1 where journey_id = ${journey.id}`).rejects.toThrow(/append-only/);
    await expect(owner`delete from app.journey_fares where journey_id = ${journey.id}`).rejects.toThrow(/append-only/);
    await expect(owner`delete from app.journey_seats where journey_id = ${journey.id}`).rejects.toMatchObject({ code: "BR001" });
    await expect(owner`update app.journey_seats set seat_type = 'premium' where journey_id = ${journey.id}`).rejects.toMatchObject({ code: "BR001" });
    await expectRule(as(op, (tx) => assignVehicle(tx, journey.id, { vehicleId: bus.vehicleId })), /already on sale/);

    const seat = (await as(op, (tx) => getJourney(tx, journey.id))).seats[0];
    const updated = await as(op, (tx) => setSeatState(tx, journey.id, seat.id, { state: "BLOCKED" }));
    expect(updated.bookableSeats).toBe(51);
  });
});

describe("the journey state machine (9.1, 9.2)", () => {
  it("refuses a status written outside the status function, and illegal moves", async () => {
    const corridor = await liveCorridor(op, "m1");
    const journey = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(9)}T06:00:00Z` }));
    await expect(owner`update app.journeys set state = 'SCHEDULED' where id = ${journey.id}`).rejects.toThrow(/only through the journey status function/);
    await expectRule(move(op, journey.id, "DEPARTED"), /cannot go from DRAFT to DEPARTED/);
    await expectRule(move(op, journey.id, "SCHEDULED"), /needs a bus/);
  });

  it("runs a journey from sale to completion, recording each move", async () => {
    const corridor = await liveCorridor(op, "m2");
    const bus = await coach(op, "GR-4001-26");
    const journey = await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(10)}T06:00:00Z`, vehicleId: bus.vehicleId }));
    await as(op, (tx) => publishJourney(tx, journey.id));
    for (const to of ["SALES_CLOSED", "BOARDING", "DEPARTED", "COMPLETED"]) await move(op, journey.id, to);
    await expectRule(move(op, journey.id, "CANCELLED"), /cannot go from COMPLETED to CANCELLED/);

    const done = await as(op, (tx) => getJourney(tx, journey.id));
    expect(done.actualDepartureAt).not.toBeNull();
    expect(done.actualArrivalAt).not.toBeNull();
    const moves = done.events.filter((e) => e.eventType === "state_changed").map((e) => `${e.fromState}>${e.toState}`);
    expect(moves).toEqual(["DRAFT>SCHEDULED", "SCHEDULED>SALES_CLOSED", "SALES_CLOSED>BOARDING", "BOARDING>DEPARTED", "DEPARTED>COMPLETED"]);
    await expect(owner`delete from app.journey_events where journey_id = ${journey.id}`).rejects.toThrow(/append-only/);
  });
});

describe("changing a schedule (23.1)", () => {
  it("previews, then moves unbooked journeys to the new time and cancels days no longer run", async () => {
    const corridor = await liveCorridor(op, "c1");
    const bus = await coach(op, "GR-5001-26");
    const schedule = await as(op, (tx) =>
      createSchedule(tx, op.actorUserId, { routeId: corridor.routeId, name: "Daily c1", departureTime: "06:00", daysOfWeek: ALL_DAYS, defaultVehicleId: bus.vehicleId }),
    );
    await generate(op, 3);

    const dropped = isoDay(daysFromToday(2));
    const { impact } = await as(op, (tx) =>
      newScheduleVersion(tx, op.actorUserId, schedule.id, { departureTime: "07:30", daysOfWeek: ALL_DAYS.filter((d) => d !== dropped), defaultVehicleId: bus.vehicleId }),
    );
    expect(impact).toMatchObject({ toRetime: 2, toCancel: 1, unchangedBecauseBooked: 0 });

    // Nothing changes until the manager confirms.
    expect((await as(op, (tx) => journeysOf(tx, schedule.id)))[0].scheduleVersion).toBe(1);
    expect(await as(op, (tx) => applyScheduleChange(tx, schedule.id))).toEqual({ retimed: 2, cancelled: 1, unchangedBecauseBooked: 0 });

    const journeys = await as(op, (tx) => journeysOf(tx, schedule.id));
    expect(journeys.map((j) => j.state)).toEqual(["SCHEDULED", "CANCELLED", "SCHEDULED"]);
    expect(journeys[0].scheduledDepartureAt.toISOString()).toBe(`${daysFromToday(1)}T07:30:00.000Z`);
    expect(journeys[0].scheduleVersion).toBe(2);
    // The bus's busy time moved with the journey.
    const [range] = await owner`select lower(occupied_during) as starts from app.vehicle_assignments where journey_id = ${journeys[0].id} and state = 'ACTIVE'`;
    expect((range.starts as Date).toISOString()).toBe(`${daysFromToday(1)}T07:30:00.000Z`);
    expect((await as(op, (tx) => previewScheduleChange(tx, schedule.id))).journeys).toHaveLength(0);
  });

  it("keeps schedule versions as history", async () => {
    await expect(owner`update app.schedule_versions set departure_time = '05:00'`).rejects.toThrow(/append-only/);
  });
});

describe("organisation boundary", () => {
  it("does not show one organisation's journeys to another", async () => {
    const corridor = await liveCorridor(op, "b1");
    await as(op, (tx) => createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(11)}T06:00:00Z` }));
    const seen = await as(other, (tx) => listJourneys(tx, { page: 1, pageSize: 25 }));
    expect(seen.total).toBe(0);
    await expect(
      as(other, (tx) => createOneOffJourney(tx, other.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(11)}T06:00:00Z` })),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
