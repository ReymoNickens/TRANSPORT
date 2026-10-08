import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@/lib/db";
import { withOrganisation } from "@/lib/db";
import { FakePaymentProvider } from "@/providers/payments/fake";
import { holdInput, holdSeats } from "@/server/bookings";
import { cancellationQuote, cancelSeats, journeyCancellationPreview, policyText } from "@/server/cancellations";
import { cancelJourney } from "@/server/journeys";
import { applyPaymentResult, startPayment } from "@/server/payments";
import {
  approveRefund,
  checkProcessingRefunds,
  confirmManualRefund,
  processDueRefunds,
  recordManualRefund,
  rejectRefund,
  requestRefund,
  retryRefund,
} from "@/server/refunds";
import type { Operator } from "./fixtures";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";
import { staff, trips, type Ticket, type Trip } from "./trips";

const provider = new FakePaymentProvider("https://transport.test");

let owner: Sql;
let op: Operator;
let finance: Operator;
let finance2: Operator;
let helpers: ReturnType<typeof trips>;
const ctx = () => ({ organisationId: op.organisationId, correlationId: "test" });

/** A trip leaving `hours` from now, on sale. */
function tripIn(hours: number, suffix: string, registration: string) {
  const at = new Date(Date.now() + hours * 3_600_000);
  at.setUTCSeconds(0, 0);
  return helpers.newTrip(suffix, registration, undefined, undefined, at.toISOString());
}

const refundsOf = (bookingId: string) =>
  owner`select id, kind, state, amount_pesewas::int as amount, route, attempts, booked_seat_id from app.refunds where booking_id = ${bookingId} order by requested_at`;

async function seatState(ticket: Ticket) {
  const [row] = await owner`
    select s.state as seat, t.state as ticket, b.state as booking,
           (select count(*)::int from app.ticket_credentials c where c.ticket_id = t.id and c.revoked_at is null) as live_credentials,
           (select count(*)::int from app.seat_claims c where c.booked_seat_id = s.id and c.state in ('HELD', 'CONFIRMED')) as live_claims
    from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id join app.bookings b on b.id = s.booking_id
    where t.id = ${ticket.id}`;
  return row;
}

async function outbox(bookingId: string) {
  const rows = await owner`select event_type from app.outbox where payload ->> 'bookingId' = ${bookingId} order by created_at`;
  return rows.map((r) => r.event_type as string);
}

beforeAll(async () => {
  owner = connectAsOwner();
  const app = connectAsApp();
  const org = await createOrganisation(owner);
  op = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Operations Manager")).userId };
  finance = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Finance")).userId };
  finance2 = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Finance")).userId };
  helpers = trips(op, owner, "23");
});

afterAll(async () => {
  await owner.end();
  await op.app.end();
});

describe("the refund policy (16.1, D14)", () => {
  it("is shown in plain words", () => {
    expect(policyText({ bands: [
      { min_hours_before: 24, refund_percent: 100, deduct_provider_fee: true },
      { min_hours_before: 6, refund_percent: 50, deduct_provider_fee: false },
      { min_hours_before: 0, refund_percent: 0, deduct_provider_fee: false },
    ], operator_cancellation_percent: 100 })).toEqual([
      "Cancel 24 hours or more before departure: the full fare, less the payment provider's fee.",
      "Cancel 6 to 24 hours before departure: 50% of the fare.",
      "Cancel under 6 hours before departure: no refund.",
      "If we cancel the journey: 100% back, including fees, automatically.",
    ]);
  });

  it("24 hours or more: the fare less this seat's share of the provider fee", async () => {
    const trip = await tripIn(72, "rf1", "GR-3301-26");
    const [a, b] = await helpers.bookAndPay(trip, ["1A", "1B"]);
    // Paystack charged 2.00 on the whole payment; each of the two equal seats carries 1.00 of it.
    await owner`update app.payments set provider_fee_pesewas = 200 where booking_id = ${a.bookingId}`;
    const quote = await staff(op, (tx) => cancellationQuote(tx, a.bookingId));
    expect(quote.hoursBefore).toBeGreaterThan(71);
    // The fare is 80.00; the booking fee is not refunded when the passenger cancels.
    expect(quote.seats.map((s) => [s.seatNumber, s.amountPesewas, s.percent, s.feeDeductedPesewas])).toEqual([["1A", 7_900, 100, 100], ["1B", 7_900, 100, 100]]);
    expect(quote.totalRefundPesewas).toBe(15_800);
    void b;
  });

  it("6 to 24 hours: half the fare; under 6 hours: nothing back but the seat is freed", async () => {
    const half = await tripIn(12, "rf2", "GR-3302-26");
    const [h] = await helpers.bookAndPay(half, ["2A"]);
    expect((await staff(op, (tx) => cancellationQuote(tx, h.bookingId))).seats[0]).toMatchObject({ allowed: true, amountPesewas: 4_000, percent: 50 });

    const late = await tripIn(3, "rf3", "GR-3303-26");
    const [l] = await helpers.bookAndPay(late, ["2A"]);
    const result = await staff(op, (tx) => cancelSeats(tx, l.bookingId, {}));
    expect(result).toEqual({ cancelledSeats: ["2A"], refundPesewas: 0 });
    expect(await refundsOf(l.bookingId)).toHaveLength(0);
    expect((await seatState(l)).booking).toBe("CANCELLED");
  });

  it("a booking keeps the policy it was sold under", async () => {
    const trip = await tripIn(48, "rf4", "GR-3304-26");
    const [t] = await helpers.bookAndPay(trip, ["3A"]);
    await owner`update app.settings set value = '{"bands":[{"min_hours_before":0,"refund_percent":0,"deduct_provider_fee":false}]}'
                where organisation_id = ${op.organisationId} and key = 'refund.policy'`;
    try {
      expect((await staff(op, (tx) => cancellationQuote(tx, t.bookingId))).seats[0].percent).toBe(100);
      await expect(owner`update app.bookings set refund_policy = '{}' where id = ${t.bookingId}`).rejects.toThrow(/keeps the refund policy/);
    } finally {
      await owner`update app.settings s set value = d.default_value from app.setting_definitions d
                  where s.organisation_id = ${op.organisationId} and s.key = 'refund.policy' and d.key = s.key`;
    }
  });
});

