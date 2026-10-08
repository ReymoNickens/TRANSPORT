import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { offsetOf, pageFrom, type PageQuery } from "@/lib/api/pagination";
import type { Tx } from "@/lib/db";
import { name, one } from "./common";
import { currentOrganisation } from "./network";
import type { Schedule, ScheduleException, ScheduleSummary, ScheduleVersion } from "./types";

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, for example 06:30.");
const daysOfWeek = z
  .array(z.number().int().min(1).max(7))
  .min(1, "Choose at least one day.")
  .max(7)
  .transform((days) => [...new Set(days)].sort());
const serviceDate = z.iso.date();

const versionFields = z.object({
  departureTime: localTime,
  daysOfWeek,
  defaultVehicleId: z.uuid().nullish(),
});

export const createScheduleInput = versionFields.extend({
  routeId: z.uuid(),
  name: name(),
  bookingOpenDaysBefore: z.number().int().min(1).max(365).nullish(),
});
export const newVersionInput = versionFields;
export const scheduleStatusInput = z.object({ status: z.enum(["active", "paused", "archived"]) });
export const listSchedulesQuery = z.object({ status: z.enum(["active", "paused", "archived"]).optional() });
export const exceptionInput = z
  .object({
    serviceDate,
    kind: z.enum(["skip", "move", "extra"]),
    departureTime: localTime.nullish(),
    reason: z.string().trim().min(2).max(300),
  })
  .refine((v) => (v.kind === "skip") === !v.departureTime, {
    message: "Give a departure time for a moved or extra run, and none for a skipped day.",
    path: ["departureTime"],
  });

export async function listSchedules(tx: Tx, query: z.infer<typeof listSchedulesQuery> & PageQuery) {
  const rows = await tx<(ScheduleSummary & { totalCount: number })[]>`
    select s.id, s.name, s.status, s.route_id, r.name as route_name, s.current_version,
           to_char(v.departure_time, 'HH24:MI') as departure_time, v.days_of_week::int[] as days_of_week,
           veh.registration as default_vehicle_registration,
           count(*) over () as total_count
    from app.schedules s
    join app.routes r on r.id = s.route_id
    join app.schedule_versions v on v.schedule_id = s.id and v.version = s.current_version
    left join app.vehicles veh on veh.id = v.default_vehicle_id
    where (${query.status ?? null}::text is null or s.status = ${query.status ?? null})
    order by s.status = 'archived', r.name, v.departure_time
    limit ${query.pageSize} offset ${offsetOf(query)}`;
  return pageFrom(rows, query);
}

export async function getSchedule(tx: Tx, id: string): Promise<Schedule> {
  const schedule = one(await tx<Omit<Schedule, "versions" | "exceptions" | "upcomingJourneys">[]>`
    select s.id, s.name, s.status, s.route_id, r.name as route_name, s.current_version, s.booking_open_days_before,
           s.created_at, to_char(v.departure_time, 'HH24:MI') as departure_time, v.days_of_week::int[] as days_of_week,
           veh.registration as default_vehicle_registration
    from app.schedules s
    join app.routes r on r.id = s.route_id
    join app.schedule_versions v on v.schedule_id = s.id and v.version = s.current_version
    left join app.vehicles veh on veh.id = v.default_vehicle_id
    where s.id = ${id}`);
  const versions = await tx<ScheduleVersion[]>`
    select v.version, to_char(v.departure_time, 'HH24:MI') as departure_time, v.days_of_week::int[] as days_of_week,
           v.default_vehicle_id, veh.registration as default_vehicle_registration, v.created_at
    from app.schedule_versions v left join app.vehicles veh on veh.id = v.default_vehicle_id
    where v.schedule_id = ${id} order by v.version desc`;
  const exceptions = await tx<ScheduleException[]>`
    select id, service_date::text as service_date, kind, to_char(departure_time, 'HH24:MI') as departure_time, reason
    from app.schedule_exceptions where schedule_id = ${id} and service_date >= current_date - 1
    order by service_date`;
  const [{ upcoming }] = await tx<{ upcoming: number }[]>`
    select count(*)::int as upcoming from app.journeys
    where schedule_id = ${id} and scheduled_departure_at > now() and state <> 'CANCELLED'`;
  return { ...schedule, versions: [...versions], exceptions: [...exceptions], upcomingJourneys: upcoming };
}

