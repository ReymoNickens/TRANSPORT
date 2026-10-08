import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { offsetOf, pageFrom, type PageQuery } from "@/lib/api/pagination";
import type { Tx } from "@/lib/db";
import { priceBooking, type Concession, type FeeRule } from "@/domain/pricing";
import { basisPoints, definedOnly, name, one, pesewas, requireChanges, seatType } from "./common";
import { currentOrganisation } from "./network";
import type { ConcessionType, FareRule as FareRuleRow, FareTable, FareTableSummary, FeeRuleRow } from "./types";

// ---------------------------------------------------------------------------
// Fare tables and fare rules (spec 10.3). Prices change by copying the live
// table to a draft, editing it, and making the draft live.
// ---------------------------------------------------------------------------

export const createFareTableInput = z.object({ routeId: z.uuid(), name: name() });
export const copyFareTableInput = z.object({ name: name() });
export const listFareTablesQuery = z.object({
  routeId: z.uuid().optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
});
export const replaceFareRulesInput = z.object({
  rules: z
    .array(
      z.object({
        originStopId: z.uuid(),
        destinationStopId: z.uuid(),
        seatType: seatType,
        amountPesewas: pesewas,
      }),
    )
    .min(1)
    .max(2000),
});

export async function listFareTables(tx: Tx, query: z.infer<typeof listFareTablesQuery> & PageQuery) {
  const rows = await tx<(FareTableSummary & { totalCount: number })[]>`
    select t.id, t.name, t.status, t.currency, t.route_id, r.name as route_name, t.activated_at, t.archived_at,
           (select count(*)::int from app.fare_rules f where f.template_id = t.id) as rule_count,
           count(*) over () as total_count
    from app.fare_templates t join app.routes r on r.id = t.route_id
    where (${query.routeId ?? null}::uuid is null or t.route_id = ${query.routeId ?? null})
      and (${query.status ?? null}::text is null or t.status = ${query.status ?? null})
    order by t.status = 'archived', r.name, t.created_at desc
    limit ${query.pageSize} offset ${offsetOf(query)}`;
  return pageFrom(rows, query);
}

export async function getFareTable(tx: Tx, id: string): Promise<FareTable> {
  const table = one(await tx<Omit<FareTable, "rules">[]>`
    select t.id, t.name, t.status, t.currency, t.route_id, r.name as route_name, t.activated_at, t.archived_at, t.created_at
    from app.fare_templates t join app.routes r on r.id = t.route_id
    where t.id = ${id}`);
  const rules = await tx<FareRuleRow[]>`
    select f.id, f.origin_stop_id, o.sequence as origin_sequence, ol.name as origin_name,
           f.destination_stop_id, d.sequence as destination_sequence, dl.name as destination_name,
           f.seat_type, f.amount_pesewas, f.currency
    from app.fare_rules f
    join app.route_stops o on o.id = f.origin_stop_id join app.locations ol on ol.id = o.location_id
    join app.route_stops d on d.id = f.destination_stop_id join app.locations dl on dl.id = d.location_id
    where f.template_id = ${id}
    order by o.sequence, d.sequence, f.seat_type`;
  return { ...table, rules: [...rules] };
}

export async function createFareTable(tx: Tx, actorId: string, input: z.infer<typeof createFareTableInput>) {
  const organisationId = await currentOrganisation(tx);
  const [org] = await tx<{ currency: string }[]>`select currency from app.organisations where id = ${organisationId}`;
  const row = one(await tx<{ id: string }[]>`
    insert into app.fare_templates ${tx({ ...input, organisationId, currency: org.currency, createdBy: actorId })}
    returning id`);
  return getFareTable(tx, row.id);
}

export async function replaceFareRules(tx: Tx, id: string, input: z.infer<typeof replaceFareRulesInput>) {
  const table = one(await tx<{ id: string; organisationId: string; routeId: string; currency: string; status: string }[]>`
    select id, organisation_id, route_id, currency, status from app.fare_templates where id = ${id} for update`);
  if (table.status !== "draft") {
    throw new AppError("rule_violation", { message: "Fares can only be changed while the fare table is a draft." });
  }
  await tx`delete from app.fare_rules where template_id = ${id}`;
  const rows = input.rules.map((rule) => ({
    ...rule,
    organisationId: table.organisationId,
    templateId: id,
    routeId: table.routeId,
    currency: table.currency,
  }));
  await tx`insert into app.fare_rules ${tx(rows)}`;
  return getFareTable(tx, id);
}

