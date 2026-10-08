import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { withOrganisation, type RequestContext, type Sql, type Tx } from "@/lib/db";
import type { PaymentProvider } from "@/providers/payments/types";

type Ctx = Pick<RequestContext, "organisationId" | "correlationId" | "actorUserId">;

/**
 * Money (spec 18.2 to 18.4a). Paystack's records are imported as received,
 * then the database matches them with ours, day by day, and lists every
 * difference. Report figures come from the ledger and the payments, and a
 * test proves the two agree.
 */

export const dayParam = z.object({ day: z.iso.date() });
export const rangeQuery = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((r) => r.from <= r.to, { message: "The start date must be on or before the end date.", path: ["to"] });
export const resolveItemInput = z.object({ resolution: z.string().trim().min(5).max(1000) });
export const signOffInput = z.object({ notes: z.string().trim().max(2000).optional() });

/** The start and end of a day in Accra, which keeps UTC all year. */
function dayBounds(day: string) {
  const from = new Date(`${day}T00:00:00Z`);
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

/**
 * Imports Paystack's transactions and settlements for the day (18.4a steps 1
 * and 5), posts each new settlement to the ledger, then checks the day.
 * Transactions are looked up a day either side, since a payment may settle later.
 */
export async function importAndCheckDay(ctx: Ctx, provider: PaymentProvider, day: string, sql?: Sql) {
  const { from, to } = dayBounds(day);
  const transactions = await provider.listTransactions(from, to);
  const settlements = await provider.listSettlements(from, to);

  return withOrganisation(ctx, async (tx) => {
    for (const t of transactions) {
      await tx`
        insert into app.provider_transactions (organisation_id, provider, reference, status, amount_pesewas, currency, fee_pesewas, channel, paid_at, raw)
        values (${ctx.organisationId}, ${provider.name}, ${t.reference}, ${t.status}, ${t.amountPesewas}, ${t.currency}, ${t.feePesewas},
                ${t.channel}, ${t.paidAt}, ${tx.json(t.raw as never)})
        on conflict (provider, reference) do update
          set status = excluded.status, amount_pesewas = excluded.amount_pesewas, currency = excluded.currency,
              fee_pesewas = excluded.fee_pesewas, channel = excluded.channel, paid_at = excluded.paid_at, raw = excluded.raw`;
    }
    for (const s of settlements) {
      const [row] = await tx<{ id: string }[]>`
        insert into app.provider_settlements (organisation_id, provider, provider_settlement_id, settled_on, currency,
                                              gross_pesewas, fees_pesewas, refunds_pesewas, net_pesewas, raw)
        values (${ctx.organisationId}, ${provider.name}, ${s.id}, ${s.settledOn}, ${s.currency}, ${s.grossPesewas}, ${s.feesPesewas},
                ${s.refundsPesewas}, ${s.netPesewas}, ${tx.json(s.raw as never)})
        on conflict (provider, provider_settlement_id) do update set raw = excluded.raw
        returning id`;
      if (s.transactionReferences.length) {
        await tx`update app.provider_transactions set settlement_id = ${row.id}
                 where provider = ${provider.name} and reference = any(${s.transactionReferences}::text[]) and settlement_id is null`;
      }
      await tx`select app.post_settlement(${row.id})`;
    }
    const [checked] = await tx<{ open: number }[]>`select app.check_reconciliation_day(${day}::date) as open`;
    return { day, imported: { transactions: transactions.length, settlements: settlements.length }, openDifferences: checked.open };
  }, sql);
}

export type ReconciliationItem = {
  id: string;
  kind: string;
  severity: "critical" | "high";
  description: string;
  bookingReference: string | null;
  providerReference: string | null;
  differencePesewas: number | null;
  resolution: string | null;
  resolvedByName: string | null;
  resolvedAt: Date | null;
};

export async function getReconciliationDay(tx: Tx, day: string) {
  const [row] = await tx<{ id: string; day: string; state: string; checkedAt: Date | null; signedOffAt: Date | null; signedOffByName: string | null; notes: string | null; summary: Record<string, number> }[]>`
    select d.id, d.day::text as day, d.state, d.checked_at, d.signed_off_at, u.full_name as signed_off_by_name, d.notes, d.summary
    from app.reconciliation_days d left join app.users u on u.id = d.signed_off_by
    where d.day = ${day}`;
  if (!row) return { day, state: "NOT_CHECKED", checkedAt: null, signedOffAt: null, signedOffByName: null, notes: null, summary: {}, items: [] as ReconciliationItem[] };
  const items = await tx<ReconciliationItem[]>`
    select i.id, i.kind, i.severity, i.description, b.reference as booking_reference, i.provider_reference, i.difference_pesewas,
           i.resolution, u.full_name as resolved_by_name, i.resolved_at
    from app.reconciliation_items i
    left join app.bookings b on b.id = i.booking_id
    left join app.users u on u.id = i.resolved_by
    where i.day_id = ${row.id}
    order by i.resolved_at is not null, case i.severity when 'critical' then 0 else 1 end, i.created_at`;
  const { id, ...rest } = row;
  void id;
  return { ...rest, items };
}

/** The last fortnight of days, newest first, with what is left to do. */
export async function listReconciliationDays(tx: Tx) {
  return tx<{ day: string; state: string; checkedAt: Date | null; openDifferences: number; paidPesewas: number }[]>`
    with days as (
      select ((now() at time zone 'Africa/Accra')::date - n)::date as day from generate_series(1, 14) n
    )
    select days.day::text as day, coalesce(d.state, 'NOT_CHECKED') as state, d.checked_at,
           (select count(*)::int from app.reconciliation_items i where i.day_id = d.id and i.resolved_at is null) as open_differences,
           (select coalesce(sum(p.amount_pesewas), 0)::bigint from app.payments p
             where p.received_at >= days.day::timestamp at time zone 'Africa/Accra'
               and p.received_at < (days.day + 1)::timestamp at time zone 'Africa/Accra') as paid_pesewas
    from days left join app.reconciliation_days d on d.day = days.day
    order by days.day desc`;
}

export async function resolveItem(tx: Tx, itemId: string, input: z.infer<typeof resolveItemInput>) {
  await tx`select app.resolve_reconciliation_item(${itemId}, ${input.resolution})`;
  return { id: itemId };
}

export async function signOffDay(tx: Tx, day: string, input: z.infer<typeof signOffInput>) {
  await tx`select app.sign_off_day(${day}::date, ${input.notes ?? null})`;
  return getReconciliationDay(tx, day);
}

// ---------------------------------------------------------------------------
// The finance report (18.1, 18.2)
// ---------------------------------------------------------------------------

export type FinanceReport = {
  from: string;
  to: string;
  currency: string;
  /** Payments received in the period, by the confirmation date. */
  paymentsPesewas: number;
  /** Refunds approved in the period. */
  refundsApprovedPesewas: number;
  /** D18: fares and fees of confirmed seats, net of refunds approved or completed. */
  bookedRevenuePesewas: number;
  /** D18: revenue of journeys that completed, on the journey date. */
  earnedRevenuePesewas: number;
  providerFeesPesewas: number;
  /** D18: booked revenue less provider fees. */
  netOfProviderFeesPesewas: number;
  /** D18: approved refunds not yet paid, at the end of the period. */
  refundLiabilityPesewas: number;
  /** The same booked revenue worked out from the ledger alone; must equal bookedRevenuePesewas. */
  ledgerBookedRevenuePesewas: number;
  byRoute: { routeName: string; paymentsPesewas: number; refundsPesewas: number; seats: number }[];
  definitions: Record<string, string>;
};

export async function financeReport(tx: Tx, range: z.infer<typeof rangeQuery>): Promise<FinanceReport> {
  const fromTs = `${range.from}T00:00:00Z`;
  const toTs = new Date(new Date(`${range.to}T00:00:00Z`).getTime() + 86_400_000).toISOString();
  const [money] = await tx<{ currency: string; payments: number; refunds: number; earned: number; fees: number; liability: number; ledgerBooked: number }[]>`
    select
      (select currency from app.organisations where id = app.current_organisation_id()) as currency,
      (select coalesce(sum(amount_pesewas), 0)::bigint from app.payments where received_at >= ${fromTs} and received_at < ${toTs}) as payments,
      (select coalesce(sum(amount_pesewas), 0)::bigint from app.refunds
        where approved_at >= ${fromTs} and approved_at < ${toTs} and state <> 'REJECTED') as refunds,
      (select coalesce(-sum(amount_pesewas), 0)::bigint from app.ledger_entries
        where account in ('FARE_REVENUE', 'FEE_REVENUE') and entry_date between ${range.from}::date and ${range.to}::date) as earned,
      (select coalesce(sum(amount_pesewas), 0)::bigint from app.ledger_entries
        where account = 'PROVIDER_FEES' and entry_date between ${range.from}::date and ${range.to}::date) as fees,
      (select coalesce(-sum(amount_pesewas), 0)::bigint from app.ledger_entries
        where account = 'REFUNDS_PAYABLE' and entry_date <= ${range.to}::date) as liability,
      -- Booked revenue from the ledger: money into DEFERRED_FARES from payments, less refund approvals.
      (select coalesce(-sum(amount_pesewas) filter (where description = 'Payment received'), 0)
              - coalesce(sum(amount_pesewas) filter (where refund_id is not null and description like 'Refund approved:%'), 0)
         from app.ledger_entries
         where account in ('DEFERRED_FARES', 'FARE_REVENUE', 'FEE_REVENUE')
           and entry_date between ${range.from}::date and ${range.to}::date)::bigint as ledger_booked`;

  const byRoute = await tx<FinanceReport["byRoute"]>`
    select r.name as route_name,
           coalesce(sum(p.amount_pesewas), 0)::bigint as payments_pesewas,
           coalesce((select sum(f.amount_pesewas) from app.refunds f join app.bookings fb on fb.id = f.booking_id
                     where fb.route_id = r.id and f.approved_at >= ${fromTs} and f.approved_at < ${toTs} and f.state <> 'REJECTED'), 0)::bigint as refunds_pesewas,
           (select count(*)::int from app.booked_seats s join app.bookings sb on sb.id = s.booking_id
             join app.payments sp on sp.booking_id = sb.id
             where sb.route_id = r.id and sp.received_at >= ${fromTs} and sp.received_at < ${toTs}) as seats
    from app.routes r
    left join app.bookings b on b.route_id = r.id
    left join app.payments p on p.booking_id = b.id and p.received_at >= ${fromTs} and p.received_at < ${toTs}
    group by r.id, r.name
    having coalesce(sum(p.amount_pesewas), 0) > 0
    order by payments_pesewas desc`;

  const booked = Number(money.payments) - Number(money.refunds);
  return {
    from: range.from,
    to: range.to,
    currency: money.currency,
    paymentsPesewas: Number(money.payments),
    refundsApprovedPesewas: Number(money.refunds),
    bookedRevenuePesewas: booked,
    earnedRevenuePesewas: Number(money.earned),
    providerFeesPesewas: Number(money.fees),
    netOfProviderFeesPesewas: booked - Number(money.fees),
    refundLiabilityPesewas: Number(money.liability),
    ledgerBookedRevenuePesewas: Number(money.ledgerBooked),
    byRoute,
    definitions: {
      "Booked revenue": "Fares and fees paid in the period, less refunds approved in the period.",
      "Earned revenue": "Fares and fees of journeys that completed in the period, less refunds made after they completed.",
      "Net of provider fees": "Booked revenue less the fees Paystack charged in the period.",
      "Refund liability": "Refunds approved and not yet paid, at the end of the period.",
    },
  };
}

/** The report as a spreadsheet file. Exports are permission-controlled and audited (18.1). */
export async function financeReportCsv(tx: Tx, range: z.infer<typeof rangeQuery>) {
  const report = await financeReport(tx, range);
  const cedis = (p: number) => `${p < 0 ? "-" : ""}${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, "0")}`;
  const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
  const lines = [
    ["Measure", `Amount (${report.currency})`].join(","),
    ...([
      ["Payments received", report.paymentsPesewas],
      ["Refunds approved", report.refundsApprovedPesewas],
      ["Booked revenue", report.bookedRevenuePesewas],
      ["Earned revenue", report.earnedRevenuePesewas],
      ["Provider fees", report.providerFeesPesewas],
      ["Net of provider fees", report.netOfProviderFeesPesewas],
      ["Refund liability", report.refundLiabilityPesewas],
    ] as const).map(([name, value]) => [quote(name), cedis(value)].join(",")),
    "",
    ["Route", "Payments", "Refunds", "Seats"].join(","),
    ...report.byRoute.map((r) => [quote(r.routeName), cedis(r.paymentsPesewas), cedis(r.refundsPesewas), r.seats].join(",")),
  ];
  await tx`select app.write_audit('finance.export', 'finance_report', null, null, ${tx.json({ from: range.from, to: range.to })})`;
  return { filename: `finance-${range.from}-to-${range.to}.csv`, csv: lines.join("\n") };
}

export function requireEndedDay(day: string) {
  const today = new Date().toISOString().slice(0, 10);
  if (day >= today) throw new AppError("rule_violation", { message: "A day can be checked only once it has ended." });
}