describe("cancelling seats (16.2)", () => {
  let trip: Trip;
  let a: Ticket;
  let b: Ticket;
  beforeAll(async () => {
    trip = await tripIn(72, "rf5", "GR-3305-26");
    [a, b] = await helpers.bookAndPay(trip, ["4A", "4B"]);
  });

  it("cancelling one seat cancels its ticket at once and puts the seat back on sale; the booking stays confirmed", async () => {
    const result = await staff(op, (tx) => cancelSeats(tx, a.bookingId, { seatNumbers: ["4A"] }));
    expect(result).toEqual({ cancelledSeats: ["4A"], refundPesewas: 8_000 });
    expect(await seatState(a)).toMatchObject({ seat: "CANCELLED", ticket: "CANCELLED", booking: "CONFIRMED", live_credentials: 0, live_claims: 0 });
    expect(await seatState(b)).toMatchObject({ seat: "CONFIRMED", ticket: "VALID", live_credentials: 1 });

    const [refund] = await refundsOf(a.bookingId);
    expect(refund).toMatchObject({ kind: "passenger_cancellation", state: "APPROVED", amount: 8_000 });
    expect(await outbox(a.bookingId)).toEqual(expect.arrayContaining(["booking_cancelled", "refund_started"]));

    // Someone else can now book 4A.
    const input = holdInput.parse({
      journeyId: trip.journeyId, originStopId: trip.stops[0].id, destinationStopId: trip.stops[2].id,
      purchaser: { name: "Kwame", phone: "+233201112223" },
      seats: [{ journeySeatId: trip.seatMap.get("4A"), passenger: { fullName: "Kwame", phone: "+233201112223" } }],
    });
    const held = await withOrganisation(ctx(), (tx) => holdSeats(tx, input, { userId: null, address: null, source: "passenger_app" }), op.app);
    expect(held.reference).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
  });

  it("the same seat cannot be cancelled or refunded twice", async () => {
    await expect(staff(op, (tx) => cancelSeats(tx, a.bookingId, { seatNumbers: ["4A"] }))).rejects.toThrow(/already cancelled/);
    expect(await refundsOf(a.bookingId)).toHaveLength(1);
  });

  it("cancelling the last seat cancels the booking", async () => {
    await staff(op, (tx) => cancelSeats(tx, a.bookingId, {}));
    expect((await seatState(b)).booking).toBe("CANCELLED");
  });

  it("the refund is paid through the provider, and the passenger is told", async () => {
    provider.refundBehaviour = "processed";
    const sent = await processDueRefunds(ctx(), provider, {}, op.app);
    expect(sent.refundsSent).toBeGreaterThanOrEqual(2);
    const refunds = await refundsOf(a.bookingId);
    expect(refunds.every((r) => r.state === "COMPLETED" && r.route === "paystack_refund")).toBe(true);
    expect(await outbox(a.bookingId)).toEqual(expect.arrayContaining(["refund_completed"]));
    const [payment] = await owner`select refunded_pesewas::int as refunded from app.payments where booking_id = ${a.bookingId}`;
    expect(payment.refunded).toBe(16_000);
    // Refunds payable is cleared for this booking: approved then paid.
    const [ledger] = await owner`select coalesce(sum(amount_pesewas), 0)::int as balance from app.ledger_entries
                                 where account = 'REFUNDS_PAYABLE' and booking_id = ${a.bookingId}`;
    expect(ledger.balance).toBe(0);
  });
});

