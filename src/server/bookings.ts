import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import type { Tx } from "@/lib/db";
import { normaliseGhanaPhone } from "@/lib/phone";
import { priceBooking, type Concession, type FeeRule } from "@/domain/pricing";
import { credentialSecrets, currentCredentials, sha256 } from "./credentials";
import { ghanaPhone } from "./common";

// ---------------------------------------------------------------------------
// Search (spec 7.2, 7.3)
// ---------------------------------------------------------------------------

export const searchQuery = z.object({
  from: z.uuid(),
  to: z.uuid(),
  date: z.iso.date(),
});

export type SearchResult = {
  journeyId: string;
  routeName: string;
  originStopId: string;
  originName: string;
  destinationStopId: string;
  destinationName: string;
  departsAt: Date;
  arrivesAt: Date;
  durationMinutes: number;
  seatsLeft: number;
  fromPesewas: number;
  currency: string;
  delayMinutes: number;
};

/** The locations passengers can search between: the controlled list, never free text. */
export async function listPublicLocations(tx: Tx) {
  return tx<{ id: string; name: string; city: string; region: string }[]>`
    select distinct l.id, l.name, l.city, l.region
    from app.locations l
    join app.route_stops s on s.location_id = l.id
    join app.routes r on r.id = s.route_id and r.status = 'active'
    where l.status = 'active'
    order by l.city, l.name`;
}

/**
 * Journeys on sale between two locations on a date. Seats left counts live
 * claims; a hold whose time has passed counts as free (11.4).
 */
export async function searchJourneys(tx: Tx, query: z.infer<typeof searchQuery>) {
  const results = await findJourneys(tx, query.from, query.to, query.date, query.date);
  if (results.length > 0) return { results, nearby: [] as { date: string; journeys: number }[] };

  // Nothing that day: say why by offering the nearest days that have seats (7.2).
  const nearbyRows = await findJourneys(tx, query.from, query.to, shiftDate(query.date, -3), shiftDate(query.date, 3));
  const byDate = new Map<string, number>();
  for (const row of nearbyRows) {
    const day = row.departsAt.toISOString().slice(0, 10);
    byDate.set(day, (byDate.get(day) ?? 0) + 1);
  }
  return { results, nearby: [...byDate.entries()].map(([date, journeys]) => ({ date, journeys })) };
}

async function findJourneys(tx: Tx, from: string, to: string, firstDate: string, lastDate: string) {
  return tx<SearchResult[]>`
    select j.id as journey_id, r.name as route_name,
           o.id as origin_stop_id, ol.name as origin_name, d.id as destination_stop_id, dl.name as destination_name,
           j.scheduled_departure_at + make_interval(mins => o.departure_offset_minutes) as departs_at,
           j.scheduled_departure_at + make_interval(mins => d.arrival_offset_minutes) as arrives_at,
           d.arrival_offset_minutes - o.departure_offset_minutes as duration_minutes,
           j.delay_minutes,
           (select count(*)::int from app.journey_seats js
             where js.journey_id = j.id and js.state = 'BOOKABLE'
               and not exists (select 1 from app.seat_claims c where c.journey_seat_id = js.id
                                 and (c.state = 'CONFIRMED' or (c.state = 'HELD' and c.expires_at > now())))) as seats_left,
           (select min(f.amount_pesewas) from app.journey_fares f
             where f.journey_id = j.id and f.origin_stop_id = o.id and f.destination_stop_id = d.id) as from_pesewas,
           (select f.currency from app.journey_fares f where f.journey_id = j.id limit 1) as currency
    from app.journeys j
    join app.routes r on r.id = j.route_id
    join app.route_stops o on o.route_id = j.route_id and o.location_id = ${from} and o.boarding_allowed
    join app.route_stops d on d.route_id = j.route_id and d.location_id = ${to} and d.dropoff_allowed and d.sequence > o.sequence
    join app.locations ol on ol.id = o.location_id
    join app.locations dl on dl.id = d.location_id
    where j.state = 'SCHEDULED'
      and j.service_date between ${firstDate}::date and ${lastDate}::date
      and j.booking_opens_at <= now()
      and j.scheduled_departure_at - make_interval(mins => coalesce(app.setting_int(j.organisation_id, 'booking.online_close_minutes'), 30)) > now()
    order by departs_at`;
}

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Seat map (spec 7.4, 7.5)
// ---------------------------------------------------------------------------

export const seatMapQuery = z.object({ origin: z.uuid(), destination: z.uuid() });

