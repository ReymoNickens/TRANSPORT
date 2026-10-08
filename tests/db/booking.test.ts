import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { createSql, withOrganisation, type Tx } from "@/lib/db";
import { FAKE_PROVIDER_SECRET, FakePaymentProvider, fakeChargeEvent } from "@/providers/payments/fake";
import { signBody } from "@/providers/payments/signature";
import { FakeSmsProvider } from "@/providers/sms/fake";
import { createConcession, createFee } from "@/server/fares";
import { createOneOffJourney, publishJourney } from "@/server/journeys";
import { getBooking, holdSeats, holdInput } from "@/server/bookings";
import { applyPaymentResult, receiveCallback, startPayment } from "@/server/payments";
import { sendDueMessages } from "@/server/messages";
import { idempotent } from "@/lib/api/idempotency";
import { credentialSecrets, sha256 } from "@/server/credentials";
import { createLayout, createVehicle, createVehicleInput, publishLayout } from "@/server/fleet";
import { as, daysFromToday, liveCorridor, type Operator } from "./fixtures";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";

const TICKET_SECRET = process.env.TICKET_TOKEN_SECRET!;
const provider = new FakePaymentProvider("https://transport.test");

let owner: Sql;
let wide: Sql; // a bigger pool for the concurrency tests
let op: Operator;
let other: Operator;
let journeyId: string;
let stops: { id: string }[];
let seatIds: Map<string, string>;
let phoneCounter = 0;

const nextPhone = () => `+23324${String(1_000_000 + ++phoneCounter).padStart(7, "0")}`;
const ctx = () => ({ organisationId: op.organisationId, correlationId: "test" });

/** Holds seats as a passenger would, through the same service the API uses. */
function hold(seatNumbers: string[], options: { phone?: string; concession?: string | null; reference?: string | null; journey?: string; seatMap?: Map<string, string>; stops?: { id: string }[]; sql?: Sql } = {}) {
  const phone = options.phone ?? nextPhone();
  const map = options.seatMap ?? seatIds;
  const input = holdInput.parse({
    journeyId: options.journey ?? journeyId,
    originStopId: (options.stops ?? stops)[0].id,
    destinationStopId: (options.stops ?? stops)[2].id,
    purchaser: { name: "Ama Mensah", phone },
    seats: seatNumbers.map((n) => ({
      journeySeatId: map.get(n),
      passenger: { fullName: `Passenger ${n}`, phone, concession: options.concession ?? null, concessionReference: options.reference ?? null },
    })),
  });
  return withOrganisation(ctx(), (tx) => holdSeats(tx, input, { userId: null, address: null, source: "passenger_app" }), options.sql ?? op.app);
}

async function bookingByReference(reference: string) {
  const [row] = await owner`select id, state, total_pesewas, expires_at, first_held_at from app.bookings where reference = ${reference}`;
  return row as { id: string; state: string; total_pesewas: string; expires_at: Date | null; first_held_at: Date };
}

/** Starts a fake payment and returns the attempt id. */
async function pay(reference: string) {
  const booking = await bookingByReference(reference);
  await startPayment(ctx(), provider, booking.id, { method: "any" }, op.app);
  const [attempt] = await owner`select id, amount_pesewas, currency from app.payment_attempts where booking_id = ${booking.id} order by started_at desc limit 1`;
  return { bookingId: booking.id, attemptId: attempt.id as string, amount: Number(attempt.amount_pesewas), currency: attempt.currency as string };
}

function success(amount: number, currency = "GHS", fee = 0) {
  return { status: "success", amountPesewas: amount, currency, providerFeePesewas: fee, providerReference: null };
}

/** Makes a booking's hold end now, as if its time had passed. */
async function expireNow(bookingId: string) {
  await owner`update app.seat_claims c set expires_at = now() - interval '1 second'
              from app.booked_seats s where s.booking_id = ${bookingId} and c.booked_seat_id = s.id and c.state = 'HELD'`;
  await owner`update app.bookings set expires_at = now() - interval '1 second' where id = ${bookingId}`;
}

