import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { hasPermission, type Actor } from "@/lib/auth/permissions";
import type { Tx } from "@/lib/db";
import { normaliseGhanaPhone } from "@/lib/phone";
import { boardingCodeHash, credentialSecrets, sha256 } from "./credentials";

/**
 * Boarding (spec 14.3 to 14.7). The database function app.board_ticket makes
 * every decision: the checks in the order of 14.3, the one boarding record
 * per ticket, and the audit of every refusal. This file finds the ticket
 * (by QR token, boarding code or lookup) and shapes the answers for staff.
 */

export const scanInput = z.object({
  token: z.string().trim().min(10).max(200),
  /** False: only check and show the passenger. True: board them. */
  confirm: z.boolean().default(false),
});
export const boardInput = z.object({ ticketId: z.uuid(), confirm: z.boolean().default(false) });
export const overrideInput = z.object({ ticketId: z.uuid(), reason: z.string().trim().min(5).max(500) });
export const lookupQuery = z.object({ q: z.string().trim().min(2).max(120) });
export const statusInput = z.object({ to: z.enum(["BOARDING", "DEPARTED", "COMPLETED"]) });
export const paperEntriesInput = z.object({
  entries: z
    .array(z.object({ ticketId: z.uuid(), boardedAt: z.iso.datetime({ offset: true }) }))
    .min(1)
    .max(120),
});
export const exportParams = z.object({ id: z.uuid(), exportId: z.uuid() });

export type BoardingTicket = {
  ticketId: string;
  ticketNumber: string;
  reference: string;
  passengerName: string;
  seatNumber: string;
  boardingStop: string;
  destination: string;
  fareType: string;
  checkStudentId: boolean;
};

export type BoardingResult = {
  outcome: "ok" | "boarded" | "refused";
  code: string | null;
  message: string | null;
  ticket: BoardingTicket | null;
};

/**
 * Staff see a journey's passengers only when they are on its crew, or when
 * they may look up bookings across the organisation (station agents, managers).
 */
export async function requireJourneyAccess(tx: Tx, actor: Actor, journeyId: string): Promise<void> {
  const [journey] = await tx<{ onCrew: boolean }[]>`
    select exists (select 1 from app.journey_staff s where s.journey_id = j.id and s.user_id = ${actor.userId} and s.removed_at is null) as on_crew
    from app.journeys j where j.id = ${journeyId}`;
  if (!journey) throw new AppError("not_found", { message: "That journey does not exist." });
  if (!journey.onCrew && !hasPermission(actor, "booking.view.scope")) {
    throw new AppError("forbidden", { message: "You are not on this journey's crew." });
  }
}

export type StaffJourney = {
  id: string;
  routeName: string;
  scheduledDepartureAt: Date;
  state: string;
  vehicleRegistration: string | null;
  crewRole: string | null;
  ticketsSold: number;
  boarded: number;
  openSheets: number;
};

/** Today's and tomorrow's journeys: the actor's own, or all of them for staff with organisation-wide lookup. */
export async function listStaffJourneys(tx: Tx, actor: Actor): Promise<StaffJourney[]> {
  const all = hasPermission(actor, "booking.view.scope");
  return tx<StaffJourney[]>`
    select j.id, r.name as route_name, j.scheduled_departure_at, j.state, v.registration as vehicle_registration,
           s.staff_role as crew_role,
           (select count(*)::int from app.tickets t where t.journey_id = j.id and t.state in ('VALID', 'BOARDED')) as tickets_sold,
           (select count(*)::int from app.tickets t where t.journey_id = j.id and t.state = 'BOARDED') as boarded,
           (select count(*)::int from app.manifest_exports m where m.journey_id = j.id and m.entered_at is null) as open_sheets
    from app.journeys j
    join app.routes r on r.id = j.route_id
    left join app.vehicle_assignments a on a.journey_id = j.id and a.state = 'ACTIVE'
    left join app.vehicles v on v.id = a.vehicle_id
    left join app.journey_staff s on s.journey_id = j.id and s.user_id = ${actor.userId} and s.removed_at is null
    where j.service_date between (now() at time zone 'Africa/Accra')::date - 1 and (now() at time zone 'Africa/Accra')::date + 1
      and j.state not in ('DRAFT', 'CANCELLED')
      and (${all} or s.id is not null)
    order by j.scheduled_departure_at`;
}

export type ManifestRow = BoardingTicket & {
  state: "VALID" | "BOARDED";
  boardedAt: Date | null;
  boardedBy: string | null;
  method: string | null;
  paymentConfirmed: boolean;
};

export type Manifest = {
  journey: { id: string; label: string; state: string; scheduledDepartureAt: Date; vehicleRegistration: string | null };
  rows: ManifestRow[];
  openSheets: { id: string; sheetNumber: number; exportedAt: Date }[];
};

