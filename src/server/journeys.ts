import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { offsetOf, pageFrom, type PageQuery } from "@/lib/api/pagination";
import type { Tx } from "@/lib/db";
import { one } from "./common";
import { currentOrganisation } from "./network";
import type { Journey, JourneyEvent, JourneySeat, JourneyStaffMember, JourneySummary } from "./types";

const states = ["DRAFT", "SCHEDULED", "SALES_CLOSED", "BOARDING", "DEPARTED", "COMPLETED", "CANCELLED"] as const;

export const listJourneysQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  state: z.enum(states).optional(),
  routeId: z.uuid().optional(),
  /** Only drafts that still need something before going on sale. */
  needsAttention: z.enum(["true", "false"]).optional(),
});
export const oneOffJourneyInput = z.object({
  routeId: z.uuid(),
  departureAt: z.iso.datetime({ offset: true }),
  vehicleId: z.uuid().nullish(),
});
export const assignVehicleInput = z.object({ vehicleId: z.uuid(), reason: z.string().trim().max(300).nullish() });
export const cancelJourneyInput = z.object({ reason: z.string().trim().min(5).max(500) });
export const seatStateInput = z.object({ state: z.enum(["BOOKABLE", "BLOCKED"]) });
export const assignStaffInput = z.object({ userId: z.uuid(), staffRole: z.enum(["driver", "conductor"]) });
export const generateInput = z.object({ days: z.number().int().min(1).max(90).optional() });

export async function listJourneys(tx: Tx, query: z.infer<typeof listJourneysQuery> & PageQuery) {
  const rows = await tx<(JourneySummary & { totalCount: number })[]>`
    select j.id, j.route_id, r.name as route_name, j.schedule_id, j.service_date::text as service_date,
           j.scheduled_departure_at, j.scheduled_arrival_at, j.state,
           v.registration as vehicle_registration,
           (select count(*)::int from app.journey_seats s where s.journey_id = j.id and s.state = 'BOOKABLE') as bookable_seats,
           (j.state = 'DRAFT' and a.id is null) as needs_bus,
           (j.state = 'DRAFT' and not exists (
              select 1 from app.fare_templates t where t.route_id = j.route_id and t.status = 'active')) as needs_fares,
           count(*) over () as total_count
    from app.journeys j
    join app.routes r on r.id = j.route_id
    left join app.vehicle_assignments a on a.journey_id = j.id and a.state = 'ACTIVE'
    left join app.vehicles v on v.id = a.vehicle_id
    where (${query.from ?? null}::date is null or j.service_date >= ${query.from ?? null}::date)
      and (${query.to ?? null}::date is null or j.service_date <= ${query.to ?? null}::date)
      and (${query.state ?? null}::text is null or j.state = ${query.state ?? null})
      and (${query.routeId ?? null}::uuid is null or j.route_id = ${query.routeId ?? null}::uuid)
      and (${query.needsAttention ?? null}::text is distinct from 'true' or j.state = 'DRAFT')
    order by j.scheduled_departure_at
    limit ${query.pageSize} offset ${offsetOf(query)}`;
  return pageFrom(rows, query);
}

export async function getJourney(tx: Tx, id: string): Promise<Journey> {
  const journey = one(await tx<Omit<Journey, "seats" | "staff" | "events">[]>`
    select j.id, j.route_id, r.name as route_name, j.schedule_id, j.schedule_version, j.service_date::text as service_date,
           j.scheduled_departure_at, j.scheduled_arrival_at, j.actual_departure_at, j.actual_arrival_at,
           j.delay_minutes, j.booking_opens_at, j.state, j.cancelled_at, j.cancellation_reason,
           a.vehicle_id, v.registration as vehicle_registration,
           (select count(*)::int from app.journey_seats s where s.journey_id = j.id and s.state = 'BOOKABLE') as bookable_seats,
           (select count(*)::int from app.journey_fares f where f.journey_id = j.id) as fare_count,
           (j.state = 'DRAFT' and a.id is null) as needs_bus,
           (j.state = 'DRAFT' and not exists (
              select 1 from app.fare_templates t where t.route_id = j.route_id and t.status = 'active')) as needs_fares
    from app.journeys j
    join app.routes r on r.id = j.route_id
    left join app.vehicle_assignments a on a.journey_id = j.id and a.state = 'ACTIVE'
    left join app.vehicles v on v.id = a.vehicle_id
    where j.id = ${id}`);
  const seats = await tx<JourneySeat[]>`
    select id, seat_number, seat_type, row_number, column_number, position, state
    from app.journey_seats where journey_id = ${id} order by row_number, column_number`;
  const staff = await tx<JourneyStaffMember[]>`
    select s.id, s.user_id, u.full_name, s.staff_role, s.assigned_at
    from app.journey_staff s join app.users u on u.id = s.user_id
    where s.journey_id = ${id} and s.removed_at is null order by s.staff_role`;
  const events = await tx<JourneyEvent[]>`
    select e.event_type, e.from_state, e.to_state, e.delay_minutes, e.notes, u.full_name as recorded_by_name, e.occurred_at
    from app.journey_events e left join app.users u on u.id = e.recorded_by
    where e.journey_id = ${id} order by e.occurred_at, e.id`;
  return { ...journey, seats: [...seats], staff: [...staff], events: [...events] };
}