async function liveClaims(seatNumber: string, map = seatIds) {
  const [row] = await owner`select count(*)::int as n from app.seat_claims where journey_seat_id = ${map.get(seatNumber)!} and state in ('HELD', 'CONFIRMED')`;
  return row.n as number;
}

async function newJourney(suffix: string, registration: string) {
  const corridor = await liveCorridor(op, suffix);
  // A 2+1 coach with 30 rows (90 seats), so the tests have seats to spare.
  const bus = await as(op, async (tx: Tx) => {
    const vehicle = await createVehicle(tx, op.actorUserId, createVehicleInput.parse({ registration, vehicleType: "coach", capacity: 90 }));
    const layout = await createLayout(tx, op.actorUserId, vehicle.id, { name: "2+1", pattern: { left: 2, right: 1, rows: 30, fullBackRow: false } });
    await publishLayout(tx, layout.id);
    return { vehicleId: vehicle.id };
  });
  const journey = await as(op, (tx: Tx) =>
    createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(2)}T08:00:00Z`, vehicleId: bus.vehicleId }),
  );
  await as(op, (tx: Tx) => publishJourney(tx, journey.id));
  const seats = await owner`select id, seat_number from app.journey_seats where journey_id = ${journey.id}`;
  return { journeyId: journey.id, stops: corridor.stops, seatMap: new Map(seats.map((s) => [s.seat_number as string, s.id as string])) };
}

beforeAll(async () => {
  owner = connectAsOwner();
  wide = createSql(inject("testDatabaseUrl"), { max: 20 });
  const app = connectAsApp();
  const orgA = await createOrganisation(owner);
  const orgB = await createOrganisation(owner);
  op = { app, organisationId: orgA, actorUserId: (await createStaff(owner, orgA, "Operations Manager")).userId };
  other = { app, organisationId: orgB, actorUserId: (await createStaff(owner, orgB, "Operations Manager")).userId };

  const j = await newJourney("bk", "GR-9000-26");
  journeyId = j.journeyId;
  stops = j.stops;
  seatIds = j.seatMap;
  await as(op, (tx: Tx) => createConcession(tx, op.actorUserId, { name: "Student", code: "student", discountKind: "percent", discountBasisPoints: 1_000, requiresReference: true, checkAtBoarding: true }));
  await as(op, (tx: Tx) => createFee(tx, op.actorUserId, { name: "Booking fee", category: "booking_fee", calculation: "fixed", amountPesewas: 150, appliesTo: "online" }));
});

afterAll(async () => {
  await owner.end();
  await wide.end();
  await op.app.end();
});

describe("holds (11.3, 11.3a, 24.2)", () => {
  it("concurrent hold: 100 simultaneous requests for one seat give exactly one success", async () => {
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => hold(["5A"], { sql: wide })));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const refusals = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as { message: string }).message);
    expect(refusals.every((m) => /seat 5A was just taken|changed by someone else/.test(m))).toBe(true);
    expect(await liveClaims("5A")).toBe(1);
  });

  it("concurrent multi-seat holds never produce a partial hold", async () => {
    const pairs = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? ["6A", "6B"] : ["6B", "6C"]));
    const results = await Promise.allSettled(pairs.map((seats) => hold(seats, { sql: wide })));
    const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof hold>>> => r.status === "fulfilled");
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (const winner of winners) {
      const [row] = await owner`select count(*)::int as n from app.booked_seats s join app.bookings b on b.id = s.booking_id where b.reference = ${winner.value.reference}`;
      expect(row.n).toBe(2);
    }
    for (const seat of ["6A", "6B", "6C"]) expect(await liveClaims(seat)).toBeLessThanOrEqual(1);
    expect(await liveClaims("6B")).toBe(1);
  });

  it("a new hold succeeds over an expired hold that was not yet released", async () => {
    const first = await hold(["7A"]);
    const old = await bookingByReference(first.reference);
    await expireNow(old.id);
    const second = await hold(["7A"]);
    expect(second.reference).not.toBe(first.reference);
    const [claim] = await owner`select c.state, c.release_reason from app.seat_claims c join app.booked_seats s on s.id = c.booked_seat_id where s.booking_id = ${old.id}`;
    expect(claim).toMatchObject({ state: "RELEASED", release_reason: "expired" });
    expect((await bookingByReference(first.reference)).state).toBe("EXPIRED");
  });

  it("enforces the seat and open-hold limits (D6, D7)", async () => {
    const phone = nextPhone();
    await expect(hold(["8A", "8B", "8C", "9A", "9B", "9C", "10C"], { phone })).rejects.toMatchObject({ message: expect.stringMatching(/1 to 6 seats/) });
    await hold(["8A"], { phone });
    await hold(["8B"], { phone });
    await expect(hold(["8C"], { phone })).rejects.toMatchObject({ message: expect.stringMatching(/already have 2 unpaid bookings/) });
  });

  it("returns the same booking for a repeated idempotency key, and refuses a changed request", async () => {
    const key = randomUUID();
    const input = { seats: ["10A"] };
    const once = () =>
      withOrganisation(ctx(), (tx) => idempotent(tx, { organisationId: op.organisationId, operation: "hold_seats", key, request: input }, () =>
        holdSeats(tx, holdInput.parse({
          journeyId, originStopId: stops[0].id, destinationStopId: stops[2].id,
          purchaser: { name: "Kofi", phone: "+233241111222" },
          seats: [{ journeySeatId: seatIds.get("10A"), passenger: { fullName: "Kofi", phone: "+233241111222" } }],
        }), { userId: null, address: null, source: "passenger_app" })), op.app);
    const first = await once();
    const again = await once();
    expect(again.replayed).toBe(true);
    expect(again.result.reference).toBe(first.result.reference);
    await expect(
      withOrganisation(ctx(), (tx) => idempotent(tx, { organisationId: op.organisationId, operation: "hold_seats", key, request: { seats: ["10B"] } }, async () => null), op.app),
    ).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });
});

describe("prices (13.4a)", () => {
  it("prices from the server in the fixed order, and the stored total, seats and ledger agree to the pesewa", async () => {
    const held = await hold(["11A", "11B"], { concession: "student", reference: "UG10012345" });
    // 8000 − 10% = 7200 per seat; 150 booking fee once.
    expect(held.totalPesewas).toBe(7_200 * 2 + 150);
    const { attemptId, amount, currency } = await pay(held.reference);
    await applyPaymentResult(ctx(), attemptId, success(amount, currency), op.app);
    const booking = await bookingByReference(held.reference);
    const [seats] = await owner`select sum(amount_pesewas)::bigint as total from app.booked_seats where booking_id = ${booking.id}`;
    const [ledger] = await owner`select -sum(amount_pesewas)::bigint as credited from app.ledger_entries where booking_id = ${booking.id} and account = 'DEFERRED_FARES'`;
    const [breakdown] = await owner`select (price_breakdown ->> 'totalPesewas')::bigint as total from app.bookings where id = ${booking.id}`;
    expect(Number(seats.total)).toBe(held.totalPesewas);
    expect(Number(ledger.credited)).toBe(held.totalPesewas);
    expect(Number(breakdown.total)).toBe(held.totalPesewas);
  });

  it("refuses a booked seat whose base fare differs from the journey's fare snapshot", async () => {
    const held = await hold(["11C"]);
    const booking = await bookingByReference(held.reference);
    const [seat] = await owner`select * from app.booked_seats where booking_id = ${booking.id}`;
    await expect(owner`
      insert into app.booked_seats (organisation_id, booking_id, journey_id, route_id, journey_seat_id, passenger_id, origin_stop_id,
                                    destination_stop_id, seat_type, base_pesewas, amount_pesewas)
      values (${seat.organisation_id}, ${seat.booking_id}, ${seat.journey_id}, ${seat.route_id}, ${seatIds.get("12C")!}, ${seat.passenger_id},
              ${seat.origin_stop_id}, ${seat.destination_stop_id}, 'standard', 100, 100)`).rejects.toMatchObject({ code: "BR001", message: expect.stringMatching(/price has changed/) });
  });

  it("concession expiry: an expired student verification is not used; declaring the number again re-verifies", async () => {
    const phone = nextPhone();
    await hold(["12A"], { phone, concession: "student", reference: "UG555" });
    await owner`update app.concession_verifications set expires_at = now() - interval '1 second', verified_at = now() - interval '2 days' where phone = ${phone}`;
    await expect(hold(["12B"], { phone, concession: "student" })).rejects.toMatchObject({ message: expect.stringMatching(/Enter the student number/) });
    const again = await hold(["12B"], { phone, concession: "student", reference: "UG555" });
    expect(again.totalPesewas).toBe(7_200 + 150);
    const rows = await owner`select status from app.concession_verifications where phone = ${phone} order by verified_at`;
    expect(rows.map((r) => r.status)).toEqual(["EXPIRED", "VALID"]);
  });
});

describe("payments and callbacks (12.1, 13.3, 24.2)", () => {
  it("extends the hold while paying, never beyond 20 minutes from first selection (D3)", async () => {
    const held = await hold(["13A"]);
    const { bookingId } = await pay(held.reference);
    const booking = await bookingByReference(held.reference);
    expect(booking.state).toBe("PAYMENT_PENDING");
    const extendedBy = (booking.expires_at!.getTime() - booking.first_held_at.getTime()) / 60_000;
    expect(extendedBy).toBeGreaterThanOrEqual(9.9);
    expect(extendedBy).toBeLessThanOrEqual(20);
    expect(bookingId).toBe(booking.id);
  });

  it("replayed callback: the same callback delivered 1,000 times gives one confirmation, one set of tickets and one ledger posting", async () => {
    const held = await hold(["14A", "14B"]);
    const { bookingId, attemptId, amount, currency } = await pay(held.reference);
    const rawBody = JSON.stringify(fakeChargeEvent(attemptId, "success", amount, currency));
    const headers = new Headers({ "x-paystack-signature": signBody(FAKE_PROVIDER_SECRET, rawBody) });
    for (let batch = 0; batch < 50; batch++) {
      await Promise.all(Array.from({ length: 20 }, () => receiveCallback(ctx(), provider, rawBody, headers, wide)));
    }
    const [counts] = await owner`
      select (select count(*)::int from app.payments where booking_id = ${bookingId}) as payments,
             (select count(*)::int from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id where s.booking_id = ${bookingId}) as tickets,
             (select count(distinct posting_id)::int from app.ledger_entries where booking_id = ${bookingId}) as postings,
             (select count(*)::int from app.webhook_events where provider_event_id = ${`charge.success:fake-${attemptId}-success`}) as events,
             (select count(*)::int from app.outbox where payload ->> 'bookingId' = ${bookingId}) as messages`;
    expect(counts).toEqual({ payments: 1, tickets: 2, postings: 1, events: 1, messages: 1 });
    expect((await bookingByReference(held.reference)).state).toBe("CONFIRMED");
  });

  it("refuses a callback with a bad signature", async () => {
    const result = await receiveCallback(ctx(), provider, JSON.stringify(fakeChargeEvent(randomUUID(), "success", 1, "GHS")), new Headers({ "x-paystack-signature": "00ff" }), op.app);
    expect(result).toEqual({ stored: false, outcome: "rejected" });
  });

  it("callback orderings: success, pending and failure in any order end confirmed", async () => {
    const orders = [
      ["success", "pending", "failed"], ["success", "failed", "pending"], ["pending", "success", "failed"],
      ["pending", "failed", "success"], ["failed", "success", "pending"], ["failed", "pending", "success"],
    ];
    const rows = ["15", "16", "17", "18", "19", "20"];
    for (const [i, order] of orders.entries()) {
      const held = await hold([`${rows[i]}A`]);
      const { attemptId, amount, currency } = await pay(held.reference);
      for (const status of order) {
        await applyPaymentResult(ctx(), attemptId, status === "success" ? success(amount, currency) : { status, amountPesewas: null, currency: null, providerFeePesewas: 0, providerReference: null }, op.app);
      }
      const booking = await bookingByReference(held.reference);
      const [attempt] = await owner`select state from app.payment_attempts where id = ${attemptId}`;
      expect({ order: order.join(">"), booking: booking.state, attempt: attempt.state }).toEqual({ order: order.join(">"), booking: "CONFIRMED", attempt: "SUCCEEDED" });
    }
  });

  it("a failed payment returns the booking to waiting, keeping the hold's expiry", async () => {
    const held = await hold(["21A"]);
    const { attemptId } = await pay(held.reference);
    const before = await bookingByReference(held.reference);
    await applyPaymentResult(ctx(), attemptId, { status: "failed", amountPesewas: null, currency: null, providerFeePesewas: 0, providerReference: null }, op.app);
    const after = await bookingByReference(held.reference);
    expect(after.state).toBe("PENDING");
    expect(after.expires_at!.getTime()).toBe(before.expires_at!.getTime());
  });

  it("a mismatched amount never confirms, and opens a critical exception", async () => {
    const held = await hold(["21B"]);
    const { bookingId, attemptId, amount } = await pay(held.reference);
    const outcome = await applyPaymentResult(ctx(), attemptId, success(amount - 1), op.app);
    expect(outcome).toBe("amount_mismatch");
    expect((await bookingByReference(held.reference)).state).toBe("PAYMENT_PENDING");
    const [exception] = await owner`select kind, severity from app.exceptions where booking_id = ${bookingId}`;
    expect(exception).toEqual({ kind: "payment_amount_mismatch", severity: "critical" });
  });

  it("a second successful attempt is refunded automatically as a duplicate", async () => {
    const held = await hold(["21C"]);
    const first = await pay(held.reference);
    await applyPaymentResult(ctx(), first.attemptId, { status: "failed", amountPesewas: null, currency: null, providerFeePesewas: 0, providerReference: null }, op.app);
    const second = await pay(held.reference);
    await applyPaymentResult(ctx(), second.attemptId, success(second.amount), op.app);
    // The first attempt's money arrives after all.
    const outcome = await applyPaymentResult(ctx(), first.attemptId, success(first.amount), op.app);
    expect(outcome).toBe("duplicate_payment_refunded");
    const refunds = await owner`select kind, state, amount_pesewas from app.refunds where booking_id = ${first.bookingId}`;
    expect(refunds.map((r) => [r.kind, r.state, Number(r.amount_pesewas)])).toEqual([["duplicate_payment", "APPROVED", first.amount]]);
  });
});

describe("late success (12.4, 24.2)", () => {
  it("confirms the same seat when it is still free", async () => {
    const held = await hold(["22A"]);
    const { bookingId, attemptId, amount } = await pay(held.reference);
    await expireNow(bookingId);
    await owner`select app.expire_holds()`;
    expect((await bookingByReference(held.reference)).state).toBe("EXPIRED");
    expect(await applyPaymentResult(ctx(), attemptId, success(amount), op.app)).toBe("confirmed_late");
    const view = await withOrganisation(ctx(), (tx) => getBooking(tx, bookingId, TICKET_SECRET), op.app);
    expect(view.state).toBe("CONFIRMED");
    expect(view.seats[0].seatNumber).toBe("22A");
  });

  it("re-seats to a free seat of the same class when the seat was sold, and opens a critical exception", async () => {
    const a = await hold(["23A"]);
    const { bookingId, attemptId, amount } = await pay(a.reference);
    await expireNow(bookingId);
    const b = await hold(["23A"]); // Student B buys seat 23A meanwhile.
    const bPaid = await pay(b.reference);
    await applyPaymentResult(ctx(), bPaid.attemptId, success(bPaid.amount), op.app);

    expect(await applyPaymentResult(ctx(), attemptId, success(amount), op.app)).toBe("confirmed_reseated");
    const view = await withOrganisation(ctx(), (tx) => getBooking(tx, bookingId, TICKET_SECRET), op.app);
    expect(view.state).toBe("CONFIRMED");
    expect(view.seats[0].seatNumber).not.toBe("23A");
    expect(view.seats[0].seatType).toBe("standard");
    expect(await liveClaims("23A")).toBe(1);
    const [exception] = await owner`select kind, severity from app.exceptions where booking_id = ${bookingId}`;
    expect(exception).toEqual({ kind: "payment_after_seat_released", severity: "critical" });
    const [message] = await owner`select event_type from app.outbox where payload ->> 'bookingId' = ${bookingId}`;
    expect(message.event_type).toBe("late_payment_reseated");
  });

  it("refunds in full when no seat of the same class is free", async () => {
    const small = await newJourney("late3", "GR-9001-26");
    // Leave one free seat only, then let A's hold lapse and B buy that seat.
    await owner`update app.journey_seats set state = 'BLOCKED' where journey_id = ${small.journeyId} and seat_number <> '1A'`;
    const a = await hold(["1A"], { journey: small.journeyId, seatMap: small.seatMap, stops: small.stops });
    const { bookingId, attemptId, amount } = await pay(a.reference);
    await expireNow(bookingId);
    const b = await hold(["1A"], { journey: small.journeyId, seatMap: small.seatMap, stops: small.stops });
    expect(b.reference).toBeTruthy();

    expect(await applyPaymentResult(ctx(), attemptId, success(amount), op.app)).toBe("refunded_late");
    expect((await bookingByReference(a.reference)).state).toBe("EXPIRED");
    const [refund] = await owner`select kind, state, amount_pesewas from app.refunds where booking_id = ${bookingId}`;
    expect([refund.kind, refund.state, Number(refund.amount_pesewas)]).toEqual(["late_payment", "APPROVED", amount]);
    const [payment] = await owner`select refunded_pesewas from app.payments where booking_id = ${bookingId}`;
    expect(Number(payment.refunded_pesewas)).toBe(amount);
    const [message] = await owner`select event_type from app.outbox where payload ->> 'bookingId' = ${bookingId}`;
    expect(message.event_type).toBe("late_payment_refunded");
    const view = await withOrganisation(ctx(), (tx) => getBooking(tx, bookingId, TICKET_SECRET), op.app);
    expect(view.displayStatus).toBe("Expired, refund on its way");
  });

  it("late payment against a sale: A's late success racing B's purchase leaves exactly one holder", async () => {
    for (let round = 0; round < 5; round++) {
      const seat = `${24 + round}A`;
      const a = await hold([seat]);
      const { bookingId, attemptId, amount } = await pay(a.reference);
      await expireNow(bookingId);
      const [late, sale] = await Promise.allSettled([
        applyPaymentResult(ctx(), attemptId, success(amount), wide),
        hold([seat], { sql: wide }),
      ]);
      expect(late.status).toBe("fulfilled");
      expect(await liveClaims(seat)).toBe(1);
      const outcome = (late as PromiseFulfilledResult<string>).value;
      // If B went first, A's lapsed hold was released and A is re-seated or refunded.
      // If A went first, A's seat was never released and A simply keeps it.
      if (sale.status === "fulfilled") expect(["confirmed_reseated", "refunded_late"]).toContain(outcome);
      else expect(["confirmed", "confirmed_late"]).toContain(outcome);
    }
  });
});

describe("money integrity (11.8, 24.2)", () => {
  it("excess refund: refunds totalling more than the payment are refused, even concurrently", async () => {
    const held = await hold(["29A"]);
    const { bookingId, attemptId, amount } = await pay(held.reference);
    await applyPaymentResult(ctx(), attemptId, success(amount), op.app);
    const [payment] = await owner`select id from app.payments where booking_id = ${bookingId}`;
    const half = Math.ceil(amount / 2) + 1;
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => withOrganisation(ctx(), (tx) => tx`select app.create_system_refund(${payment.id}, 'goodwill', ${half}, 'Test refund')`, wide)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [after] = await owner`select refunded_pesewas, amount_pesewas from app.payments where id = ${payment.id}`;
    expect(Number(after.refunded_pesewas)).toBeLessThanOrEqual(Number(after.amount_pesewas));
  });

  it("keeps the ledger and sold prices immutable, and every posting balanced", async () => {
    await expect(owner`update app.ledger_entries set amount_pesewas = amount_pesewas + 1`).rejects.toThrow(/append-only/);
    await expect(owner`update app.booked_seats set amount_pesewas = 1`).rejects.toMatchObject({ code: "BR001" });
    const [unbalanced] = await owner`select count(*)::int as n from (select posting_id from app.ledger_entries group by posting_id having sum(amount_pesewas) <> 0) x`;
    expect(unbalanced.n).toBe(0);
    await expect(owner.begin(async (tx) => {
      await tx`insert into app.ledger_entries (organisation_id, posting_id, account, amount_pesewas, currency, description)
               values (${op.organisationId}, ${randomUUID()}, 'BANK', 100, 'GHS', 'one-sided')`;
    })).rejects.toThrow(/does not balance/);
  });

  it("cross-organisation reference: a booking for another organisation's journey is refused by the database", async () => {
    const otherHold = withOrganisation({ organisationId: other.organisationId, correlationId: "test" }, (tx) =>
      holdSeats(tx, holdInput.parse({
        journeyId, originStopId: stops[0].id, destinationStopId: stops[2].id,
        purchaser: { name: "Intruder", phone: "+233240000001" },
        seats: [{ journeySeatId: seatIds.get("30A"), passenger: { fullName: "Intruder", phone: "+233240000001" } }],
      }), { userId: null, address: null, source: "passenger_app" }), op.app);
    await expect(otherHold).rejects.toMatchObject({ code: expect.stringMatching(/BR001|rule_violation|23503/) });
    expect(await liveClaims("30A")).toBe(0);
  });
});

describe("tickets and messages (14.1, 14.2, 17)", () => {
  it("issues one ticket per seat with a credential whose secrets are never stored, and texts each traveller once", async () => {
    const phoneA = nextPhone();
    const held = await hold(["3A"], { phone: phoneA });
    const { bookingId, attemptId, amount } = await pay(held.reference);
    await applyPaymentResult(ctx(), attemptId, success(amount), op.app);

    const view = await withOrganisation(ctx(), (tx) => getBooking(tx, bookingId, TICKET_SECRET), op.app);
    const ticket = view.seats[0].ticket!;
    expect(ticket.ticketNumber).toMatch(/^T[2-9A-HJ-NP-Z]{9}$/);
    expect(ticket.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [credential] = await owner`select c.id, c.token_hash from app.ticket_credentials c join app.tickets t on t.id = c.ticket_id where t.ticket_number = ${ticket.ticketNumber}`;
    expect(Buffer.compare(credential.token_hash, sha256(ticket.qrToken!))).toBe(0);
    expect(credentialSecrets(TICKET_SECRET, credential.id).boardingCode).toBe(ticket.boardingCode);

    const sms = new FakeSmsProvider();
    await sendDueMessages(ctx(), sms, { ticketSecret: TICKET_SECRET, baseUrl: "https://transport.test" }, { limit: 100 }, op.app);
    const mine = sms.sent.filter((m) => m.to === phoneA);
    expect(mine).toHaveLength(1);
    expect(mine[0].message).toContain(held.reference);
    expect(mine[0].message).toContain(ticket.boardingCode);
    expect(mine[0].message).not.toContain(ticket.qrToken!);

    await sendDueMessages(ctx(), sms, { ticketSecret: TICKET_SECRET, baseUrl: "https://transport.test" }, { limit: 100 }, op.app);
    expect(sms.sent.filter((m) => m.to === phoneA)).toHaveLength(1);
  });

  it("hides the QR token and boarding code until the booking is confirmed", async () => {
    const held = await hold(["4A"]);
    const booking = await bookingByReference(held.reference);
    const view = await withOrganisation(ctx(), (tx) => getBooking(tx, booking.id, TICKET_SECRET), op.app);
    expect(view.displayStatus).toBe("Waiting to pay");
    expect(view.seats[0].ticket).toBeNull();
  });
});