/** The passengers of one journey (14.5): no more personal data than boarding needs. */
export async function getManifest(tx: Tx, journeyId: string): Promise<Manifest> {
  const [journey] = await tx<Manifest["journey"][]>`
    select j.id, app.journey_label(j.id) as label, j.state, j.scheduled_departure_at, v.registration as vehicle_registration
    from app.journeys j
    left join app.vehicle_assignments a on a.journey_id = j.id and a.state = 'ACTIVE'
    left join app.vehicles v on v.id = a.vehicle_id
    where j.id = ${journeyId}`;
  if (!journey) throw new AppError("not_found", { message: "That journey does not exist." });
  const rows = await tx<ManifestRow[]>`
    select t.id as ticket_id, t.ticket_number, b.reference, p.full_name as passenger_name, js.seat_number,
           lo.name as boarding_stop, ld.name as destination, coalesce(ct.name, 'Standard') as fare_type,
           coalesce(ct.check_at_boarding, false) as check_student_id, t.state,
           r.boarded_at, split_part(u.full_name, ' ', 1) as boarded_by, r.method,
           (b.state in ('CONFIRMED', 'COMPLETED')
             and exists (select 1 from app.payments pay where pay.booking_id = b.id and pay.state = 'RECEIVED')
             and not exists (select 1 from app.payments pay where pay.booking_id = b.id and pay.state = 'REVERSED')) as payment_confirmed
    from app.tickets t
    join app.booked_seats s on s.id = t.booked_seat_id
    join app.bookings b on b.id = s.booking_id
    join app.booking_passengers p on p.id = s.passenger_id
    join app.journey_seats js on js.id = s.journey_seat_id
    join app.route_stops so on so.id = s.origin_stop_id
    join app.locations lo on lo.id = so.location_id
    join app.route_stops sd on sd.id = s.destination_stop_id
    join app.locations ld on ld.id = sd.location_id
    left join app.concession_types ct on ct.id = s.concession_type_id
    left join app.boarding_records r on r.ticket_id = t.id
    left join app.users u on u.id = r.boarded_by
    where t.journey_id = ${journeyId} and t.state in ('VALID', 'BOARDED')
    order by so.sequence, length(js.seat_number), js.seat_number`;
  const openSheets = await tx<Manifest["openSheets"]>`
    select id, sheet_number, exported_at from app.manifest_exports
    where journey_id = ${journeyId} and entered_at is null order by sheet_number`;
  return { journey, rows, openSheets };
}

async function boardTicket(
  tx: Tx,
  journeyId: string,
  ticketId: string | null,
  method: "scan" | "manual" | "override" | "manual_offline",
  options: { checkOnly?: boolean; deviceTime?: string; exportId?: string } = {},
): Promise<BoardingResult> {
  const [row] = await tx<{ result: BoardingResult }[]>`
    select app.board_ticket(${journeyId}, ${ticketId}, ${method}, ${options.checkOnly ?? false},
                            ${options.deviceTime ?? null}, ${options.exportId ?? null}) as result`;
  return row.result;
}

