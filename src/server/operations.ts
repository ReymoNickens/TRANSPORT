import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import type { Tx } from "@/lib/db";
import { normaliseGhanaPhone } from "@/lib/phone";

/**
 * The manager's dashboard (spec 8.2, 8.2a) and the needs-attention queue
 * (18.6). Three bands: what needs attention, today's departures, and a quiet
 * line of today's figures. Everything is in business words.
 */

export type AttentionItem = {
  id: string;
  kind: string;
  severity: "critical" | "high" | "normal";
  state: "OPEN" | "ACKNOWLEDGED" | "IN_PROGRESS";
  summary: string;
  recommendedAction: string;
  ownerName: string | null;
  ownerId: string | null;
  dueAt: Date;
  overdue: boolean;
  createdAt: Date;
  journeyId: string | null;
  bookingReference: string | null;
};

export type TodayDeparture = {
  id: string;
  routeName: string;
  scheduledDepartureAt: Date;
  state: string;
  vehicleRegistration: string | null;
  seatsSold: number;
  seats: number;
  boarded: number;
  crew: number;
  delayMinutes: number;
  problems: string[];
};

export type Dashboard = {
  attention: AttentionItem[];
  today: TodayDeparture[];
  nextDeparture: { id: string; routeName: string; scheduledDepartureAt: Date } | null;
  figures: {
    seatsSoldToday: number;
    occupancyPercent: number | null;
    revenueTodayPesewas: number;
    boardedToday: number;
    refundsOwedPesewas: number;
    currency: string;
  };
};

export const exceptionsQuery = z.object({
  severity: z.enum(["critical", "high", "normal"]).optional(),
  mine: z.enum(["true", "false"]).optional(),
  journeyId: z.uuid().optional(),
});
export const resolveInput = z.object({ resolution: z.string().trim().min(5).max(1000) });
export const dismissInput = z.object({ reason: z.string().trim().min(5).max(1000) });

/** Open items: overdue critical first, then by severity and due time (18.6). */
export async function listAttention(tx: Tx, actorId: string, query: z.infer<typeof exceptionsQuery> = {}): Promise<AttentionItem[]> {
  return tx<AttentionItem[]>`
    select e.id, e.kind, e.severity, e.state, e.summary, e.recommended_action, u.full_name as owner_name, e.owner_id,
           e.due_at, e.due_at < now() as overdue, e.created_at, e.journey_id, b.reference as booking_reference
    from app.exceptions e
    left join app.users u on u.id = e.owner_id
    left join app.bookings b on b.id = e.booking_id
    where e.state not in ('RESOLVED', 'DISMISSED')
      and (${query.severity ?? null}::text is null or e.severity = ${query.severity ?? null})
      and (${query.mine ?? null}::text is distinct from 'true' or e.owner_id = ${actorId})
      and (${query.journeyId ?? null}::uuid is null or e.journey_id = ${query.journeyId ?? null}::uuid)
    order by (e.severity = 'critical' and e.due_at < now()) desc,
             case e.severity when 'critical' then 0 when 'high' then 1 else 2 end,
             e.due_at
    limit 200`;
}

export async function getDashboard(tx: Tx, actorId: string): Promise<Dashboard> {
  const attention = await listAttention(tx, actorId);

  const today = await tx<(Omit<TodayDeparture, "problems"> & { openItems: number })[]>`
    select j.id, r.name as route_name, j.scheduled_departure_at, j.state, v.registration as vehicle_registration,
           (select count(*)::int from app.booked_seats s where s.journey_id = j.id and s.state in ('CONFIRMED', 'BOARDED', 'NO_SHOW')) as seats_sold,
           (select count(*)::int from app.journey_seats s where s.journey_id = j.id and s.state = 'BOOKABLE') as seats,
           (select count(*)::int from app.boarding_records br where br.journey_id = j.id) as boarded,
           (select count(*)::int from app.journey_staff st where st.journey_id = j.id and st.removed_at is null) as crew,
           j.delay_minutes,
           (select count(*)::int from app.exceptions e where e.journey_id = j.id and e.state not in ('RESOLVED', 'DISMISSED')) as open_items
    from app.journeys j
    join app.routes r on r.id = j.route_id
    left join app.vehicle_assignments a on a.journey_id = j.id and a.state = 'ACTIVE'
    left join app.vehicles v on v.id = a.vehicle_id
    where j.service_date = (now() at time zone 'Africa/Accra')::date
    order by j.scheduled_departure_at`;

  const departures: TodayDeparture[] = today.map(({ openItems, ...j }) => {
    const problems: string[] = [];
    const live = !["CANCELLED", "COMPLETED"].includes(j.state);
    if (live && !j.vehicleRegistration) problems.push("No bus");
    if (live && j.state === "DRAFT") problems.push("Not on sale");
    if (live && j.crew === 0) problems.push("No crew");
    if (j.delayMinutes > 0 && live) problems.push(`Delayed ${j.delayMinutes} min`);
    if (openItems > 0) problems.push(`${openItems} item${openItems === 1 ? "" : "s"} need attention`);
    return { ...j, problems };
  });
  // Journeys with a problem sort to the top (8.2a), each group in time order.
  departures.sort((a, b) => Number(b.problems.length > 0) - Number(a.problems.length > 0) ||
    a.scheduledDepartureAt.getTime() - b.scheduledDepartureAt.getTime());

  const [next] = await tx<{ id: string; routeName: string; scheduledDepartureAt: Date }[]>`
    select j.id, r.name as route_name, j.scheduled_departure_at from app.journeys j join app.routes r on r.id = j.route_id
    where j.scheduled_departure_at > now() and j.state in ('SCHEDULED', 'SALES_CLOSED', 'BOARDING')
    order by j.scheduled_departure_at limit 1`;

  const [figures] = await tx<Dashboard["figures"][]>`
    with paid_today as (
      select p.booking_id, p.amount_pesewas, p.currency from app.payments p
      where p.received_at >= (date_trunc('day', now() at time zone 'Africa/Accra') at time zone 'Africa/Accra')
        and p.state = 'RECEIVED'
    )
    select
      (select count(*)::int from app.booked_seats s where s.booking_id in (select booking_id from paid_today)
         and s.state in ('CONFIRMED', 'BOARDED', 'NO_SHOW')) as seats_sold_today,
      (select case when sum(seats) > 0 then round(100.0 * sum(sold) / sum(seats))::int end from (
         select (select count(*) from app.journey_seats s where s.journey_id = j.id and s.state = 'BOOKABLE') as seats,
                (select count(*) from app.booked_seats s where s.journey_id = j.id and s.state in ('CONFIRMED', 'BOARDED', 'NO_SHOW')) as sold
         from app.journeys j where j.service_date = (now() at time zone 'Africa/Accra')::date and j.state <> 'CANCELLED') x) as occupancy_percent,
      (select coalesce(sum(amount_pesewas), 0)::bigint from paid_today) as revenue_today_pesewas,
      (select count(*)::int from app.boarding_records br
         where br.boarded_at >= (date_trunc('day', now() at time zone 'Africa/Accra') at time zone 'Africa/Accra')) as boarded_today,
      (select coalesce(sum(amount_pesewas), 0)::bigint from app.refunds where state in ('REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED')) as refunds_owed_pesewas,
      (select currency from app.organisations where id = app.current_organisation_id()) as currency`;

  return { attention, today: departures, nextDeparture: next ?? null, figures };
}

