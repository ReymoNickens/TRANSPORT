import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import type { Tx } from "@/lib/db";

/**
 * Cancelling seats, bookings and journeys (spec 15.2, 16.2). The database
 * works out every amount from the policy the booking was sold under; these
 * functions show the quote first and then apply it.
 */

export type SeatQuote = {
  seatNumber: string;
  passengerName: string;
  bookedSeatId: string;
  allowed: boolean;
  amountPesewas: number;
  percent: number;
  feeDeductedPesewas: number;
  reason: string | null;
};

export type CancellationQuote = {
  reference: string;
  hoursBefore: number | null;
  seats: SeatQuote[];
  totalRefundPesewas: number;
  currency: string;
  /** The policy in plain words, as sold (16.1). */
  policy: string[];
};

export const cancelInput = z.object({
  /** Seats to cancel; all cancellable seats when left out. */
  seatNumbers: z.array(z.string().trim().toUpperCase().max(4)).max(6).optional(),
  reason: z.string().trim().max(300).optional(),
});

type Policy = {
  bands?: { min_hours_before: number; refund_percent: number; deduct_provider_fee: boolean }[];
  operator_cancellation_percent?: number;
};

/** The refund policy in plain words, from the most notice down. */
export function policyText(policy: Policy | null): string[] {
  const bands = [...(policy?.bands ?? [])].sort((a, b) => b.min_hours_before - a.min_hours_before);
  const lines = bands.map((band, i) => {
    const upper = bands[i - 1]?.min_hours_before;
    const when = upper === undefined
      ? `${band.min_hours_before} hours or more before departure`
      : band.min_hours_before === 0
        ? `under ${upper} hours before departure`
        : `${band.min_hours_before} to ${upper} hours before departure`;
    const what = band.refund_percent === 0
      ? "no refund"
      : `${band.refund_percent === 100 ? "the full fare" : `${band.refund_percent}% of the fare`}${band.deduct_provider_fee ? ", less the payment provider's fee" : ""}`;
    return `Cancel ${when}: ${what}.`;
  });
  lines.push(`If we cancel the journey: ${policy?.operator_cancellation_percent ?? 100}% back, including fees, automatically.`);
  return lines;
}

export async function cancellationQuote(tx: Tx, bookingId: string): Promise<CancellationQuote> {
  const [booking] = await tx<{ reference: string; currency: string; refundPolicy: Policy | null }[]>`
    select reference, currency, refund_policy from app.bookings where id = ${bookingId}`;
  if (!booking) throw new AppError("not_found", { message: "We couldn't find that booking." });
  const rows = await tx<{ bookedSeatId: string; seatNumber: string; passengerName: string; quote: { allowed: boolean; amount: number; percent: number; feeDeducted: number; hoursBefore: number | null; reason: string | null } }[]>`
    select s.id as booked_seat_id, js.seat_number, p.full_name as passenger_name, app.refund_quote(s.id, 'passenger_cancellation') as quote
    from app.booked_seats s
    join app.journey_seats js on js.id = s.journey_seat_id
    join app.booking_passengers p on p.id = s.passenger_id
    where s.booking_id = ${bookingId}
    order by js.row_number, js.column_number`;
  const seats = rows.map((r) => ({
    seatNumber: r.seatNumber,
    passengerName: r.passengerName,
    bookedSeatId: r.bookedSeatId,
    allowed: r.quote.allowed,
    amountPesewas: Number(r.quote.amount),
    percent: r.quote.percent,
    feeDeductedPesewas: Number(r.quote.feeDeducted),
    reason: r.quote.reason,
  }));
  return {
    reference: booking.reference,
    hoursBefore: rows.find((r) => r.quote.hoursBefore !== null)?.quote.hoursBefore ?? null,
    seats,
    totalRefundPesewas: seats.filter((s) => s.allowed).reduce((sum, s) => sum + s.amountPesewas, 0),
    currency: booking.currency,
    policy: policyText(booking.refundPolicy),
  };
}

/**
 * Cancels the chosen seats (or every cancellable seat) under the policy. The
 * passenger is told by text message; refunds inside the policy start at once.
 */
