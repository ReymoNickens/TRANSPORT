import { log } from "@/lib/api/log";
import { withOrganisation, type RequestContext, type Sql, type Tx } from "@/lib/db";
import { formatCedis } from "@/domain/money";
import type { SmsProvider } from "@/providers/sms/types";
import { journeyCancelledText, nextDeparture } from "./cancellations";
import { credentialSecrets } from "./credentials";

type Ctx = Pick<RequestContext, "organisationId" | "correlationId">;
type Config = { ticketSecret: string; baseUrl: string };

/** One text message to send: who gets it, which template, and the text (built here, never stored). */
type Outgoing = { recipient: string; template: string; text: string };

const MAX_ATTEMPTS = 6;

/**
 * Sends due outbox messages (17.3). Each message's deliveries are recorded
 * per recipient, so a retry never sends twice to someone already served.
 * Retries back off; a critical message that keeps failing opens an exception.
 */
export async function sendDueMessages(ctx: Ctx, sms: SmsProvider, config: Config, options: { limit?: number } = {}, sql?: Sql) {
  let sent = 0;
  const ids = await withOrganisation(ctx, (tx) => tx<{ id: string }[]>`
    select id from app.outbox where processed_at is null and next_attempt_at <= now()
    order by created_at limit ${options.limit ?? 20}`, sql);

  for (const { id } of ids) {
    await withOrganisation(ctx, async (tx) => {
      const [message] = await tx<{ id: string; eventType: string; payload: Payload; attempts: number }[]>`
        select id, event_type, payload, attempts from app.outbox
        where id = ${id} and processed_at is null for update skip locked`;
      if (!message) return;
      const outgoing = await buildMessages(tx, message.eventType, message.payload, config);
      let failed = 0;
      for (const item of outgoing) {
        const [delivery] = await tx<{ id: string; state: string }[]>`
          insert into app.notification_deliveries (organisation_id, outbox_id, channel, recipient, template)
          values (${ctx.organisationId}, ${message.id}, 'sms', ${item.recipient}, ${item.template})
          on conflict (outbox_id, channel, recipient) do update set template = excluded.template
          returning id, state`;
        if (delivery.state === "SENT") continue;
        try {
          const result = await sms.send({ to: item.recipient, message: item.text });
          await tx`
            update app.notification_deliveries
            set state = 'SENT', sent_at = now(), attempts = attempts + 1, provider_reference = ${result.providerReference}, last_error = null
            where id = ${delivery.id}`;
          sent++;
        } catch (error) {
          failed++;
          await tx`
            update app.notification_deliveries
            set attempts = attempts + 1, last_error = ${error instanceof Error ? error.message.slice(0, 300) : "send failed"},
                state = case when attempts + 1 >= ${MAX_ATTEMPTS} then 'FAILED' else 'PENDING' end
            where id = ${delivery.id}`;
        }
      }

      const attempts = message.attempts + 1;
      if (failed === 0 || attempts >= MAX_ATTEMPTS) {
        await tx`update app.outbox set processed_at = now(), attempts = ${attempts}, last_error = null where id = ${message.id}`;
        if (failed > 0) {
          await tx`
            select app.raise_exception(${ctx.organisationId}, 'critical_message_failed', 'high', ${"message_failed:" + message.id},
              ${`A ${message.eventType.replaceAll("_", " ")} text message could not be delivered after ${MAX_ATTEMPTS} tries.`},
              'Contact the passenger another way.', ${message.payload.bookingId ?? null})`;
        }
      } else {
        // 1, 2, 4, 8, 16 minutes.
        await tx`
          update app.outbox set attempts = ${attempts}, last_error = 'Some deliveries failed',
                 next_attempt_at = now() + make_interval(mins => ${2 ** (attempts - 1)})
          where id = ${message.id}`;
      }
    }, sql).catch((error) => {
      log("error", "messages.send_failed", { correlationId: ctx.correlationId, outboxId: id, cause: error instanceof Error ? error.message : String(error) });
    });
  }
  return { sent };
}

/** Short, plain messages carrying the booking reference and no more personal data than needed (17.3 rule 6). */
type Payload = { bookingId?: string; paymentId?: string; refundId?: string; reason?: string; seats?: string[] };