export async function takeException(tx: Tx, id: string) {
  await tx`select app.take_exception(${id})`;
  return { id };
}

export async function startException(tx: Tx, actorId: string, id: string) {
  await tx`select app.move_exception(${id}, 'IN_PROGRESS', null, ${actorId})`;
  return { id };
}

export async function resolveException(tx: Tx, actorId: string, id: string, input: z.infer<typeof resolveInput>) {
  await tx`select app.move_exception(${id}, 'RESOLVED', ${input.resolution}, ${actorId})`;
  return { id };
}

export async function dismissException(tx: Tx, actorId: string, id: string, input: z.infer<typeof dismissInput>) {
  await tx`select app.move_exception(${id}, 'DISMISSED', ${input.reason}, ${actorId})`;
  return { id };
}

// ---------------------------------------------------------------------------
// Staff list (to put people on a crew) and booking lookup
// ---------------------------------------------------------------------------

export type StaffMember = { id: string; fullName: string | null; roles: string[] };

/** Active staff who can work on a bus (hold journey.view.assigned or ticket.scan). */
export async function listCrewCandidates(tx: Tx): Promise<StaffMember[]> {
  return tx<StaffMember[]>`
    select u.id, u.full_name, array_agg(distinct r.name order by r.name) as roles
    from app.users u
    join app.user_roles ur on ur.user_id = u.id
    join app.roles r on r.id = ur.role_id
    join app.role_permissions rp on rp.role_id = r.id
    where u.kind = 'staff' and u.status = 'active' and rp.permission_code in ('journey.view.assigned', 'ticket.scan')
    group by u.id, u.full_name
    order by u.full_name`;
}

export const bookingLookupQuery = z.object({ q: z.string().trim().min(3).max(40) });

export type BookingSummary = {
  reference: string;
  state: string;
  purchaserName: string;
  phoneLastDigits: string;
  journeyLabel: string;
  seats: number;
  totalPesewas: number;
  currency: string;
};

/** Finds bookings by reference or by the purchaser's or a passenger's phone number. */
export async function lookupBookings(tx: Tx, q: string): Promise<BookingSummary[]> {
  const reference = q.toUpperCase().replace(/[\s-]/g, "");
  const phone = normaliseGhanaPhone(q);
  if (!phone && !/^[2-9A-HJ-NP-Z]{8}$/.test(reference)) {
    throw new AppError("validation_failed", { message: "Enter a booking reference (8 characters) or a phone number." });
  }
  return tx<BookingSummary[]>`
    select b.reference, b.state, b.purchaser_name, right(b.purchaser_phone, 3) as phone_last_digits,
           app.journey_label(b.journey_id) as journey_label,
           (select count(*)::int from app.booked_seats s where s.booking_id = b.id) as seats,
           b.total_pesewas, b.currency
    from app.bookings b
    where b.reference = ${reference}
       or (${phone}::text is not null and (b.purchaser_phone = ${phone}
           or exists (select 1 from app.booking_passengers p where p.booking_id = b.id and p.phone = ${phone})))
    order by b.created_at desc
    limit 50`;
}

export async function bookingIdByReference(tx: Tx, reference: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`select id from app.bookings where reference = ${reference.toUpperCase()}`;
  if (!row) throw new AppError("not_found", { message: "We couldn't find that booking." });
  return row.id;
}