export async function cancelSeats(tx: Tx, bookingId: string, input: z.infer<typeof cancelInput>) {
  const quote = await cancellationQuote(tx, bookingId);
  const chosen = input.seatNumbers?.length
    ? quote.seats.filter((s) => input.seatNumbers!.includes(s.seatNumber))
    : quote.seats.filter((s) => s.allowed);
  if (!chosen.length) throw new AppError("rule_violation", { message: "There are no seats on this booking that can be cancelled." });
  const refused = chosen.find((s) => !s.allowed);
  if (refused) throw new AppError("rule_violation", { message: `Seat ${refused.seatNumber}: ${refused.reason}` });

  for (const seat of chosen) {
    await tx`select app.cancel_seat(${seat.bookedSeatId}, 'passenger_cancellation', ${input.reason || "Cancelled by the passenger"})`;
  }
  const [org] = await tx<{ organisationId: string }[]>`select organisation_id from app.bookings where id = ${bookingId}`;
  await tx`select app.enqueue_message(${org.organisationId}, 'booking_cancelled',
    ${tx.json({ bookingId, seats: chosen.map((s) => s.seatNumber) })},
    ${`booking_cancelled:${chosen.map((s) => s.bookedSeatId).sort().join(",")}`})`;
  return {
    cancelledSeats: chosen.map((s) => s.seatNumber),
    refundPesewas: chosen.reduce((sum, s) => sum + s.amountPesewas, 0),
  };
}

// ---------------------------------------------------------------------------
// Cancelling a journey (15.2)
// ---------------------------------------------------------------------------

export const cancelJourneyInput = z.object({ reason: z.string().trim().min(5).max(300) });

/** What cancelling would do, and the next departure on the route to offer passengers. */
export async function journeyCancellationPreview(tx: Tx, journeyId: string) {
  const [row] = await tx<{ label: string; routeId: string; departure: Date; preview: { passengers: number; bookings: number; refundTotalPesewas: number; unpaidHolds: number } }[]>`
    select app.journey_label(id) as label, route_id, scheduled_departure_at as departure, app.journey_cancellation_preview(id) as preview
    from app.journeys where id = ${journeyId}`;
  if (!row) throw new AppError("not_found", { message: "That journey does not exist." });
  const next = await nextDeparture(tx, row.routeId, row.departure, journeyId);
  return {
    label: row.label,
    passengers: Number(row.preview.passengers),
    bookings: Number(row.preview.bookings),
    refundTotalPesewas: Number(row.preview.refundTotalPesewas),
    unpaidHolds: Number(row.preview.unpaidHolds),
    nextDeparture: next,
    messageTemplate: journeyCancelledText({ reference: "AB12CD34", trip: row.label, reason: "{reason}", refund: "{refund}", next: next?.label ?? null }),
  };
}

export async function nextDeparture(tx: Tx, routeId: string, after: Date, excludeId: string) {
  const [next] = await tx<{ id: string; label: string; freeSeats: number }[]>`
    select j.id, app.journey_label(j.id) as label,
           (select count(*)::int from app.journey_seats s where s.journey_id = j.id and s.state = 'BOOKABLE'
              and not exists (select 1 from app.seat_claims c where c.journey_seat_id = s.id and c.state in ('HELD', 'CONFIRMED')
                                and (c.state = 'CONFIRMED' or c.expires_at > now()))) as free_seats
    from app.journeys j
    where j.route_id = ${routeId} and j.id <> ${excludeId} and j.state = 'SCHEDULED' and j.scheduled_departure_at > ${after}
    order by j.scheduled_departure_at limit 1`;
  return next ?? null;
}

/** The text a passenger receives when their journey is cancelled (17.2). */
export function journeyCancelledText(v: { reference: string; trip: string; reason: string; refund: string; next: string | null }) {
  return `Sorry, your journey ${v.trip} (booking ${v.reference}) is cancelled: ${v.reason}. A full refund of ${v.refund} has been started.` +
    (v.next ? ` The next bus on this route is ${v.next}; you can book it on our website.` : "");
}

export async function cancelJourneyWithRefunds(tx: Tx, journeyId: string, input: z.infer<typeof cancelJourneyInput>) {
  const [row] = await tx<{ passengers: number }[]>`select app.cancel_journey(${journeyId}, ${input.reason}) as passengers`;
  return { passengersRefunded: row.passengers };
}