export type SeatStatus = "available" | "held" | "taken" | "blocked";

export async function getSeatMap(tx: Tx, journeyId: string, query: z.infer<typeof seatMapQuery>) {
  const [journey] = await tx<{ id: string; state: string; routeName: string; departsAt: Date; arrivesAt: Date; rows: number; columns: number }[]>`
    select j.id, j.state, r.name as route_name,
           j.scheduled_departure_at + make_interval(mins => o.departure_offset_minutes) as departs_at,
           j.scheduled_departure_at + make_interval(mins => d.arrival_offset_minutes) as arrives_at,
           (select max(row_number) from app.journey_seats where journey_id = j.id) as rows,
           (select max(column_number) from app.journey_seats where journey_id = j.id) as columns
    from app.journeys j
    join app.routes r on r.id = j.route_id
    join app.route_stops o on o.id = ${query.origin} and o.route_id = j.route_id
    join app.route_stops d on d.id = ${query.destination} and d.route_id = j.route_id and d.sequence > o.sequence
    where j.id = ${journeyId}`;
  if (!journey || journey.state !== "SCHEDULED") throw new AppError("not_found", { message: "This journey is not on sale." });

  const seats = await tx<{ id: string; seatNumber: string; seatType: string; rowNumber: number; columnNumber: number; position: string | null; status: SeatStatus }[]>`
    select js.id, js.seat_number, js.seat_type, js.row_number, js.column_number, js.position,
           case
             when js.state = 'BLOCKED' then 'blocked'
             when exists (select 1 from app.seat_claims c where c.journey_seat_id = js.id and c.state = 'CONFIRMED') then 'taken'
             when exists (select 1 from app.seat_claims c where c.journey_seat_id = js.id and c.state = 'HELD' and c.expires_at > now()) then 'held'
             else 'available'
           end as status
    from app.journey_seats js where js.journey_id = ${journeyId}
    order by js.row_number, js.column_number`;
  const fares = await tx<{ seatType: string; amountPesewas: number; currency: string }[]>`
    select seat_type, amount_pesewas, currency from app.journey_fares
    where journey_id = ${journeyId} and origin_stop_id = ${query.origin} and destination_stop_id = ${query.destination}`;
  const concessions = await tx<{ code: string; name: string; discountKind: string; discountBasisPoints: number | null; discountPesewas: number | null; requiresReference: boolean; checkAtBoarding: boolean }[]>`
    select code, name, discount_kind, discount_basis_points, discount_pesewas, requires_reference, check_at_boarding
    from app.concession_types where status = 'active' order by name`;
  const [{ holdMinutes }] = await tx<{ holdMinutes: number }[]>`
    select coalesce(app.setting_int(app.current_organisation_id(), 'hold.minutes'), 10) as hold_minutes`;

  return { journey, seats: [...seats], fares: [...fares], concessions: [...concessions], holdMinutes };
}

// ---------------------------------------------------------------------------
// Holding seats (spec 11.3)
// ---------------------------------------------------------------------------

export const holdInput = z.object({
  journeyId: z.uuid(),
  originStopId: z.uuid(),
  destinationStopId: z.uuid(),
  purchaser: z.object({
    name: z.string().trim().min(1).max(120),
    phone: ghanaPhone,
    email: z.email().nullish(),
  }),
  seats: z
    .array(
      z.object({
        journeySeatId: z.uuid(),
        passenger: z.object({
          fullName: z.string().trim().min(1).max(120),
          phone: ghanaPhone,
          email: z.email().nullish(),
          emergencyContact: z.string().trim().max(120).nullish(),
          /** A concession code such as "student", or null for the standard fare. */
          concession: z.string().trim().toLowerCase().nullish(),
          /** For example the student number; required by most concessions. */
          concessionReference: z.string().trim().min(2).max(40).nullish(),
          institution: z.string().trim().max(120).nullish(),
        }),
      }),
    )
    .min(1),
});

export type HoldResult = {
  reference: string;
  expiresAt: Date;
  totalPesewas: number;
  currency: string;
  /** Give this to the browser that made the booking; it proves access for a guest. */
  accessToken: string;
};

type Context = { userId: string | null; address: string | null; source: "passenger_app" | "station" | "support"; createdBy?: string | null };