export async function createSchedule(tx: Tx, actorId: string, input: z.infer<typeof createScheduleInput>) {
  const organisationId = await currentOrganisation(tx);
  const route = one(await tx<{ status: string }[]>`select status from app.routes where id = ${input.routeId}`);
  if (route.status !== "active") {
    throw new AppError("rule_violation", { message: "A schedule needs a live route." });
  }
  const schedule = one(await tx<{ id: string }[]>`
    insert into app.schedules ${tx({
      organisationId,
      routeId: input.routeId,
      name: input.name,
      bookingOpenDaysBefore: input.bookingOpenDaysBefore ?? null,
      createdBy: actorId,
    })}
    returning id`);
  await insertVersion(tx, organisationId, schedule.id, actorId, input);
  return getSchedule(tx, schedule.id);
}

/** An edit is a new version (23.1). Returns the schedule and what the change would do to generated journeys. */
export async function newScheduleVersion(tx: Tx, actorId: string, id: string, input: z.infer<typeof newVersionInput>) {
  const schedule = one(await tx<{ organisationId: string; status: string }[]>`
    select organisation_id, status from app.schedules where id = ${id} for update`);
  if (schedule.status === "archived") throw new AppError("rule_violation", { message: "An archived schedule cannot be changed." });
  await insertVersion(tx, schedule.organisationId, id, actorId, input);
  return { schedule: await getSchedule(tx, id), impact: await previewScheduleChange(tx, id) };
}

async function insertVersion(tx: Tx, organisationId: string, scheduleId: string, actorId: string, input: z.infer<typeof versionFields>) {
  await tx`
    insert into app.schedule_versions (organisation_id, schedule_id, version, departure_time, days_of_week, default_vehicle_id, created_by)
    values (${organisationId}, ${scheduleId}, 1, ${input.departureTime}::time, ${input.daysOfWeek}::smallint[],
            ${input.defaultVehicleId ?? null}, ${actorId})`;
}

/** A journey (alias j) with a booking that is held, being paid, paid or travelled. Such journeys are never moved or cancelled by a schedule change. */
const hasLiveBookings = (tx: Tx) =>
  tx`exists (select 1 from app.bookings b where b.journey_id = j.id and b.state in ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'COMPLETED'))`;

type Affected = {
  id: string;
  serviceDate: string;
  state: string;
  scheduledDepartureAt: Date;
  newDepartureAt: Date | null;
  newArrivalAt: Date | null;
  hasBookings: boolean;
};

/**
 * What applying the current version would do to journeys already generated
 * from older versions (23.1): journeys with bookings are never touched here.
 */
export async function previewScheduleChange(tx: Tx, id: string) {
  const rows = await affectedJourneys(tx, id);
  const unbooked = rows.filter((r) => !r.hasBookings);
  return {
    toRetime: unbooked.filter((r) => r.newDepartureAt && r.newDepartureAt.getTime() !== r.scheduledDepartureAt.getTime()).length,
    toCancel: unbooked.filter((r) => !r.newDepartureAt).length,
    unchangedBecauseBooked: rows.filter((r) => r.hasBookings).length,
    journeys: rows,
  };
}

/** Applies the current version to unbooked journeys generated from older versions, after the manager confirms. */
export async function applyScheduleChange(tx: Tx, id: string) {
  const rows = await affectedJourneys(tx, id);
  const [schedule] = await tx<{ currentVersion: number }[]>`select current_version from app.schedules where id = ${id}`;
  let retimed = 0;
  let cancelled = 0;
  for (const journey of rows) {
    if (journey.hasBookings) continue;
    if (!journey.newDepartureAt || !journey.newArrivalAt) {
      await tx`select app.move_journey(${journey.id}, 'CANCELLED', 'The schedule no longer runs on this day')`;
      cancelled++;
      continue;
    }
    await tx`
      update app.journeys
      set scheduled_departure_at = ${journey.newDepartureAt}, scheduled_arrival_at = ${journey.newArrivalAt},
          schedule_version = ${schedule.currentVersion}
      where id = ${journey.id}`;
    retimed++;
  }
  return { retimed, cancelled, unchangedBecauseBooked: rows.filter((r) => r.hasBookings).length };
}

