import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePaymentProvider } from "@/providers/payments/fake";
import type { ProviderTransaction } from "@/providers/payments/types";
import { scanTicket, updateJourneyStatus } from "@/server/boarding";
import { cancelSeats } from "@/server/cancellations";
import { cancelJourney } from "@/server/journeys";
import { financeReport, getReconciliationDay, importAndCheckDay, resolveItem, signOffDay } from "@/server/finance";
import { as, daysFromToday, type Operator } from "./fixtures";
import { createFee } from "@/server/fares";
import type { Tx } from "@/lib/db";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";
import { staff, trips, type Ticket, type Trip } from "./trips";

let owner: Sql;
let op: Operator;
let finance: Operator;
let helpers: ReturnType<typeof trips>;
// Reconciliation runs in an organisation of its own, so other tests' payments do not show up in its day.
let recOp: Operator;
let recFinance: Operator;
let recHelpers: ReturnType<typeof trips>;
const today = daysFromToday(0);
const ctx = (who: Operator) => ({ organisationId: who.organisationId, correlationId: "test", actorUserId: who.actorUserId });

function tripIn(hours: number, suffix: string, registration: string) {
  const at = new Date(Date.now() + hours * 3_600_000);
  at.setUTCSeconds(0, 0);
  return helpers.newTrip(suffix, registration, undefined, undefined, at.toISOString());
}

async function balance(account: string, bookingIds: string[]) {
  const [row] = await owner`select coalesce(sum(amount_pesewas), 0)::int as total from app.ledger_entries where account = ${account} and booking_id = any(${bookingIds}::uuid[])`;
  return row.total as number;
}

async function attemptOf(ticket: Ticket) {
  const [row] = await owner`select p.attempt_id::text as reference, p.amount_pesewas::int as amount, p.received_at from app.payments p where p.booking_id = ${ticket.bookingId}`;
  return row as { reference: string; amount: number; received_at: Date };
}

beforeAll(async () => {
  owner = connectAsOwner();
  const org = await createOrganisation(owner);
  const app = connectAsApp();
  op = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Operations Manager")).userId };
  finance = { app, organisationId: org, actorUserId: (await createStaff(owner, org, "Finance")).userId };
  await owner`update app.settings set value = '3000' where organisation_id = ${org} and key = 'boarding.opens_minutes_before'`;
  helpers = trips(op, owner, "25");
  await as(op, (tx: Tx) => createFee(tx, op.actorUserId, { name: "Booking fee", category: "booking_fee", calculation: "fixed", amountPesewas: 150, appliesTo: "online" }));

  const recOrg = await createOrganisation(owner);
  recOp = { app, organisationId: recOrg, actorUserId: (await createStaff(owner, recOrg, "Operations Manager")).userId };
  recFinance = { app, organisationId: recOrg, actorUserId: (await createStaff(owner, recOrg, "Finance")).userId };
  recHelpers = trips(recOp, owner, "26");
});

afterAll(async () => {
  await owner.end();
  await op.app.end();
});

describe("earned revenue (18.2, 18.3a)", () => {
  it("a completed journey moves what each booking holds into fare and fee revenue", async () => {
    const trip: Trip = await tripIn(12, "mn1", "GR-1101-26");
    const [kept] = await helpers.bookAndPay(trip, ["1A"]);
    const [cancelled] = await helpers.bookAndPay(trip, ["2A"]);
    // 6 to 24 hours before: half the 80.00 fare comes back; the rest (and the booking fee) is kept.
    await staff(op, (tx) => cancelSeats(tx, cancelled.bookingId, {}));
    const ids = [kept.bookingId, cancelled.bookingId];
    const held = -(await balance("DEFERRED_FARES", ids));

    await staff(op, (tx) => updateJourneyStatus(tx, trip.journeyId, { to: "BOARDING" }));
    await staff(op, (tx) => scanTicket(tx, trip.journeyId, { token: kept.qr, confirm: true }));
    await staff(op, (tx) => updateJourneyStatus(tx, trip.journeyId, { to: "DEPARTED" }));
    await staff(op, (tx) => updateJourneyStatus(tx, trip.journeyId, { to: "COMPLETED" }));

    expect(await balance("DEFERRED_FARES", ids)).toBe(0);
    const fee = -(await balance("FEE_REVENUE", ids));
    const fare = -(await balance("FARE_REVENUE", ids));
    // The travelling seat's booking fee is fee revenue; everything else held is fare revenue.
    const [seat] = await owner`select fee_share_pesewas::int as fee from app.booked_seats where booking_id = ${kept.bookingId}`;
    expect(fee).toBe(seat.fee);
    expect(fare + fee).toBe(held);
  });

  it("a cancelled journey earns only what was kept under the policy", async () => {
    const trip = await tripIn(12, "mn2", "GR-1102-26");
    const [a] = await helpers.bookAndPay(trip, ["1A"]);
    const [b] = await helpers.bookAndPay(trip, ["2A"]);
    await staff(op, (tx) => cancelSeats(tx, b.bookingId, {}));
    await staff(op, (tx) => cancelJourney(tx, trip.journeyId, { reason: "Road closed by flooding" }), { reason: "Road closed by flooding" });
    expect(await balance("DEFERRED_FARES", [a.bookingId, b.bookingId])).toBe(0);
    // Passenger a was refunded in full: nothing earned. Passenger b kept half the fare and the booking fee.
    expect(await balance("FARE_REVENUE", [a.bookingId])).toBe(0);
    const [paid] = await owner`select total_pesewas::int as total from app.bookings where id = ${b.bookingId}`;
    expect(-(await balance("FARE_REVENUE", [b.bookingId]))).toBe(paid.total - 4_000);
  });
});