export async function holdSeats(tx: Tx, input: z.infer<typeof holdInput>, context: Context): Promise<HoldResult> {
  const channel = context.source === "station" ? "station" : "online";
  const [org] = await tx<{ id: string; currency: string }[]>`
    select id, currency from app.organisations where id = app.current_organisation_id()`;

  // Server-side prices from the journey's fare snapshot (13.4a step 1).
  const seatTypes = await tx<{ id: string; seatType: "standard" | "premium" | "accessible" }[]>`
    select id, seat_type from app.journey_seats where journey_id = ${input.journeyId} and id = any(${input.seats.map((s) => s.journeySeatId)}::uuid[])`;
  const seatTypeById = new Map(seatTypes.map((s) => [s.id, s.seatType]));
  const fares = await tx<{ seatType: string; amountPesewas: number; currency: string }[]>`
    select seat_type, amount_pesewas, currency from app.journey_fares
    where journey_id = ${input.journeyId} and origin_stop_id = ${input.originStopId} and destination_stop_id = ${input.destinationStopId}`;
  const fareByType = new Map(fares.map((f) => [f.seatType, f.amountPesewas]));

  const priced: { journeySeatId: string; seatType: string; base: number; concession?: Concession; verificationId: string | null; concessionTypeId: string | null }[] = [];
  for (const seat of input.seats) {
    const seatType = seatTypeById.get(seat.journeySeatId);
    if (!seatType) throw new AppError("rule_violation", { message: "One of the chosen seats is not on this journey." });
    const base = fareByType.get(seatType);
    if (base === undefined) throw new AppError("rule_violation", { message: `There is no ${seatType} fare for this trip.` });
    const verified = seat.passenger.concession ? await verifyConcession(tx, seat.passenger) : null;
    priced.push({
      journeySeatId: seat.journeySeatId,
      seatType,
      base,
      concession: verified?.concession,
      verificationId: verified?.verificationId ?? null,
      concessionTypeId: verified?.concession.concessionTypeId ?? null,
    });
  }

  const feeRows = await tx<{ id: string; name: string; category: "booking_fee" | "tax"; calculation: "fixed" | "percent"; amountPesewas: number | null; basisPoints: number | null }[]>`
    select id, name, category, calculation, amount_pesewas, basis_points from app.fee_rules
    where status = 'active' and applies_to in ('all', ${channel}) order by created_at`;
  const feeRules: FeeRule[] = feeRows.map((f) =>
    f.calculation === "fixed"
      ? { feeRuleId: f.id, name: f.name, category: f.category, calculation: "fixed", amountPesewas: f.amountPesewas! }
      : { feeRuleId: f.id, name: f.name, category: f.category, calculation: "percent", basisPoints: f.basisPoints! },
  );
  const price = priceBooking(priced.map((p) => ({ baseFarePesewas: p.base, concession: p.concession })), feeRules);
  if (price.totalPesewas <= 0) throw new AppError("rule_violation", { message: "This booking has nothing to pay." });

  const accessToken = randomBytes(32).toString("base64url");
  const currency = fares[0]?.currency ?? org.currency;

  const [row] = await tx<{ bookingId: string; reference: string; expiresAt: Date }[]>`
    select * from app.hold_seats(${input.journeyId}, ${input.originStopId}, ${input.destinationStopId},
      ${tx.json({
        purchaserName: input.purchaser.name,
        purchaserPhone: input.purchaser.phone,
        purchaserEmail: input.purchaser.email ?? "",
        userId: context.userId ?? "",
        createdBy: context.createdBy ?? "",
        source: context.source,
        channel,
        subtotal: price.subtotalPesewas,
        fees: price.feesPesewas,
        total: price.totalPesewas,
        currency,
        breakdown: price,
        accessTokenHash: sha256(accessToken).toString("hex"),
        address: context.address ?? "",
      } as never)},
      ${tx.json(
        priced.map((p, i) => ({
          journeySeatId: p.journeySeatId,
          seatType: p.seatType,
          base: price.seats[i].baseFarePesewas,
          concession: price.seats[i].concessionPesewas,
          feeShare: price.seats[i].feesPesewas,
          amount: price.seats[i].totalPesewas,
          passenger: {
            fullName: input.seats[i].passenger.fullName,
            phone: input.seats[i].passenger.phone,
            email: input.seats[i].passenger.email ?? "",
            emergencyContact: input.seats[i].passenger.emergencyContact ?? "",
            concessionTypeId: p.concessionTypeId ?? "",
            verificationId: p.verificationId ?? "",
          },
        })) as never,
      )})`;
  return { reference: row.reference, expiresAt: row.expiresAt, totalPesewas: price.totalPesewas, currency, accessToken };
}

