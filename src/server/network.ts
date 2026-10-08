import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { offsetOf, pageFrom, type PageQuery } from "@/lib/api/pagination";
import type { Tx } from "@/lib/db";
import { definedOnly, ghanaPhone, name, one, optionalText, requireChanges } from "./common";
import type { Location, Route, RouteStop, RouteSummary } from "./types";

// ---------------------------------------------------------------------------
// Locations (spec 10.2): the controlled list used for search, never free text.
// ---------------------------------------------------------------------------

const locationFields = z.object({
  name: name(),
  locationType: z.enum(["terminal", "station", "stop"]),
  city: name(80),
  region: name(80),
  address: optionalText(300),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  description: optionalText(1000),
  contactPhone: ghanaPhone.nullish(),
});

export const createLocationInput = locationFields.refine((v) => (v.latitude == null) === (v.longitude == null), {
  message: "Give both latitude and longitude, or neither.",
  path: ["longitude"],
});
export const updateLocationInput = locationFields.partial().extend({ status: z.enum(["active", "inactive"]).optional() });
export const listLocationsQuery = z.object({
  status: z.enum(["active", "inactive"]).optional(),
  search: z.string().trim().max(60).optional(),
});

const locationColumns = (tx: Tx) =>
  tx`id, name, location_type, city, region, address, latitude::float8 as latitude, longitude::float8 as longitude,
     description, contact_phone, status, created_at, updated_at`;

export async function listLocations(tx: Tx, query: z.infer<typeof listLocationsQuery> & PageQuery) {
  const rows = await tx<(Location & { totalCount: number })[]>`
    select ${locationColumns(tx)}, count(*) over () as total_count
    from app.locations
    where (${query.status ?? null}::text is null or status = ${query.status ?? null})
      and (${query.search ?? null}::text is null or name ilike ${"%" + (query.search ?? "") + "%"} or city ilike ${"%" + (query.search ?? "") + "%"})
    order by lower(name)
    limit ${query.pageSize} offset ${offsetOf(query)}`;
  return pageFrom(rows, query);
}

export async function createLocation(tx: Tx, actorId: string, input: z.infer<typeof createLocationInput>): Promise<Location> {
  const organisationId = await currentOrganisation(tx);
  return one(await tx<Location[]>`
    insert into app.locations ${tx({ ...input, organisationId, createdBy: actorId })}
    returning ${locationColumns(tx)}`);
}

export async function updateLocation(tx: Tx, id: string, input: z.infer<typeof updateLocationInput>): Promise<Location> {
  const patch = definedOnly(input);
  requireChanges(patch);
  return one(await tx<Location[]>`update app.locations set ${tx(patch)} where id = ${id} returning ${locationColumns(tx)}`);
}

// ---------------------------------------------------------------------------
// Routes and stops (spec 10.2). Stops change only while the route is a draft;
// the database checks the stops when the route goes live.
// ---------------------------------------------------------------------------

export const createRouteInput = z.object({
  name: name(),
  originLocationId: z.uuid(),
  destinationLocationId: z.uuid(),
  distanceKm: z.number().positive().max(99999).nullish(),
});
export const updateRouteInput = createRouteInput.partial();
export const listRoutesQuery = z.object({ status: z.enum(["draft", "active", "archived"]).optional() });

export const routeStopsInput = z.object({
  stops: z
    .array(
      z.object({
        locationId: z.uuid(),
        arrivalOffsetMinutes: z.number().int().min(0).max(2880),
        departureOffsetMinutes: z.number().int().min(0).max(2880),
        boardingAllowed: z.boolean(),
        dropoffAllowed: z.boolean(),
      }),
    )
    .min(2, "A route needs at least two stops.")
    .max(50),
});

export async function listRoutes(tx: Tx, query: z.infer<typeof listRoutesQuery> & PageQuery) {
  const rows = await tx<(RouteSummary & { totalCount: number })[]>`
    select r.id, r.name, r.status, r.distance_km::float8 as distance_km,
           o.name as origin_name, d.name as destination_name,
           (select max(arrival_offset_minutes) from app.route_stops s where s.route_id = r.id) as duration_minutes,
           (select count(*)::int from app.route_stops s where s.route_id = r.id) as stop_count,
           count(*) over () as total_count
    from app.routes r
    join app.locations o on o.id = r.origin_location_id
    join app.locations d on d.id = r.destination_location_id
    where (${query.status ?? null}::text is null or r.status = ${query.status ?? null})
    order by r.status = 'archived', lower(r.name)
    limit ${query.pageSize} offset ${offsetOf(query)}`;
  return pageFrom(rows, query);
}

/** A route with its ordered stops. Duration is derived from the last stop, never stored. */
export async function getRoute(tx: Tx, id: string): Promise<Route> {
  const route = one(await tx<Omit<Route, "durationMinutes" | "stops">[]>`
    select r.id, r.name, r.status, r.distance_km::float8 as distance_km, r.origin_location_id, r.destination_location_id,
           r.activated_at, r.archived_at, r.created_at, r.updated_at
    from app.routes r where r.id = ${id}`);
  const stops = await tx<RouteStop[]>`
    select s.id, s.sequence, s.location_id, l.name as location_name, l.city,
           s.arrival_offset_minutes, s.departure_offset_minutes, s.boarding_allowed, s.dropoff_allowed
    from app.route_stops s join app.locations l on l.id = s.location_id
    where s.route_id = ${id}
    order by s.sequence`;
  const durationMinutes = stops.length ? stops[stops.length - 1].arrivalOffsetMinutes : null;
  return { ...route, durationMinutes, stops: [...stops] };
}

export async function createRoute(tx: Tx, actorId: string, input: z.infer<typeof createRouteInput>) {
  const organisationId = await currentOrganisation(tx);
  const route = one(await tx<{ id: string }[]>`
    insert into app.routes ${tx({ ...definedOnly(input), organisationId, createdBy: actorId })}
    returning id`);
  return getRoute(tx, route.id);
}

export async function updateRoute(tx: Tx, id: string, input: z.infer<typeof updateRouteInput>) {
  const patch = definedOnly(input);
  requireChanges(patch);
  one(await tx`update app.routes set ${tx(patch)} where id = ${id} returning id`);
  return getRoute(tx, id);
}

/** Replaces all stops of a draft route, in the order given. */
export async function replaceRouteStops(tx: Tx, id: string, input: z.infer<typeof routeStopsInput>) {
  const route = one(await tx<{ id: string; organisationId: string; status: string }[]>`
    select id, organisation_id, status from app.routes where id = ${id} for update`);
  if (route.status !== "draft") {
    throw new AppError("rule_violation", { message: "Stops can only be changed while the route is a draft." });
  }
  await tx`delete from app.route_stops where route_id = ${id}`;
  const rows = input.stops.map((stop, index) => ({
    ...stop,
    organisationId: route.organisationId,
    routeId: id,
    sequence: index + 1,
  }));
  await tx`insert into app.route_stops ${tx(rows)}`;
  return getRoute(tx, id);
}

export async function setRouteStatus(tx: Tx, id: string, status: "active" | "archived") {
  one(await tx`update app.routes set status = ${status} where id = ${id} returning id`);
  return getRoute(tx, id);
}

async function currentOrganisation(tx: Tx): Promise<string> {
  const [row] = await tx`select app.current_organisation_id() as id`;
  if (!row?.id) throw new AppError("internal_error", { message: "No organisation set for this transaction." });
  return row.id as string;
}

export { currentOrganisation };