export async function setFareTableStatus(tx: Tx, id: string, status: "active" | "archived") {
  one(await tx`update app.fare_templates set status = ${status} where id = ${id} returning id`);
  return getFareTable(tx, id);
}

export async function copyFareTable(tx: Tx, id: string, input: z.infer<typeof copyFareTableInput>) {
  const [row] = await tx<{ id: string }[]>`select app.copy_fare_template(${id}, ${input.name}) as id`;
  return getFareTable(tx, row.id);
}

// ---------------------------------------------------------------------------
// Concession types (spec 10.3, D10, D25)
// ---------------------------------------------------------------------------

const concessionFields = z.object({
  name: name(60),
  code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,30}$/, "Use lower-case letters, digits and _."),
  requiresReference: z.boolean().default(true),
  checkAtBoarding: z.boolean().default(true),
});
const concessionDiscount = z.discriminatedUnion("discountKind", [
  z.object({ discountKind: z.literal("percent"), discountBasisPoints: basisPoints }),
  z.object({ discountKind: z.literal("fixed"), discountPesewas: pesewas }),
]);
export const createConcessionInput = z.intersection(concessionFields, concessionDiscount);
export const updateConcessionInput = concessionFields
  .omit({ code: true })
  .partial()
  .extend({
    status: z.enum(["active", "archived"]).optional(),
    discount: concessionDiscount.optional(),
  });

const concessionColumns = (tx: Tx) =>
  tx`id, name, code, discount_kind, discount_basis_points, discount_pesewas, requires_reference, check_at_boarding, status, created_at, updated_at`;

export async function listConcessions(tx: Tx, query: PageQuery) {
  const rows = await tx<(ConcessionType & { totalCount: number })[]>`
    select ${concessionColumns(tx)}, count(*) over () as total_count
    from app.concession_types order by status, name
    limit ${query.pageSize} offset ${offsetOf(query)}`;
  return pageFrom(rows, query);
}

export async function createConcession(tx: Tx, actorId: string, input: z.infer<typeof createConcessionInput>): Promise<ConcessionType> {
  const organisationId = await currentOrganisation(tx);
  return one(await tx<ConcessionType[]>`
    insert into app.concession_types ${tx({ ...input, organisationId, createdBy: actorId })}
    returning ${concessionColumns(tx)}`);
}

export async function updateConcession(tx: Tx, id: string, input: z.infer<typeof updateConcessionInput>) {
  const { discount, ...rest } = input;
  const patch: Record<string, unknown> = definedOnly(rest);
  if (discount) {
    patch.discountKind = discount.discountKind;
    patch.discountBasisPoints = discount.discountKind === "percent" ? discount.discountBasisPoints : null;
    patch.discountPesewas = discount.discountKind === "fixed" ? discount.discountPesewas : null;
  }
  requireChanges(patch);
  return one(await tx<ConcessionType[]>`update app.concession_types set ${tx(patch)} where id = ${id} returning ${concessionColumns(tx)}`);
}

// ---------------------------------------------------------------------------
// Fee rules (spec 10.3, 13.4)
// ---------------------------------------------------------------------------

const feeFields = z.object({
  name: name(60),
  category: z.enum(["booking_fee", "tax"]),
  appliesTo: z.enum(["all", "online", "station"]).default("all"),
});
const feeAmount = z.discriminatedUnion("calculation", [
  z.object({ calculation: z.literal("fixed"), amountPesewas: pesewas }),
  z.object({ calculation: z.literal("percent"), basisPoints }),
]);
export const createFeeInput = z.intersection(feeFields, feeAmount);
export const updateFeeInput = feeFields.partial().extend({
  status: z.enum(["active", "archived"]).optional(),
  amount: feeAmount.optional(),
});

const feeColumns = (tx: Tx) => tx`id, name, category, calculation, amount_pesewas, basis_points, applies_to, status, created_at, updated_at`;

export async function listFees(tx: Tx, query: PageQuery) {
  const rows = await tx<(FeeRuleRow & { totalCount: number })[]>`
    select ${feeColumns(tx)}, count(*) over () as total_count
    from app.fee_rules order by status, name
    limit ${query.pageSize} offset ${offsetOf(query)}`;
  return pageFrom(rows, query);
}

