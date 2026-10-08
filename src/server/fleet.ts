import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { offsetOf, pageFrom, type PageQuery } from "@/lib/api/pagination";
import type { Tx } from "@/lib/db";
import { generateSeatGrid } from "@/domain/seat-grid";
import { definedOnly, one, optionalText, requireChanges, seatType } from "./common";
import { currentOrganisation } from "./network";
import type { Layout, LayoutSummary, Seat, Vehicle, VehicleSummary } from "./types";

// ---------------------------------------------------------------------------
// Vehicles (spec 10.2)
// ---------------------------------------------------------------------------

/** "gr 1234-22" → "GR-1234-22" */
const registration = z
  .string()
  .transform((v) => v.trim().toUpperCase().replace(/\s+/g, "-"))
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,14}$/, "Enter the registration as on the number plate, for example GR-1234-22."));

const vehicleFields = z.object({
  registration,
  fleetNumber: optionalText(20),
  name: optionalText(60),
  vehicleType: z.enum(["coach", "bus", "minibus"]),
  make: optionalText(60),
  model: optionalText(60),
  year: z.number().int().min(1980).max(2100).nullish(),
  capacity: z.number().int().min(1).max(100),
  notes: optionalText(2000),
});

export const createVehicleInput = vehicleFields;
export const updateVehicleInput = vehicleFields
  .omit({ registration: true })
  .partial()
  .extend({ status: z.enum(["active", "maintenance", "retired"]).optional() });
export const listVehiclesQuery = z.object({ status: z.enum(["active", "maintenance", "retired"]).optional() });

export async function listVehicles(tx: Tx, query: z.infer<typeof listVehiclesQuery> & PageQuery) {
  const rows = await tx<(VehicleSummary & { totalCount: number })[]>`
    select v.id, v.registration, v.fleet_number, v.name, v.vehicle_type, v.make, v.model, v.year, v.capacity, v.status,
           l.version as layout_version, l.name as layout_name,
           (select count(*)::int from app.seats s where s.layout_id = l.id and s.bookable) as bookable_seats,
           count(*) over () as total_count
    from app.vehicles v
    left join app.seat_layouts l on l.vehicle_id = v.id and l.status = 'published'
    where (${query.status ?? null}::text is null or v.status = ${query.status ?? null})
    order by v.status = 'retired', v.registration
    limit ${query.pageSize} offset ${offsetOf(query)}`;
  return pageFrom(rows, query);
}

export async function getVehicle(tx: Tx, id: string): Promise<Vehicle> {
  const vehicle = one(await tx<Omit<Vehicle, "layouts">[]>`
    select id, registration, fleet_number, name, vehicle_type, make, model, year, capacity, status, notes,
           retired_at, created_at, updated_at
    from app.vehicles where id = ${id}`);
  const layouts = await tx<LayoutSummary[]>`
    select l.id, l.version, l.name, l.status, l.row_count, l.column_count, l.published_at, l.retired_at,
           (select count(*)::int from app.seats s where s.layout_id = l.id and s.bookable) as bookable_seats
    from app.seat_layouts l where l.vehicle_id = ${id}
    order by l.version desc`;
  return { ...vehicle, layouts: [...layouts] };
}

export async function createVehicle(tx: Tx, actorId: string, input: z.infer<typeof createVehicleInput>) {
  const organisationId = await currentOrganisation(tx);
  const row = one(await tx<{ id: string }[]>`insert into app.vehicles ${tx({ ...input, organisationId, createdBy: actorId })} returning id`);
  return getVehicle(tx, row.id);
}

export async function updateVehicle(tx: Tx, id: string, input: z.infer<typeof updateVehicleInput>) {
  const patch = definedOnly(input);
  requireChanges(patch);
  one(await tx`update app.vehicles set ${tx(patch)} where id = ${id} returning id`);
  return getVehicle(tx, id);
}

// ---------------------------------------------------------------------------
// Seat layouts (spec 10.2): versioned; seats change only while a draft.
// ---------------------------------------------------------------------------

const seatInput = z.object({
  seatNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, "Seat numbers are 1 to 4 letters or digits."),
  rowNumber: z.number().int().min(1).max(30),
  columnNumber: z.number().int().min(1).max(8),
  seatType: seatType.default("standard"),
  position: z.enum(["window", "aisle", "middle"]).nullish(),
  bookable: z.boolean().default(true),
});

