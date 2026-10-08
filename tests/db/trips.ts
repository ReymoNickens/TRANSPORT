import { withOrganisation, type Tx } from "@/lib/db";
import { FakePaymentProvider } from "@/providers/payments/fake";
import { createLayout, createVehicle, createVehicleInput, publishLayout } from "@/server/fleet";
import { createOneOffJourney, publishJourney } from "@/server/journeys";
import { holdInput, holdSeats } from "@/server/bookings";
import { applyPaymentResult, startPayment } from "@/server/payments";
import { credentialSecrets } from "@/server/credentials";
import { as, daysFromToday, liveCorridor, type Operator } from "./fixtures";
import type { Sql } from "./helpers";

export type Trip = { journeyId: string; stops: { id: string }[]; seatMap: Map<string, string> };
export type Ticket = { id: string; ticketNumber: string; qr: string; code: string; reference: string; bookingId: string; phone: string };

const provider = new FakePaymentProvider("https://transport.test");
let phoneCounter = 0;

/**
 * Journeys on sale and paid bookings, made through the same services the API
 * uses. `prefix` keeps phone numbers apart between test files.
 */
export function trips(op: Operator, owner: Sql, prefix: string) {
  const secret = process.env.TICKET_TOKEN_SECRET!;
  const nextPhone = () => `+233${prefix}${String(1_000_000 + ++phoneCounter).padStart(7, "0")}`;

  /** A live corridor and a 90-seat 2+1 coach, departing tomorrow (or `day` days ahead) at `time` UTC, on sale. */
  async function newTrip(suffix: string, registration: string, time = "08:00", day = 1): Promise<Trip> {
    const corridor = await liveCorridor(op, suffix);
    const bus = await as(op, async (tx: Tx) => {
      const vehicle = await createVehicle(tx, op.actorUserId, createVehicleInput.parse({ registration, vehicleType: "coach", capacity: 90 }));
      const layout = await createLayout(tx, op.actorUserId, vehicle.id, { name: "2+1", pattern: { left: 2, right: 1, rows: 30, fullBackRow: false } });
      await publishLayout(tx, layout.id);
      return vehicle.id;
    });
    const journey = await as(op, (tx: Tx) =>
      createOneOffJourney(tx, op.actorUserId, { routeId: corridor.routeId, departureAt: `${daysFromToday(day)}T${time}:00Z`, vehicleId: bus }),
    );
    await as(op, (tx: Tx) => publishJourney(tx, journey.id));
    const seats = await owner`select id, seat_number from app.journey_seats where journey_id = ${journey.id}`;
    return { journeyId: journey.id, stops: corridor.stops, seatMap: new Map(seats.map((s) => [s.seat_number as string, s.id as string])) };
  }

  /** A paid booking with tickets and their QR tokens and boarding codes. */
  async function bookAndPay(t: Trip, seatNumbers: string[], options: { name?: string; concession?: string } = {}): Promise<Ticket[]> {
    const phone = nextPhone();
    const input = holdInput.parse({
      journeyId: t.journeyId,
      originStopId: t.stops[0].id,
      destinationStopId: t.stops[2].id,
      purchaser: { name: "Ama Mensah", phone },
      seats: seatNumbers.map((n) => ({
        journeySeatId: t.seatMap.get(n),
        passenger: { fullName: options.name ?? `Passenger ${n}`, phone, concession: options.concession ?? null, concessionReference: options.concession ? "UCC/2026/001" : null },
      })),
    });
    const ctx = { organisationId: op.organisationId, correlationId: "test" };
    const held = await withOrganisation(ctx, (tx) => holdSeats(tx, input, { userId: null, address: null, source: "passenger_app" }), op.app);
    const [booking] = await owner`select id from app.bookings where reference = ${held.reference}`;
    await startPayment(ctx, provider, booking.id, { method: "any" }, op.app);
    const [attempt] = await owner`select id, amount_pesewas from app.payment_attempts where booking_id = ${booking.id} order by started_at desc limit 1`;
    await applyPaymentResult(ctx, attempt.id, { status: "success", amountPesewas: Number(attempt.amount_pesewas), currency: "GHS", providerFeePesewas: 0, providerReference: null }, op.app);
    const rows = await owner`
      select t.id, t.ticket_number, c.id as credential_id
      from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id
      join app.ticket_credentials c on c.ticket_id = t.id and c.revoked_at is null
      join app.journey_seats js on js.id = s.journey_seat_id
      where s.booking_id = ${booking.id} order by js.seat_number`;
    return rows.map((r) => {
      const secrets = credentialSecrets(secret, r.credential_id);
      return { id: r.id, ticketNumber: r.ticket_number, qr: secrets.qrToken, code: secrets.boardingCode, reference: held.reference, bookingId: booking.id, phone };
    });
  }

  return { newTrip, bookAndPay };
}

/** Runs as a staff member, optionally with a reason (as a high-risk route would). */
export function staff<T>(who: Operator, fn: (tx: Tx) => Promise<T>, options: { reason?: string; sql?: Sql } = {}) {
  return withOrganisation(
    { organisationId: who.organisationId, actorUserId: who.actorUserId, correlationId: "test", reason: options.reason, device: "test-device" },
    fn,
    options.sql ?? who.app,
  );
}