export async function createFee(tx: Tx, actorId: string, input: z.infer<typeof createFeeInput>): Promise<FeeRuleRow> {
  const organisationId = await currentOrganisation(tx);
  return one(await tx<FeeRuleRow[]>`
    insert into app.fee_rules ${tx({ ...input, organisationId, createdBy: actorId })}
    returning ${feeColumns(tx)}`);
}

export async function updateFee(tx: Tx, id: string, input: z.infer<typeof updateFeeInput>) {
  const { amount, ...rest } = input;
  const patch: Record<string, unknown> = definedOnly(rest);
  if (amount) {
    patch.calculation = amount.calculation;
    patch.amountPesewas = amount.calculation === "fixed" ? amount.amountPesewas : null;
    patch.basisPoints = amount.calculation === "percent" ? amount.basisPoints : null;
  }
  requireChanges(patch);
  return one(await tx<FeeRuleRow[]>`update app.fee_rules set ${tx(patch)} where id = ${id} returning ${feeColumns(tx)}`);
}

// ---------------------------------------------------------------------------
// Price preview: what a passenger would pay, built exactly as checkout will
// build it (spec 13.4a), so a manager can check a fare table before it goes live.
// ---------------------------------------------------------------------------

export const quoteInput = z.object({
  originStopId: z.uuid(),
  destinationStopId: z.uuid(),
  seats: z.array(z.object({ seatType: seatType, concessionTypeId: z.uuid().nullish() })).min(1).max(6),
  channel: z.enum(["online", "station"]).default("online"),
});

export async function quoteFare(tx: Tx, templateId: string, input: z.infer<typeof quoteInput>) {
  const rules = await tx<{ seatType: string; amountPesewas: number }[]>`
    select seat_type, amount_pesewas from app.fare_rules
    where template_id = ${templateId} and origin_stop_id = ${input.originStopId} and destination_stop_id = ${input.destinationStopId}`;
  const fareBySeatType = new Map(rules.map((rule) => [rule.seatType, rule.amountPesewas]));

  const concessionIds = [...new Set(input.seats.map((s) => s.concessionTypeId).filter((v): v is string => !!v))];
  const concessions = concessionIds.length
    ? await tx<{ id: string; discountKind: "percent" | "fixed"; discountBasisPoints: number | null; discountPesewas: number | null }[]>`
        select id, discount_kind, discount_basis_points, discount_pesewas from app.concession_types
        where id = any(${concessionIds}::uuid[]) and status = 'active'`
    : [];
  const concessionById = new Map(concessions.map((c) => [c.id, c]));

  const seats = input.seats.map((seat) => {
    const base = fareBySeatType.get(seat.seatType);
    if (base === undefined) {
      throw new AppError("rule_violation", { message: `There is no ${seat.seatType} fare for this trip.` });
    }
    let concession: Concession | undefined;
    if (seat.concessionTypeId) {
      const c = concessionById.get(seat.concessionTypeId);
      if (!c) throw new AppError("rule_violation", { message: "That concession is not available." });
      concession =
        c.discountKind === "percent"
          ? { kind: "percent", basisPoints: c.discountBasisPoints!, concessionTypeId: c.id }
          : { kind: "fixed", pesewas: c.discountPesewas!, concessionTypeId: c.id };
    }
    return { baseFarePesewas: base, concession };
  });

  const fees = await tx<{ id: string; name: string; category: "booking_fee" | "tax"; calculation: "fixed" | "percent"; amountPesewas: number | null; basisPoints: number | null }[]>`
    select id, name, category, calculation, amount_pesewas, basis_points from app.fee_rules
    where status = 'active' and applies_to in ('all', ${input.channel})
    order by created_at`;
  const feeRules: FeeRule[] = fees.map((fee) =>
    fee.calculation === "fixed"
      ? { feeRuleId: fee.id, name: fee.name, category: fee.category, calculation: "fixed", amountPesewas: fee.amountPesewas! }
      : { feeRuleId: fee.id, name: fee.name, category: fee.category, calculation: "percent", basisPoints: fee.basisPoints! },
  );

  return priceBooking(seats, feeRules);
}