describe("reconciling with Paystack (18.4, 18.4a)", () => {
  const provider = new FakePaymentProvider("https://transport.test");
  let tickets: Ticket[];
  let refs: { reference: string; amount: number; received_at: Date }[];

  const txn = (reference: string, amount: number, paidAt: Date, fee = 0, settlementId: string | null = null): ProviderTransaction => ({
    reference, status: "success", amountPesewas: amount, currency: "GHS", feePesewas: fee, channel: "mobile_money", paidAt, settlementId, raw: { reference },
  });

  beforeAll(async () => {
    const at = new Date(Date.now() + 72 * 3_600_000);
    at.setUTCSeconds(0, 0);
    const trip = await recHelpers.newTrip("mn3", "GR-1103-26", undefined, undefined, at.toISOString());
    tickets = [];
    for (const seat of ["5A", "6A", "7A"]) tickets.push(...(await recHelpers.bookAndPay(trip, [seat])));
    refs = await Promise.all(tickets.map(attemptOf));
  });

  it("lists each difference in plain words and raises it for Finance", async () => {
    const stranger = randomUUID();
    provider.transactions = [
      txn(refs[0].reference, refs[0].amount, refs[0].received_at),
      // Paystack charged a fee we did not record.
      txn(refs[1].reference, refs[1].amount, refs[1].received_at, 120),
      // refs[2] is missing at Paystack; and Paystack has a payment we never saw.
      txn(stranger, 5_000, refs[0].received_at),
    ];
    const result = await importAndCheckDay(ctx(recFinance), provider, today, op.app);
    expect(result.openDifferences).toBe(3);
    const day = await staff(recFinance, (tx) => getReconciliationDay(tx, today));
    expect(day.state).toBe("OPEN");
    expect(day.items.map((i) => i.kind).sort()).toEqual(["fee_differs", "paid_at_provider_not_here", "paid_here_not_at_provider"]);
    expect(day.items.find((i) => i.kind === "paid_at_provider_not_here")?.description).toMatch(/^Paid at Paystack but no booking here: GH₵ 50.00/);
    expect(day.items.find((i) => i.kind === "fee_differs")?.differencePesewas).toBe(120);
    const [exception] = await owner`select severity, state from app.exceptions where dedupe_key = ${`reconciliation:${today}`} and organisation_id = ${recOp.organisationId}`;
    expect(exception).toEqual({ severity: "high", state: "OPEN" });

    // Checking again finds the same differences, not new ones.
    await importAndCheckDay(ctx(recFinance), provider, today, op.app);
    const [count] = await owner`select count(*)::int as n from app.reconciliation_items i join app.reconciliation_days d on d.id = i.day_id
                                where d.organisation_id = ${recOp.organisationId} and d.day = ${today}`;
    expect(count.n).toBe(3);
  });

  it("a difference that goes away resolves itself; the rest need a note", async () => {
    provider.transactions.push(txn(refs[2].reference, refs[2].amount, refs[2].received_at));
    await importAndCheckDay(ctx(recFinance), provider, today, op.app);
    let day = await staff(recFinance, (tx) => getReconciliationDay(tx, today));
    const missing = day.items.find((i) => i.kind === "paid_here_not_at_provider")!;
    expect(missing.resolution).toMatch(/Resolved automatically/);

    await expect(staff(recFinance, (tx) => signOffDay(tx, today, {}))).rejects.toThrow(/Resolve every difference/);
    for (const item of day.items.filter((i) => !i.resolution)) {
      await staff(recFinance, (tx) => resolveItem(tx, item.id, { resolution: "Checked with Paystack support, ticket 4471" }));
    }
    day = await staff(recFinance, (tx) => getReconciliationDay(tx, today));
    expect(day.items.every((i) => i.resolution)).toBe(true);
    // Today has not ended yet.
    await expect(staff(recFinance, (tx) => signOffDay(tx, today, {}))).rejects.toThrow(/once it has ended/);
  });

  it("a settlement is posted to the bank once, and checked against its payments", async () => {
    const settled = new Date(`${today}T12:00:00Z`);
    provider.transactions = [txn(refs[0].reference, refs[0].amount, refs[0].received_at)];
    provider.settlements = [
      { id: "SET-1", settledOn: today, currency: "GHS", grossPesewas: refs[0].amount, feesPesewas: 0, refundsPesewas: 0, netPesewas: refs[0].amount, raw: {}, transactionReferences: [refs[0].reference] },
      { id: "SET-2", settledOn: today, currency: "GHS", grossPesewas: 10_000, feesPesewas: 0, refundsPesewas: 0, netPesewas: 9_000, raw: {}, transactionReferences: [] },
    ];
    void settled;
    await importAndCheckDay(ctx(recFinance), provider, today, op.app);
    await importAndCheckDay(ctx(recFinance), provider, today, op.app);
    const bank = await owner`select l.amount_pesewas::int as amount, s.provider_settlement_id as id from app.ledger_entries l
                             join app.provider_settlements s on s.id = l.settlement_id where l.account = 'BANK' and l.organisation_id = ${recOp.organisationId}
                             order by s.provider_settlement_id`;
    expect(bank).toEqual([{ amount: refs[0].amount, id: "SET-1" }, { amount: 9_000, id: "SET-2" }]);
    const day = await staff(recFinance, (tx) => getReconciliationDay(tx, today));
    const differs = day.items.filter((i) => i.kind === "settlement_differs" && !i.resolution);
    expect(differs).toHaveLength(1);
    expect(differs[0].description).toMatch(/Settlement SET-2 paid GH₵ 90.00 to the bank, but its payments less fees and refunds come to GH₵ 0.00/);
  });

  it("a day that balances is signed off, and is then closed for good", async () => {
    const quiet = daysFromToday(-20);
    const result = await importAndCheckDay(ctx(recFinance), new FakePaymentProvider("https://transport.test"), quiet, op.app);
    expect(result.openDifferences).toBe(0);
    const day = await staff(recFinance, (tx) => signOffDay(tx, quiet, { notes: "Nothing ran that day" }));
    expect(day).toMatchObject({ state: "SIGNED_OFF", notes: "Nothing ran that day" });
    await expect(importAndCheckDay(ctx(recFinance), new FakePaymentProvider("https://transport.test"), quiet, op.app)).rejects.toThrow(/already signed off/);
  });
});