/** Scan (14.3): the QR token is hashed and matched against current credentials only. */
export async function scanTicket(tx: Tx, journeyId: string, input: z.infer<typeof scanInput>): Promise<BoardingResult> {
  const token = input.token.replace(/^.*\/t\//, "");
  const [credential] = await tx<{ ticketId: string }[]>`
    select ticket_id from app.ticket_credentials where token_hash = ${sha256(token)} and revoked_at is null`;
  return boardTicket(tx, journeyId, credential?.ticketId ?? null, "scan", { checkOnly: !input.confirm });
}

/** Manual boarding after a lookup (14.4). */
export function boardManually(tx: Tx, journeyId: string, input: z.infer<typeof boardInput>): Promise<BoardingResult> {
  return boardTicket(tx, journeyId, input.ticketId, "manual", { checkOnly: !input.confirm });
}

/** Boarding against a failed check (ticket.override.board); the reason is already set on the transaction. */
export function boardWithOverride(tx: Tx, journeyId: string, input: z.infer<typeof overrideInput>): Promise<BoardingResult> {
  return boardTicket(tx, journeyId, input.ticketId, "override");
}

/**
 * Manual lookup (14.4) on one journey's manifest: by booking reference,
 * ticket number, boarding code, phone number or name.
 */
export async function lookupPassengers(tx: Tx, secret: string | undefined, journeyId: string, q: string): Promise<ManifestRow[]> {
  const manifest = await getManifest(tx, journeyId);
  const text = q.trim();
  const upper = text.toUpperCase().replace(/[\s-]/g, "");
  const phone = normaliseGhanaPhone(text);
  const lower = text.toLowerCase();

  let codeMatches = new Set<string>();
  if (secret && /^[2-9A-HJ-NP-Z]{6}$/.test(upper)) {
    const credentials = await tx<{ ticketId: string; boardingCodeHash: Buffer }[]>`
      select c.ticket_id, c.boarding_code_hash from app.ticket_credentials c join app.tickets t on t.id = c.ticket_id
      where t.journey_id = ${journeyId} and c.revoked_at is null`;
    const numbers = new Map(manifest.rows.map((r) => [r.ticketId, r.ticketNumber]));
    codeMatches = new Set(
      credentials
        .filter((c) => numbers.has(c.ticketId) && boardingCodeHash(numbers.get(c.ticketId)!, upper).equals(c.boardingCodeHash))
        .map((c) => c.ticketId),
    );
  }

  let phoneMatches = new Set<string>();
  if (phone) {
    const rows = await tx<{ ticketId: string }[]>`
      select t.id as ticket_id from app.tickets t
      join app.booked_seats s on s.id = t.booked_seat_id
      join app.bookings b on b.id = s.booking_id
      join app.booking_passengers p on p.id = s.passenger_id
      where t.journey_id = ${journeyId} and (p.phone = ${phone} or b.purchaser_phone = ${phone})`;
    phoneMatches = new Set(rows.map((r) => r.ticketId));
  }

  return manifest.rows.filter(
    (r) =>
      r.reference === upper ||
      r.ticketNumber === upper ||
      codeMatches.has(r.ticketId) ||
      phoneMatches.has(r.ticketId) ||
      (lower.length >= 3 && r.passengerName.toLowerCase().includes(lower)),
  );
}

export type PaperManifest = {
  sheetNumber: number;
  exportId: string;
  exportedAt: Date;
  journey: Manifest["journey"];
  rows: (ManifestRow & { boardingCode: string | null })[];
};

/** A numbered, audited paper manifest (14.7) with each passenger's boarding code. */
export async function exportPaperManifest(tx: Tx, secret: string | undefined, journeyId: string): Promise<PaperManifest> {
  const [sheet] = await tx<{ id: string; sheetNumber: number; exportedAt: Date }[]>`
    select (e).id, (e).sheet_number, (e).exported_at from (select app.export_manifest(${journeyId}) as e) x`;
  const manifest = await getManifest(tx, journeyId);
  const credentials = await tx<{ ticketId: string; id: string }[]>`
    select c.ticket_id, c.id from app.ticket_credentials c join app.tickets t on t.id = c.ticket_id
    where t.journey_id = ${journeyId} and c.revoked_at is null`;
  const byTicket = new Map(credentials.map((c) => [c.ticketId, c.id]));
  return {
    sheetNumber: sheet.sheetNumber,
    exportId: sheet.id,
    exportedAt: sheet.exportedAt,
    journey: manifest.journey,
    rows: manifest.rows.map((r) => {
      const credentialId = byTicket.get(r.ticketId);
      return { ...r, boardingCode: secret && credentialId ? credentialSecrets(secret, credentialId).boardingCode : null };
    }),
  };
}

/**
 * Paper boardings entered after the trip (14.7 step 3), method manual_offline.
 * Each is applied once; a ticket already boarded is refused, and one cancelled
 * after the sheet was printed is flagged as an exception.
 */
export async function enterPaperBoardings(tx: Tx, journeyId: string, exportId: string, input: z.infer<typeof paperEntriesInput>) {
  const results: (BoardingResult & { ticketId: string })[] = [];
  for (const entry of input.entries) {
    const result = await boardTicket(tx, journeyId, entry.ticketId, "manual_offline", { deviceTime: entry.boardedAt, exportId });
    results.push({ ...result, ticketId: entry.ticketId });
  }
  return {
    boarded: results.filter((r) => r.outcome === "boarded").length,
    refused: results.filter((r) => r.outcome === "refused").length,
    results,
  };
}

export async function closePaperManifest(tx: Tx, journeyId: string, exportId: string) {
  const [sheet] = await tx`select 1 from app.manifest_exports where id = ${exportId} and journey_id = ${journeyId}`;
  if (!sheet) throw new AppError("not_found", { message: "That sheet is not for this journey." });
  await tx`select app.close_manifest_export(${exportId})`;
  return { closed: true };
}

/** Start boarding, record departure, record arrival (journey.update.status). */
export async function updateJourneyStatus(tx: Tx, journeyId: string, input: z.infer<typeof statusInput>) {
  await tx`select app.update_journey_status(${journeyId}, ${input.to})`;
  const [journey] = await tx<{ state: string }[]>`select state from app.journeys where id = ${journeyId}`;
  return { id: journeyId, state: journey.state };
}