/**
 * A concession needs a valid verification (D25). Release 1 accepts a
 * self-declared reference, flagged for the conductor's check; it lasts until
 * the end of the academic year or 12 months, whichever is sooner. An expired
 * verification is never used; declaring the reference again re-verifies.
 */
async function verifyConcession(
  tx: Tx,
  passenger: { phone: string; concession?: string | null; concessionReference?: string | null; institution?: string | null },
): Promise<{ concession: Concession; verificationId: string }> {
  const [type] = await tx<{ id: string; organisationId: string; discountKind: "percent" | "fixed"; discountBasisPoints: number | null; discountPesewas: number | null; requiresReference: boolean }[]>`
    select id, organisation_id, discount_kind, discount_basis_points, discount_pesewas, requires_reference
    from app.concession_types where code = ${passenger.concession!} and status = 'active'`;
  if (!type) throw new AppError("rule_violation", { message: "That fare type is not available." });

  await tx`
    update app.concession_verifications set status = 'EXPIRED'
    where phone = ${passenger.phone} and concession_type_id = ${type.id} and status = 'VALID' and expires_at <= now()`;
  let [verification] = await tx<{ id: string; reference: string }[]>`
    select id, reference from app.concession_verifications
    where phone = ${passenger.phone} and concession_type_id = ${type.id} and status = 'VALID' and expires_at > now()
    order by verified_at desc limit 1`;

  const given = passenger.concessionReference?.trim();
  if (!verification || (given && given !== verification.reference)) {
    if (type.requiresReference && !given) {
      throw new AppError("rule_violation", { message: "Enter the student number for the student fare. The student ID is checked at boarding." });
    }
    [verification] = await tx<{ id: string; reference: string }[]>`
      insert into app.concession_verifications (organisation_id, phone, concession_type_id, reference, institution, source, expires_at)
      select ${type.organisationId}, ${passenger.phone}, ${type.id}, ${given ?? "self-declared"}, ${passenger.institution ?? null},
             'self_declared', least(now() + interval '12 months', app.next_academic_year_end(${type.organisationId}))
      returning id, reference`;
  }
  const concession: Concession =
    type.discountKind === "percent"
      ? { kind: "percent", basisPoints: type.discountBasisPoints!, concessionTypeId: type.id }
      : { kind: "fixed", pesewas: type.discountPesewas!, concessionTypeId: type.id };
  return { concession, verificationId: verification.id };
}

// ---------------------------------------------------------------------------
// Booking status (spec 7.7, 7.8, 9.10)
// ---------------------------------------------------------------------------

export type DisplayStatus =
  | "Waiting to pay"
  | "Payment in progress"
  | "Confirmed"
  | "Partly cancelled"
  | "Travelled"
  | "Cancelled"
  | "Expired"
  | "Expired, refund on its way";

/** What passengers and staff see, derived and never stored (9.10). */
export function displayStatus(state: string, seatStates: string[], hasOpenRefund: boolean): DisplayStatus {
  switch (state) {
    case "PENDING":
      return "Waiting to pay";
    case "PAYMENT_PENDING":
      return "Payment in progress";
    case "CONFIRMED":
      return seatStates.includes("CANCELLED") ? "Partly cancelled" : "Confirmed";
    case "COMPLETED":
      return "Travelled";
    case "CANCELLED":
      return "Cancelled";
    default:
      return hasOpenRefund ? "Expired, refund on its way" : "Expired";
  }
}

export type BookingAccess = { userId: string | null; accessToken: string | null };

/** Finds a booking the caller may see: its owner, or the browser holding its access token. */
export async function findAccessibleBooking(tx: Tx, reference: string, access: BookingAccess) {
  const [booking] = await tx<{ id: string; userId: string | null; accessTokenHash: Buffer | null }[]>`
    select id, user_id, access_token_hash from app.bookings where reference = ${reference.toUpperCase()}`;
  const ownsIt = booking && access.userId && booking.userId === access.userId;
  const hasToken = booking && access.accessToken && booking.accessTokenHash && sha256(access.accessToken).equals(booking.accessTokenHash);
  // The reference alone never shows personal data (19.1).
  if (!booking || (!ownsIt && !hasToken)) throw new AppError("not_found", { message: "We couldn't find that booking." });
  return booking.id;
}