async function affectedJourneys(tx: Tx, scheduleId: string): Promise<Affected[]> {
  return [
    ...(await tx<Affected[]>`
      with s as (
        select s.id, s.current_version, v.departure_time, v.days_of_week, o.timezone,
               (select max(arrival_offset_minutes) from app.route_stops where route_id = s.route_id) as duration
        from app.schedules s
        join app.schedule_versions v on v.schedule_id = s.id and v.version = s.current_version
        join app.organisations o on o.id = s.organisation_id
        where s.id = ${scheduleId}
      ),
      planned as (
        select j.id, j.service_date, j.state, j.scheduled_departure_at, s.timezone, s.duration,
               ${hasLiveBookings(tx)} as has_bookings,
               case
                 when e.kind = 'skip' then null
                 when e.kind in ('move', 'extra') then e.departure_time
                 when extract(isodow from j.service_date)::smallint = any(s.days_of_week) then s.departure_time
               end as new_time
        from app.journeys j
        join s on s.id = j.schedule_id
        left join app.schedule_exceptions e on e.schedule_id = j.schedule_id and e.service_date = j.service_date
        where j.state in ('DRAFT', 'SCHEDULED') and j.scheduled_departure_at > now()
          and j.schedule_version < s.current_version
      )
      select id, service_date::text as service_date, state, scheduled_departure_at,
             (service_date + new_time) at time zone timezone as new_departure_at,
             (service_date + new_time) at time zone timezone + make_interval(mins => duration) as new_arrival_at,
             has_bookings
      from planned
      order by service_date`),
  ];
}

export async function setScheduleStatus(tx: Tx, id: string, input: z.infer<typeof scheduleStatusInput>) {
  one(await tx`update app.schedules set status = ${input.status} where id = ${id} returning id`);
  return getSchedule(tx, id);
}

/**
 * Adds a holiday or one-off change (23.1 rule 4). If the day's journey was
 * already generated and has no bookings, it follows the exception now; if it
 * has bookings it is left alone and raised for a manager's decision.
 */
export async function addScheduleException(tx: Tx, actorId: string, scheduleId: string, input: z.infer<typeof exceptionInput>) {
  const schedule = one(await tx<{ organisationId: string }[]>`select organisation_id from app.schedules where id = ${scheduleId}`);
  await tx`
    insert into app.schedule_exceptions ${tx({
      organisationId: schedule.organisationId,
      scheduleId,
      serviceDate: input.serviceDate,
      kind: input.kind,
      departureTime: input.departureTime ?? null,
      reason: input.reason,
      createdBy: actorId,
    })}`;

  const [journey] = await tx<{ id: string; state: string; booked: boolean; label: string }[]>`
    select j.id, j.state, ${hasLiveBookings(tx)} as booked, app.journey_label(j.id) as label from app.journeys j
    where j.schedule_id = ${scheduleId} and j.service_date = ${input.serviceDate} and j.state in ('DRAFT', 'SCHEDULED')`;
  let notice: string | null = null;
  if (journey?.booked) {
    // Passengers have seats on that day's departure: it stays as it is, and a manager decides (8.4, 15).
    notice = `The departure ${journey.label} already has passengers, so it was not changed. It is on the dashboard for a decision.`;
    await tx`select app.raise_exception(${schedule.organisationId}, 'schedule_change_on_booked_journey', 'high',
      ${`schedule_exception:${journey.id}:${input.kind}:${input.departureTime ?? ""}`},
      ${`Schedule change not applied: ${journey.label} has passengers (${input.reason})`},
      'Decide whether to keep this departure, move it, or cancel it with refunds.', null, ${journey.id})`;
  } else if (journey && input.kind === "skip") {
    await tx`select app.move_journey(${journey.id}, 'CANCELLED', ${input.reason})`;
  } else if (journey && input.departureTime) {
    await tx`
      update app.journeys j
      set scheduled_departure_at = (j.service_date + ${input.departureTime}::time) at time zone o.timezone,
          scheduled_arrival_at = (j.service_date + ${input.departureTime}::time) at time zone o.timezone
                                 + (j.scheduled_arrival_at - j.scheduled_departure_at)
      from app.organisations o
      where j.id = ${journey.id} and o.id = j.organisation_id`;
  } else if (!journey && input.kind !== "skip") {
    await tx`select * from app.generate_journeys(${schedule.organisationId}, ${input.serviceDate}::date, 1)`;
  }
  return { ...(await getSchedule(tx, scheduleId)), notice };
}

export async function removeScheduleException(tx: Tx, exceptionId: string) {
  const row = one(await tx<{ scheduleId: string }[]>`
    delete from app.schedule_exceptions where id = ${exceptionId} returning schedule_id`);
  return getSchedule(tx, row.scheduleId);
}