describe("ledger agreement (18.3, 24.2)", () => {
  it("report totals equal the ledger, to the pesewa", async () => {
    const report = await staff(finance, (tx) => financeReport(tx, { from: today, to: today }));
    expect(report.paymentsPesewas).toBeGreaterThan(0);
    expect(report.refundsApprovedPesewas).toBeGreaterThan(0);
    expect(report.ledgerBookedRevenuePesewas).toBe(report.bookedRevenuePesewas);
    expect(report.netOfProviderFeesPesewas).toBe(report.bookedRevenuePesewas - report.providerFeesPesewas);

    const [earned] = await owner`select coalesce(-sum(amount_pesewas), 0)::int as total from app.ledger_entries
                                 where organisation_id = ${op.organisationId} and account in ('FARE_REVENUE', 'FEE_REVENUE')`;
    expect(report.earnedRevenuePesewas).toBe(earned.total);
    const [owed] = await owner`select coalesce(sum(amount_pesewas), 0)::int as total from app.refunds
                               where organisation_id = ${op.organisationId} and state in ('APPROVED', 'PROCESSING', 'FAILED')`;
    expect(report.refundLiabilityPesewas).toBe(owed.total);

    // Every posting balances.
    const unbalanced = await owner`select posting_id from app.ledger_entries where organisation_id = ${op.organisationId}
                                   group by posting_id having sum(amount_pesewas) <> 0`;
    expect(unbalanced).toHaveLength(0);
  });

  it("the ledger cannot be changed, not even to move a settlement link", async () => {
    const [entry] = await owner`select id from app.ledger_entries where organisation_id = ${recOp.organisationId} and settlement_id is not null limit 1`;
    await expect(owner`update app.ledger_entries set settlement_id = null where id = ${entry.id}`).rejects.toThrow(/append-only/);
    await expect(owner`update app.ledger_entries set amount_pesewas = 1 where id = ${entry.id}`).rejects.toThrow(/append-only/);
    await expect(owner`delete from app.ledger_entries where id = ${entry.id}`).rejects.toThrow();
  });
});
