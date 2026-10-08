import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addScheduleException, applyScheduleChange, createSchedule, newScheduleVersion } from "@/server/schedules";
import { as, coach, daysFromToday, liveCorridor, type Operator } from "./fixtures";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";
import { trips } from "./trips";

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

let owner: Sql;
let op: Operator;
let helpers: ReturnType<typeof trips>;

beforeAll(async () => {
  owner = connectAsOwner();
  const org = await createOrganisation(owner);
  op = { app: connectAsApp(), organisationId: org, actorUserId: (await createStaff(owner, org, "Operations Manager")).userId };
  helpers = trips(op, owner, "22");
});

afterAll(async () => {
  await owner.end();
  await op.app.end();
});

async function journeys(scheduleId: string) {
  return owner`select id, state, scheduled_departure_at from app.journeys where schedule_id = ${scheduleId} order by service_date`;
}

/** A daily schedule with a bus, generated for three days from tomorrow, and a paid booking on the first day. */
async function bookedSchedule(suffix: string, registration: string) {
  const corridor = await liveCorridor(op, suffix);
  const bus = await coach(op, registration);
  const schedule = await as(op, (tx) =>
    createSchedule(tx, op.actorUserId, { routeId: corridor.routeId, name: `Daily ${suffix}`, departureTime: "06:00", daysOfWeek: ALL_DAYS, defaultVehicleId: bus.vehicleId }),
  );
  await as(op, (tx) => tx`select * from app.generate_journeys(${op.organisationId}, ${daysFromToday(1)}::date, 3)`);
  const [first] = await journeys(schedule.id);
  const seats = await owner`select id, seat_number from app.journey_seats where journey_id = ${first.id}`;
  await helpers.bookAndPay({ journeyId: first.id, stops: corridor.stops, seatMap: new Map(seats.map((s) => [s.seat_number as string, s.id as string])) }, ["3A"]);
  return { schedule, firstId: first.id as string };
}

describe("schedule changes never move or cancel a departure with passengers (23.1, 8.4)", () => {
  it("a new time leaves the booked departure as it is", async () => {
    const { schedule, firstId } = await bookedSchedule("sb1", "GR-4401-26");
    const { impact } = await as(op, (tx) =>
      newScheduleVersion(tx, op.actorUserId, schedule.id, { departureTime: "07:30", daysOfWeek: ALL_DAYS }),
    );
    expect(impact).toMatchObject({ toRetime: 2, toCancel: 0, unchangedBecauseBooked: 1 });
    expect(await as(op, (tx) => applyScheduleChange(tx, schedule.id))).toEqual({ retimed: 2, cancelled: 0, unchangedBecauseBooked: 1 });
    const after = await journeys(schedule.id);
    expect((after[0].scheduled_departure_at as Date).toISOString()).toBe(`${daysFromToday(1)}T06:00:00.000Z`);
    expect(after[0].id).toBe(firstId);
    expect((after[1].scheduled_departure_at as Date).toISOString()).toBe(`${daysFromToday(2)}T07:30:00.000Z`);
  });

  it("a holiday on a booked day keeps the departure and asks a manager to decide", async () => {
    const { schedule, firstId } = await bookedSchedule("sb2", "GR-4402-26");
    const result = await as(op, (tx) =>
      addScheduleException(tx, op.actorUserId, schedule.id, { serviceDate: daysFromToday(1), kind: "skip", reason: "Public holiday" }),
    );
    expect(result.notice).toMatch(/already has passengers, so it was not changed/);
    const [journey] = await owner`select state from app.journeys where id = ${firstId}`;
    expect(journey.state).toBe("SCHEDULED");
    const [item] = await owner`select kind, severity, state from app.exceptions where journey_id = ${firstId}`;
    expect(item).toMatchObject({ kind: "schedule_change_on_booked_journey", severity: "high", state: "OPEN" });

    // An unbooked day still follows the holiday straight away.
    const unbooked = await as(op, (tx) =>
      addScheduleException(tx, op.actorUserId, schedule.id, { serviceDate: daysFromToday(2), kind: "skip", reason: "Public holiday" }),
    );
    expect(unbooked.notice).toBeNull();
    expect((await journeys(schedule.id))[1].state).toBe("CANCELLED");
  });
});