describe("cancelling a journey (15.2)", () => {
  it("previews, refuses the shortcut, then refunds every passenger in full including fees", async () => {
    const trip = await tripIn(30, "rf6", "GR-3306-26");
    const [x] = await helpers.bookAndPay(trip, ["5A", "5B"]);
    const [y] = await helpers.bookAndPay(trip, ["6A"]);
    // An unpaid hold that is part-way through paying.
    const input = holdInput.parse({
      journeyId: trip.journeyId, originStopId: trip.stops[0].id, destinationStopId: trip.stops[2].id,
      purchaser: { name: "Esi", phone: "+233209998887" },
      seats: [{ journeySeatId: trip.seatMap.get("7A"), passenger: { fullName: "Esi", phone: "+233209998887" } }],
    });
    const held = await withOrganisation(ctx(), (tx) => holdSeats(tx, input, { userId: null, address: null, source: "passenger_app" }), op.app);
    const [heldBooking] = await owner`select id from app.bookings where reference = ${held.reference}`;
    await startPayment(ctx(), provider, heldBooking.id, { method: "any" }, op.app);

    const preview = await staff(op, (tx) => journeyCancellationPreview(tx, trip.journeyId));
    // Each seat: the 80.00 fare plus its share of the 1.50 booking fee.
    expect(preview).toMatchObject({ passengers: 3, bookings: 2, unpaidHolds: 1 });
    const [totals] = await owner`select sum(total_pesewas)::int as total from app.bookings where id in (${x.bookingId}, ${y.bookingId})`;
    expect(preview.refundTotalPesewas).toBe(totals.total);
    expect(preview.messageTemplate).toContain("is cancelled: {reason}");

    await expect(owner`select app.move_journey(${trip.journeyId}, 'CANCELLED', 'shortcut')`).rejects.toThrow(/has passengers/);

    await staff(op, (tx) => cancelJourney(tx, trip.journeyId, { reason: "The bus has broken down" }), { reason: "The bus has broken down" });
    const [journey] = await owner`select state from app.journeys where id = ${trip.journeyId}`;
    expect(journey.state).toBe("CANCELLED");
    for (const bookingId of [x.bookingId, y.bookingId]) {
      const [booking] = await owner`select state, total_pesewas::int as total from app.bookings where id = ${bookingId}`;
      expect(booking.state).toBe("CANCELLED");
      const refunds = await refundsOf(bookingId);
      expect(refunds.every((r) => r.kind === "operator_cancellation" && r.state === "APPROVED")).toBe(true);
      expect(refunds.reduce((sum, r) => sum + r.amount, 0)).toBe(booking.total);
      expect(await outbox(bookingId)).toEqual(expect.arrayContaining(["journey_cancelled"]));
    }
    const [unpaid] = await owner`select state from app.bookings where id = ${heldBooking.id}`;
    expect(unpaid.state).toBe("EXPIRED");

    // The unpaid passenger's money arrives after all: it is refunded, never a seat on a cancelled bus.
    const [attempt] = await owner`select id, amount_pesewas::int as amount from app.payment_attempts where booking_id = ${heldBooking.id}`;
    const outcome = await applyPaymentResult(ctx(), attempt.id, { status: "success", amountPesewas: attempt.amount, currency: "GHS", providerFeePesewas: 0, providerReference: null }, op.app);
    expect(outcome).toBe("refunded_late");
    const [after] = await owner`select state from app.bookings where id = ${heldBooking.id}`;
    expect(after.state).toBe("EXPIRED");
  });
});

describe("refunds decided by people (16.3)", () => {
  let bookingId: string;
  beforeAll(async () => {
    const trip = await tripIn(72, "rf7", "GR-3307-26");
    [{ bookingId }] = await helpers.bookAndPay(trip, ["8A"]);
  });

  it("a goodwill refund needs a second person to approve it", async () => {
    const { id } = await staff(finance, (tx) => requestRefund(tx, bookingId, { amountPesewas: 1_000, reason: "Bus was very late", kind: "goodwill" }));
    await expect(staff(finance, (tx) => approveRefund(tx, id))).rejects.toThrow(/someone other than/);
    await staff(finance2, (tx) => approveRefund(tx, id));
    const [refund] = await owner`select state, approved_by from app.refunds where id = ${id}`;
    expect(refund).toMatchObject({ state: "APPROVED", approved_by: finance2.actorUserId });
  });

  it("can be turned down", async () => {
    const { id } = await staff(finance, (tx) => requestRefund(tx, bookingId, { amountPesewas: 500, reason: "Asked for a discount", kind: "goodwill" }));
    await staff(finance2, (tx) => rejectRefund(tx, id));
    const [refund] = await owner`select state from app.refunds where id = ${id}`;
    expect(refund.state).toBe("REJECTED");
  });

  it("never returns more than was paid", async () => {
    await expect(staff(finance, (tx) => requestRefund(tx, bookingId, { amountPesewas: 50_000, reason: "Too much", kind: "goodwill" }))).rejects.toThrow(/more than is left/);
  });
});