/** A journey outside any schedule, created by a manager (D23). Starts as a draft. */
export async function createOneOffJourney(tx: Tx, actorId: string, input: z.infer<typeof oneOffJourneyInput>) {
  const organisationId = await currentOrganisation(tx);
  const route = one(await tx<{ status: string; durationMinutes: number | null }[]>`
    select r.status, (select max(arrival_offset_minutes) from app.route_stops where route_id = r.id) as duration_minutes
    from app.routes r where r.id = ${input.routeId}`);
  if (route.status !== "active") throw new AppError("rule_violation", { message: "A journey needs a live route." });
  const departure = new Date(input.departureAt);
  if (departure.getTime() <= Date.now()) throw new AppError("rule_violation", { message: "A new journey must depart in the future." });

  const journey = one(await tx<{ id: string }[]>`
    insert into app.journeys (organisation_id, route_id, service_date, scheduled_departure_at, scheduled_arrival_at,
                              booking_opens_at, created_by)
    select ${organisationId}, ${input.routeId}, (${departure}::timestamptz at time zone o.timezone)::date,
           ${departure}::timestamptz, ${departure}::timestamptz + make_interval(mins => ${route.durationMinutes ?? 0}),
           ${departure}::timestamptz - make_interval(days => coalesce(app.setting_int(o.id, 'booking.open_days_before'), 30)),
           ${actorId}
    from app.organisations o where o.id = ${organisationId}
    returning id`);
  if (input.vehicleId) {
    await tx`select app.assign_vehicle(${journey.id}, ${input.vehicleId}, 'Chosen when the journey was created')`;
  }
  return getJourney(tx, journey.id);
}

export async function assignVehicle(tx: Tx, id: string, input: z.infer<typeof assignVehicleInput>) {
  await tx`select app.assign_vehicle(${id}, ${input.vehicleId}, ${input.reason ?? null})`;
  return getJourney(tx, id);
}

/** Copies the live fares and puts the journey on sale. */
export async function publishJourney(tx: Tx, id: string) {
  await tx`select app.publish_journey(${id})`;
  return getJourney(tx, id);
}

/**
 * Cancels a journey (high-risk: a reason and fresh confirmation). Journeys
 * with confirmed tickets will go through the disruption procedure (15.2)
 * once bookings exist.
 */
export async function cancelJourney(tx: Tx, id: string, input: z.infer<typeof cancelJourneyInput>) {
  await tx`select app.move_journey(${id}, 'CANCELLED', ${input.reason})`;
  return getJourney(tx, id);
}

/** Blocks or unblocks one seat, for example a broken seat. */
export async function setSeatState(tx: Tx, journeyId: string, seatId: string, input: z.infer<typeof seatStateInput>) {
  one(await tx`update app.journey_seats set state = ${input.state} where id = ${seatId} and journey_id = ${journeyId} returning id`);
  return getJourney(tx, journeyId);
}

export async function assignStaff(tx: Tx, journeyId: string, input: z.infer<typeof assignStaffInput>) {
  await tx`select app.assign_journey_staff(${journeyId}, ${input.userId}, ${input.staffRole})`;
  return getJourney(tx, journeyId);
}

export async function removeStaff(tx: Tx, actorId: string, journeyId: string, assignmentId: string) {
  const row = one(await tx<{ staffRole: string }[]>`
    update app.journey_staff set removed_at = now(), removed_by = ${actorId}
    where id = ${assignmentId} and journey_id = ${journeyId} and removed_at is null
    returning staff_role`);
  await tx`select app.record_journey_event(${journeyId}, 'staff_removed', ${row.staffRole})`;
  return getJourney(tx, journeyId);
}

/** Runs journey generation now instead of waiting for the night (D23). */
export async function generateNow(tx: Tx, input: z.infer<typeof generateInput>) {
  const organisationId = await currentOrganisation(tx);
  const [result] = await tx<{ created: number; putOnSale: number }[]>`
    select * from app.generate_journeys(${organisationId}, null, ${input.days ?? null})`;
  return result;
}