async function buildMessages(tx: Tx, eventType: string, payload: Payload, config: Config): Promise<Outgoing[]> {
  if (!payload.bookingId) return [];
  const [booking] = await tx<{ reference: string; purchaserPhone: string; totalPesewas: number; departsAt: Date; originName: string; destinationName: string; routeId: string; journeyId: string; scheduledDepartureAt: Date }[]>`
    select b.reference, b.purchaser_phone, b.total_pesewas, b.route_id, b.journey_id, j.scheduled_departure_at,
           j.scheduled_departure_at + make_interval(mins => o.departure_offset_minutes) as departs_at,
           ol.name as origin_name, dl.name as destination_name
    from app.bookings b
    join app.journeys j on j.id = b.journey_id
    join app.route_stops o on o.id = b.origin_stop_id join app.locations ol on ol.id = o.location_id
    join app.route_stops d on d.id = b.destination_stop_id join app.locations dl on dl.id = d.location_id
    where b.id = ${payload.bookingId}`;
  if (!booking) return [];
  const when = new Intl.DateTimeFormat("en-GH", { timeZone: "Africa/Accra", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(booking.departsAt);
  const trip = `${booking.originName} to ${booking.destinationName}, ${when}`;

  if (eventType === "booking_confirmed" || eventType === "late_payment_reseated") {
    const tickets = await tx<{ phone: string; seatNumber: string; ticketNumber: string; credentialId: string }[]>`
      select p.phone, js.seat_number, t.ticket_number, c.id as credential_id
      from app.booked_seats s
      join app.booking_passengers p on p.id = s.passenger_id
      join app.journey_seats js on js.id = s.journey_seat_id
      join app.tickets t on t.booked_seat_id = s.id and t.state = 'VALID'
      join app.ticket_credentials c on c.ticket_id = t.id and c.revoked_at is null
      where s.booking_id = ${payload.bookingId}
      order by js.row_number, js.column_number`;
    const byPhone = new Map<string, string[]>();
    for (const t of tickets) {
      const secrets = credentialSecrets(config.ticketSecret, t.credentialId);
      const line = `Seat ${t.seatNumber}: ${config.baseUrl}/t/${secrets.linkToken} code ${secrets.boardingCode}`;
      byPhone.set(t.phone, [...(byPhone.get(t.phone) ?? []), line]);
    }
    const intro = eventType === "late_payment_reseated"
      ? `Booking ${booking.reference} confirmed. Your payment arrived after the hold ended, so you have a new seat of the same class.`
      : `Booking ${booking.reference} confirmed.`;
    const messages = [...byPhone.entries()].map(([phone, lines]) => ({
      recipient: phone,
      template: eventType,
      text: `${intro} ${trip}. ${lines.join(" ")}`,
    }));
    if (!byPhone.has(booking.purchaserPhone)) {
      messages.push({ recipient: booking.purchaserPhone, template: `${eventType}_purchaser`, text: `${intro} ${trip}. ${tickets.length} ticket(s) were sent to the travellers.` });
    }
    return messages;
  }

  if (eventType === "late_payment_refunded") {
    return [{
      recipient: booking.purchaserPhone,
      template: eventType,
      text: `Sorry, the seats for booking ${booking.reference} were sold before your payment arrived. A full refund of ${formatCedis(booking.totalPesewas)} has been started.`,
    }];
  }
  if (eventType === "duplicate_payment_refunded") {
    return [{
      recipient: booking.purchaserPhone,
      template: eventType,
      text: `Booking ${booking.reference} was paid twice. The extra payment is being refunded to you. Your tickets are unchanged.`,
    }];
  }
  if (eventType === "booking_cancelled") {
    const seats = payload.seats?.length ? `Seat${payload.seats.length > 1 ? "s" : ""} ${payload.seats.join(", ")}` : "Your seats";
    return [{
      recipient: booking.purchaserPhone,
      template: eventType,
      text: `${seats} on booking ${booking.reference} (${trip}) cancelled. Those tickets can no longer be used. Any refund due is on its way.`,
    }];
  }
  if (eventType === "journey_cancelled") {
    const [refund] = await tx<{ total: number }[]>`
      select coalesce(sum(amount_pesewas), 0)::bigint as total from app.refunds
      where booking_id = ${payload.bookingId} and kind = 'operator_cancellation' and state <> 'REJECTED'`;
    const next = await nextDeparture(tx, booking.routeId, booking.scheduledDepartureAt, booking.journeyId);
    const text = journeyCancelledText({ reference: booking.reference, trip, reason: payload.reason ?? "the journey cannot run", refund: formatCedis(refund.total), next: next?.label ?? null });
    const phones = await tx<{ phone: string }[]>`
      select distinct p.phone from app.booking_passengers p where p.booking_id = ${payload.bookingId}`;
    const recipients = new Set([booking.purchaserPhone, ...phones.map((p) => p.phone)]);
    return [...recipients].map((recipient) => ({ recipient, template: eventType, text }));
  }
  if ((eventType === "refund_started" || eventType === "refund_completed") && payload.refundId) {
    const [refund] = await tx<{ amountPesewas: number }[]>`select amount_pesewas from app.refunds where id = ${payload.refundId}`;
    if (!refund) return [];
    return [{
      recipient: booking.purchaserPhone,
      template: eventType,
      text: eventType === "refund_started"
        ? `A refund of ${formatCedis(refund.amountPesewas)} for booking ${booking.reference} has been started. Mobile money refunds usually arrive within a few days; card refunds can take up to 10 working days.`
        : `Your refund of ${formatCedis(refund.amountPesewas)} for booking ${booking.reference} has been paid.`,
    }];
  }
  return [];
}