describe("when the provider cannot pay a refund (16.4, 16.4a)", () => {
  it("a refused refund goes to Finance, who pays by hand; a second person confirms", async () => {
    const trip = await tripIn(72, "rf8", "GR-3308-26");
    const [t] = await helpers.bookAndPay(trip, ["9A"]);
    await staff(op, (tx) => cancelSeats(tx, t.bookingId, {}));
    provider.refundBehaviour = "refused";
    await processDueRefunds(ctx(), provider, {}, op.app);
    const [refund] = await refundsOf(t.bookingId);
    expect(refund.state).toBe("FAILED");
    const [item] = await owner`select kind, severity, state from app.exceptions where dedupe_key = ${`failed_refund:${refund.id}`}`;
    expect(item).toMatchObject({ kind: "failed_refund", severity: "high", state: "OPEN" });

    // Retry: refused again.
    await staff(finance, (tx) => retryRefund(tx, refund.id));
    expect((await refundsOf(t.bookingId))[0].state).toBe("APPROVED");
    await processDueRefunds(ctx(), provider, {}, op.app);
    expect((await refundsOf(t.bookingId))[0].state).toBe("FAILED");

    await staff(finance, (tx) => recordManualRefund(tx, refund.id, { paymentReference: "MOMO-778899", reason: "Paid by MoMo from the office" }));
    await expect(staff(finance, (tx) => confirmManualRefund(tx, refund.id))).rejects.toThrow(/Someone other than/);
    await staff(finance2, (tx) => confirmManualRefund(tx, refund.id));
    const [done] = await owner`select state, route, provider_reference, confirmed_by from app.refunds where id = ${refund.id}`;
    expect(done).toMatchObject({ state: "COMPLETED", route: "manual", provider_reference: "MOMO-778899", confirmed_by: finance2.actorUserId });
    const [closed] = await owner`select state from app.exceptions where dedupe_key = ${`failed_refund:${refund.id}`}`;
    expect(closed.state).toBe("RESOLVED");
  });

  it("an unreachable provider is retried later, then handed to Finance after the last try", async () => {
    const trip = await tripIn(72, "rf9", "GR-3309-26");
    const [t] = await helpers.bookAndPay(trip, ["10A"]);
    await staff(op, (tx) => cancelSeats(tx, t.bookingId, {}));
    await owner`update app.settings set value = '2' where organisation_id = ${op.organisationId} and key = 'refund.max_attempts'`;
    provider.refundBehaviour = "unreachable";
    await processDueRefunds(ctx(), provider, {}, op.app);
    let [refund] = await refundsOf(t.bookingId);
    expect(refund).toMatchObject({ state: "APPROVED", attempts: 1 });
    const [next] = await owner`select next_attempt_at > now() as later from app.refunds where id = ${refund.id}`;
    expect(next.later).toBe(true);
    await owner`update app.refunds set next_attempt_at = now() where id = ${refund.id}`;
    await processDueRefunds(ctx(), provider, {}, op.app);
    [refund] = await refundsOf(t.bookingId);
    expect(refund).toMatchObject({ state: "FAILED", attempts: 2 });
  });

  it("a refund the provider accepts but has not finished is checked until it completes", async () => {
    const trip = await tripIn(72, "rf10", "GR-3310-26");
    const [t] = await helpers.bookAndPay(trip, ["11A"]);
    await staff(op, (tx: Tx) => cancelSeats(tx, t.bookingId, {}));
    provider.refundBehaviour = "pending";
    provider.refundCheckResult = "pending";
    await processDueRefunds(ctx(), provider, {}, op.app);
    expect((await refundsOf(t.bookingId))[0].state).toBe("PROCESSING");
    await checkProcessingRefunds(ctx(), provider, { force: true }, op.app);
    expect((await refundsOf(t.bookingId))[0].state).toBe("PROCESSING");
    provider.refundCheckResult = "processed";
    await checkProcessingRefunds(ctx(), provider, { force: true }, op.app);
    expect((await refundsOf(t.bookingId))[0].state).toBe("COMPLETED");
    provider.refundBehaviour = "processed";
  });
});