export async function getBooking(tx: Tx, bookingId: string, ticketSecret: string | undefined) {
  const [booking] = await tx<{
    id: string;
    reference: string;
    state: string;
    expiresAt: Date | null;
    totalPesewas: number;
    feesPesewas: number;
    currency: string;
    priceBreakdown: unknown;
    routeName: string;
    originName: string;
    destinationName: string;
    departsAt: Date;
    arrivesAt: Date;
  }[]>`
    select b.id, b.reference, b.state, b.expires_at, b.total_pesewas, b.fees_pesewas, b.currency, b.price_breakdown,
           r.name as route_name, ol.name as origin_name, dl.name as destination_name,
           j.scheduled_departure_at + make_interval(mins => o.departure_offset_minutes) as departs_at,
           j.scheduled_departure_at + make_interval(mins => d.arrival_offset_minutes) as arrives_at
    from app.bookings b
    join app.journeys j on j.id = b.journey_id
    join app.routes r on r.id = b.route_id
    join app.route_stops o on o.id = b.origin_stop_id join app.locations ol on ol.id = o.location_id
    join app.route_stops d on d.id = b.destination_stop_id join app.locations dl on dl.id = d.location_id
    where b.id = ${bookingId}`;

  const seats = await tx<{ id: string; state: string; seatNumber: string; seatType: string; passengerName: string; fareType: string; amountPesewas: number; ticketId: string | null; ticketNumber: string | null; ticketState: string | null }[]>`
    select s.id, s.state, js.seat_number, s.seat_type, p.full_name as passenger_name,
           coalesce(ct.name, 'Standard') as fare_type, s.amount_pesewas,
           t.id as ticket_id, t.ticket_number, t.state as ticket_state
    from app.booked_seats s
    join app.journey_seats js on js.id = s.journey_seat_id
    join app.booking_passengers p on p.id = s.passenger_id
    left join app.concession_types ct on ct.id = s.concession_type_id
    left join app.tickets t on t.booked_seat_id = s.id
    where s.booking_id = ${bookingId}
    order by js.row_number, js.column_number`;

  const [attempt] = await tx<{ id: string; state: string; checkoutUrl: string | null; startedAt: Date }[]>`
    select id, state, checkout_url, started_at from app.payment_attempts where booking_id = ${bookingId} order by started_at desc limit 1`;
  const [{ openRefund }] = await tx<{ openRefund: boolean }[]>`
    select exists (select 1 from app.refunds where booking_id = ${bookingId} and state in ('REQUESTED', 'APPROVED', 'PROCESSING')) as open_refund`;

  const credentials = await currentCredentials(tx, seats.map((s) => s.ticketId).filter((id): id is string => !!id));
  return {
    reference: booking.reference,
    state: booking.state,
    displayStatus: displayStatus(booking.state, seats.map((s) => s.state), openRefund),
    expiresAt: booking.expiresAt,
    journey: {
      routeName: booking.routeName,
      originName: booking.originName,
      destinationName: booking.destinationName,
      departsAt: booking.departsAt,
      arrivesAt: booking.arrivesAt,
    },
    totalPesewas: booking.totalPesewas,
    feesPesewas: booking.feesPesewas,
    currency: booking.currency,
    priceBreakdown: booking.priceBreakdown,
    payment: attempt ? { state: attempt.state, checkoutUrl: attempt.state === "PENDING" ? attempt.checkoutUrl : null, startedAt: attempt.startedAt } : null,
    seats: seats.map((s) => {
      const credentialId = s.ticketId ? credentials.get(s.ticketId) : undefined;
      // The QR token and boarding code are shown only for a valid ticket, to its owner.
      const secrets = credentialId && ticketSecret && s.ticketState === "VALID" ? credentialSecrets(ticketSecret, credentialId) : null;
      return {
        seatNumber: s.seatNumber,
        seatType: s.seatType,
        passengerName: s.passengerName,
        fareType: s.fareType,
        amountPesewas: s.amountPesewas,
        state: s.state,
        ticket: s.ticketNumber
          ? { ticketNumber: s.ticketNumber, state: s.ticketState, qrToken: secrets?.qrToken ?? null, boardingCode: secrets?.boardingCode ?? null }
          : null,
      };
    }),
  };
}

/** Normalises what a person types as a booking reference. */
export function cleanReference(value: string): string | null {
  const ref = value.trim().toUpperCase();
  return /^[2-9A-HJ-NP-Z]{8}$/.test(ref) ? ref : null;
}

export { normaliseGhanaPhone };