export const createLayoutInput = z.union([
  // From a familiar pattern, for example 2+2 with 13 rows.
  z.object({
    name: z.string().trim().min(1).max(60),
    pattern: z.object({
      left: z.number().int().min(1).max(7),
      right: z.number().int().min(0).max(6),
      rows: z.number().int().min(1).max(30),
      fullBackRow: z.boolean().default(false),
    }),
  }),
  // Or seat by seat.
  z.object({
    name: z.string().trim().min(1).max(60),
    rowCount: z.number().int().min(1).max(30),
    columnCount: z.number().int().min(1).max(8),
    seats: z.array(seatInput).min(1).max(100),
  }),
]);

export const replaceSeatsInput = z.object({ seats: z.array(seatInput).min(1).max(100) });

export async function getLayout(tx: Tx, id: string): Promise<Layout> {
  const layout = one(await tx<Omit<Layout, "seats">[]>`
    select l.id, l.vehicle_id, v.registration, v.capacity, l.version, l.name, l.status, l.row_count, l.column_count,
           l.published_at, l.retired_at, l.created_at
    from app.seat_layouts l join app.vehicles v on v.id = l.vehicle_id
    where l.id = ${id}`);
  const seats = await tx<Seat[]>`
    select id, seat_number, row_number, column_number, seat_type, position, bookable
    from app.seats where layout_id = ${id}
    order by row_number, column_number`;
  return { ...layout, seats: [...seats] };
}

export async function createLayout(tx: Tx, actorId: string, vehicleId: string, input: z.infer<typeof createLayoutInput>) {
  const vehicle = one(await tx<{ id: string; organisationId: string; status: string }[]>`
    select id, organisation_id, status from app.vehicles where id = ${vehicleId} for update`);
  if (vehicle.status === "retired") {
    throw new AppError("rule_violation", { message: "A retired vehicle cannot get a new seat layout." });
  }
  const grid =
    "pattern" in input
      ? generateSeatGrid(input.pattern)
      : { rowCount: input.rowCount, columnCount: input.columnCount, seats: input.seats };

  const layout = one(await tx<{ id: string }[]>`
    insert into app.seat_layouts ${tx({
      organisationId: vehicle.organisationId,
      vehicleId,
      version: 1, // replaced by the database with the next version number
      name: input.name,
      rowCount: grid.rowCount,
      columnCount: grid.columnCount,
      createdBy: actorId,
    })}
    returning id`);
  await insertSeats(tx, vehicle.organisationId, layout.id, grid.seats);
  return getLayout(tx, layout.id);
}

export async function replaceSeats(tx: Tx, layoutId: string, input: z.infer<typeof replaceSeatsInput>) {
  const layout = one(await tx<{ id: string; organisationId: string; status: string }[]>`
    select id, organisation_id, status from app.seat_layouts where id = ${layoutId} for update`);
  if (layout.status !== "draft") {
    throw new AppError("rule_violation", { message: "Seats can only be changed while the layout is a draft." });
  }
  await tx`delete from app.seats where layout_id = ${layoutId}`;
  await insertSeats(tx, layout.organisationId, layoutId, input.seats);
  return getLayout(tx, layoutId);
}

export async function publishLayout(tx: Tx, layoutId: string) {
  one(await tx`update app.seat_layouts set status = 'published' where id = ${layoutId} returning id`);
  return getLayout(tx, layoutId);
}

async function insertSeats(
  tx: Tx,
  organisationId: string,
  layoutId: string,
  seats: { seatNumber: string; rowNumber: number; columnNumber: number; seatType?: string; position?: string | null; bookable?: boolean }[],
) {
  const rows = seats.map((seat) => ({
    organisationId,
    layoutId,
    seatNumber: seat.seatNumber,
    rowNumber: seat.rowNumber,
    columnNumber: seat.columnNumber,
    seatType: seat.seatType ?? "standard",
    position: seat.position ?? null,
    bookable: seat.bookable ?? true,
  }));
  await tx`insert into app.seats ${tx(rows)}`;
}
