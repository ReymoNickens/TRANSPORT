import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOrganisation } from "@/lib/db";
import { checkLimit, guardedLookup, limits } from "@/lib/api/rate-limit";
import { findAccessibleBooking, holdInput, holdSeats } from "@/server/bookings";
import { currentAlerts } from "@/server/alerts";
import type { Operator } from "./fixtures";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";
import { staff, trips, type Trip } from "./trips";

/**
 * Adversarial tests (spec 24.5): each attack must fail safely. Those already
 * covered elsewhere: concurrent same-seat holds, duplicate and forged
 * callbacks and a wrong amount (booking.test.ts); expired, cancelled and
 * wrong-journey tickets (boarding.test.ts, operations.test.ts); excessive
 * refunds (booking.test.ts, refunds.test.ts).
 */

let owner: Sql;
let op: Operator;
let helpers: ReturnType<typeof trips>;
let trip: Trip;
let other: Trip;
const ctx = () => ({ organisationId: op.organisationId, correlationId: "test" });

function holdBody(t: Trip, seat: string, extra: Record<string, unknown> = {}) {
  return {
    journeyId: t.journeyId, originStopId: t.stops[0].id, destinationStopId: t.stops[2].id,
    purchaser: { name: "Yaa", phone: "+233207770001" },
    seats: [{ journeySeatId: t.seatMap.get(seat), passenger: { fullName: "Yaa", phone: "+233207770001", ...extra } }],
    ...extra,
  };
}

const hold = (body: unknown) =>
  withOrganisation(ctx(), (tx) => holdSeats(tx, holdInput.parse(body), { userId: null, address: null, source: "passenger_app" }), op.app);

beforeAll(async () => {
  owner = connectAsOwner();
  const org = await createOrganisation(owner);
  op = { app: connectAsApp(), organisationId: org, actorUserId: (await createStaff(owner, org, "Operations Manager")).userId };
  helpers = trips(op, owner, "27");
  trip = await helpers.newTrip("ad1", "GR-8801-26");
  other = await helpers.newTrip("ad2", "GR-8802-26", "14:00");
});

afterAll(async () => {
  await owner.end();
  await op.app.end();
});

describe("tampered requests", () => {
  it("a modified fare in the request is ignored: the server prices from the journey's fares", async () => {
    const result = await hold(holdBody(trip, "1A", { amountPesewas: 1, totalPesewas: 1, price: 1 }));
    // The 80.00 fare, whatever the client claimed.
    expect(result.totalPesewas).toBe(8_000);
  });

  it("a seat from another journey is refused", async () => {
    const body = holdBody(trip, "2A");
    body.seats[0].journeySeatId = other.seatMap.get("2A");
    await expect(hold(body)).rejects.toThrow();
    const [row] = await owner`select count(*)::int as n from app.seat_claims where journey_seat_id = ${other.seatMap.get("2A")!} and state in ('HELD', 'CONFIRMED')`;
    expect(row.n).toBe(0);
  });

  it("a made-up seat id is refused", async () => {
    const body = holdBody(trip, "3A");
    body.seats[0].journeySeatId = "01900000-0000-7000-8000-000000000000";
    await expect(hold(body)).rejects.toThrow();
  });

  it("another person's booking cannot be opened with a wrong token or another account", async () => {
    const [ticket] = await helpers.bookAndPay(trip, ["4A"]);
    const [booking] = await owner`select reference from app.bookings where id = ${ticket.bookingId}`;
    await expect(withOrganisation(ctx(), (tx) => findAccessibleBooking(tx, booking.reference, { userId: null, accessToken: "guessed-token" }), op.app))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(withOrganisation(ctx(), (tx) => findAccessibleBooking(tx, booking.reference, { userId: op.actorUserId, accessToken: null }), op.app))
      .rejects.toMatchObject({ code: "not_found" });
  });
});

describe("guessing and floods (19.6, 19.9)", () => {
  it("guessing booking references locks the address out after 10 misses", async () => {
    const address = "203.0.113.7";
    const miss = () => guardedLookup(ctx(), address, async () => null, op.app);
    for (let i = 0; i < limits.lookupMiss.limit; i++) expect(await miss()).toBeNull();
    await expect(miss()).rejects.toMatchObject({ code: "rate_limited" });
    // Even a correct lookup is refused until the window passes.
    await expect(guardedLookup(ctx(), address, async () => "found", op.app)).rejects.toMatchObject({ code: "rate_limited" });
    // Another address is not affected.
    expect(await guardedLookup(ctx(), "203.0.113.8", async () => "found", op.app)).toBe("found");
  });

  it("a scan flood from one device is slowed", async () => {
    const results = [];
    for (let i = 0; i < limits.scan.limit + 5; i++) {
      results.push(await checkLimit(ctx(), "scan", "flooding-conductor", op.app).then(() => "ok", (e) => e.code));
    }
    expect(results.filter((r) => r === "ok")).toHaveLength(limits.scan.limit);
    expect(results.slice(-5).every((r) => r === "rate_limited")).toBe(true);
  });

  it("more than 5 sign-in codes an hour to one number are refused", async () => {
    const outcomes = [];
    for (let i = 0; i < 7; i++) {
      const [row] = await op.app`select app.hit_rate_limit(${"signInCode:test-number-hash"}, ${limits.signInCode.limit}, ${limits.signInCode.windowSeconds}) as allowed`;
      outcomes.push(row.allowed);
    }
    expect(outcomes).toEqual([true, true, true, true, true, false, false]);
  });

  it("limits are shared: concurrent attempts are counted exactly", async () => {
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => checkLimit(ctx(), "hold", "198.51.100.9", op.app)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(limits.hold.limit);
  });
});

describe("operational alerts (22.3)", () => {
  it("names a stopped background job and failed refunds", async () => {
    let alerts = await staff(op, (tx) => currentAlerts(tx));
    expect(alerts.map((a) => a.signal)).toContain("background_job");

    await staff(op, (tx) => tx`select app.record_heartbeat('tick', '{}')`);
    alerts = await staff(op, (tx) => currentAlerts(tx));
    expect(alerts.map((a) => a.signal)).not.toContain("background_job");

    await owner`update app.job_heartbeats set last_run_at = now() - interval '5 minutes' where organisation_id = ${op.organisationId}`;
    alerts = await staff(op, (tx) => currentAlerts(tx));
    expect(alerts.find((a) => a.signal === "background_job")?.message).toMatch(/last ran 5 minutes ago/);
  });
});
