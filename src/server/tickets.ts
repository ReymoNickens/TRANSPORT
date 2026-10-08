import type { Tx } from "@/lib/db";
import { credentialSecrets, sha256 } from "./credentials";

export type TicketView = {
  ticketNumber: string;
  state: string;
  bookingReference: string;
  passengerName: string;
  seatNumber: string;
  fareType: string;
  checkStudentId: boolean;
  routeName: string;
  originName: string;
  destinationName: string;
  departsAt: Date;
  qrToken: string | null;
  boardingCode: string | null;
};

/**
 * The ticket behind a text-message link (14.2). The link token is a
 * separate secret from the QR, and only its hash is stored. A revoked or
 * replaced credential's link no longer works.
 */
export async function getTicketByLink(tx: Tx, linkToken: string, secret: string): Promise<TicketView | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(linkToken)) return null;
  const [row] = await tx<(Omit<TicketView, "qrToken" | "boardingCode"> & { credentialId: string })[]>`
    select c.id as credential_id, t.ticket_number, t.state, b.reference as booking_reference,
           p.full_name as passenger_name, js.seat_number, coalesce(ct.name, 'Standard') as fare_type,
           coalesce(ct.check_at_boarding, false) as check_student_id,
           r.name as route_name, ol.name as origin_name, dl.name as destination_name,
           j.scheduled_departure_at + make_interval(mins => o.departure_offset_minutes) as departs_at
    from app.ticket_credentials c
    join app.tickets t on t.id = c.ticket_id
    join app.booked_seats s on s.id = t.booked_seat_id
    join app.bookings b on b.id = s.booking_id
    join app.booking_passengers p on p.id = s.passenger_id
    join app.journey_seats js on js.id = s.journey_seat_id
    left join app.concession_types ct on ct.id = s.concession_type_id
    join app.journeys j on j.id = s.journey_id
    join app.routes r on r.id = j.route_id
    join app.route_stops o on o.id = s.origin_stop_id join app.locations ol on ol.id = o.location_id
    join app.route_stops d on d.id = s.destination_stop_id join app.locations dl on dl.id = d.location_id
    where c.link_token_hash = ${sha256(linkToken)} and c.revoked_at is null`;
  if (!row) return null;
  const { credentialId, ...ticket } = row;
  const secrets = ticket.state === "VALID" ? credentialSecrets(secret, credentialId) : null;
  return { ...ticket, qrToken: secrets?.qrToken ?? null, boardingCode: secrets?.boardingCode ?? null };
}

export type TripSummary = {
  reference: string;
  state: string;
  routeName: string;
  originName: string;
  destinationName: string;
  departsAt: Date;
  seats: number;
};

/** The signed-in passenger's bookings, upcoming first (7.9). */
export async function listMyBookings(tx: Tx, userId: string): Promise<TripSummary[]> {
  return [
    ...(await tx<TripSummary[]>`
      select b.reference, b.state, r.name as route_name, ol.name as origin_name, dl.name as destination_name,
             j.scheduled_departure_at + make_interval(mins => o.departure_offset_minutes) as departs_at,
             (select count(*)::int from app.booked_seats s where s.booking_id = b.id) as seats
      from app.bookings b
      join app.journeys j on j.id = b.journey_id
      join app.routes r on r.id = b.route_id
      join app.route_stops o on o.id = b.origin_stop_id join app.locations ol on ol.id = o.location_id
      join app.route_stops d on d.id = b.destination_stop_id join app.locations dl on dl.id = d.location_id
      where b.user_id = ${userId} and b.state <> 'EXPIRED'
      order by j.scheduled_departure_at < now(), j.scheduled_departure_at
      limit 50`),
  ];
}
