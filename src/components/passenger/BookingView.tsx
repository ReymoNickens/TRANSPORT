"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, bookingToken } from "@/lib/client/api";
import { formatCedis, formatDay, formatTime } from "@/lib/format";
import { Button, Notice } from "../ui";
import { CancelPanel } from "../CancelPanel";
import { TicketCard } from "./TicketCard";

type Booking = {
  reference: string;
  state: string;
  displayStatus: string;
  expiresAt: string | null;
  journey: { routeName: string; originName: string; destinationName: string; departsAt: string; arrivesAt: string };
  totalPesewas: number;
  priceBreakdown: { subtotalPesewas: number; fees: { name: string; amountPesewas: number }[]; seats: { concessionPesewas: number }[] };
  payment: { state: string; checkoutUrl: string | null } | null;
  refundPolicy: string[];
  refunds: { amountPesewas: number; state: string; kind: string; requestedAt: string }[];
  seats: {
    seatNumber: string;
    passengerName: string;
    fareType: string;
    amountPesewas: number;
    ticket: { ticketNumber: string; state: string | null; qrToken: string | null; boardingCode: string | null } | null;
  }[];
};

/**
 * Review, pay, wait and ticket (7.7, 7.8). The state shown is always the
 * server's. Returning from the payment page proves nothing (12.6), so this
 * page keeps asking the server until the payment is settled.
 */
export function BookingView() {
  const { reference } = useParams<{ reference: string }>();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<"mobile_money" | "card" | "any">("mobile_money");
  const now = useNow();
  // Bumping this asks the server again.
  const [refresh, setRefresh] = useState(0);
  const load = () => setRefresh((n) => n + 1);

  useEffect(() => {
    let active = true;
    const token = bookingToken.get(reference);
    api<Booking>(`/api/bookings/${reference}`, { headers: token ? { "x-booking-token": token } : {} })
      .then((b) => {
        if (!active) return;
        setBooking(b);
        setError(null);
      })
      .catch((e: ApiError) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [reference, refresh]);

  // While money may be moving, keep asking the server.
  useEffect(() => {
    if (booking?.state !== "PAYMENT_PENDING") return;
    const timer = setInterval(() => setRefresh((n) => n + 1), 4000);
    return () => clearInterval(timer);
  }, [booking?.state]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const token = bookingToken.get(reference);
      const { checkoutUrl } = await api<{ checkoutUrl: string }>(`/api/bookings/${reference}/payments`, {
        method: "POST",
        headers: token ? { "x-booking-token": token } : {},
        body: { method },
      });
      window.location.assign(checkoutUrl);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
      load();
    }
  }

  if (!booking) {
    return error ? (
      <div className="flex flex-col gap-3">
        <Notice tone="error">{error}</Notice>
        <Notice>Open your booking on the phone you booked with, use the link in your text message, or <Link className="underline" href="/sign-in">sign in</Link> and look in My trips.</Notice>
      </div>
    ) : (
      <Notice>Loading your booking…</Notice>
    );
  }

  const secondsLeft = booking.expiresAt ? Math.max(0, Math.floor((new Date(booking.expiresAt).getTime() - now) / 1000)) : 0;
  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const concession = booking.priceBreakdown.seats.reduce((sum, s) => sum + s.concessionPesewas, 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted">Booking <span className="font-mono">{booking.reference}</span> · {booking.displayStatus}</p>
        <h1 className="text-2xl font-semibold">{booking.journey.originName} → {booking.journey.destinationName}</h1>
        <p className="text-muted">{formatDay(booking.journey.departsAt)} · {formatTime(booking.journey.departsAt)} → {formatTime(booking.journey.arrivesAt)}</p>
      </header>

      {booking.state === "PENDING" ? (
        <section className="flex flex-col gap-4">
          <Notice>These seats are yours for {countdown} while you pay.</Notice>
          <dl className="flex flex-col gap-2 rounded-xl border border-border p-4 text-sm">
            {booking.seats.map((s) => (
              <div key={s.seatNumber} className="flex justify-between"><dt>Seat {s.seatNumber} · {s.passengerName} · {s.fareType}</dt></div>
            ))}
            {concession ? <div className="flex justify-between text-muted"><dt>Student discount</dt><dd>−{formatCedis(concession)}</dd></div> : null}
            <div className="flex justify-between"><dt>Fares</dt><dd>{formatCedis(booking.priceBreakdown.subtotalPesewas)}</dd></div>
            {booking.priceBreakdown.fees.map((f) => (
              <div key={f.name} className="flex justify-between"><dt>{f.name}</dt><dd>{formatCedis(f.amountPesewas)}</dd></div>
            ))}
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><dt>Total</dt><dd>{formatCedis(booking.totalPesewas)}</dd></div>
          </dl>
          <div className="text-sm text-muted">
            <p className="font-medium">If you cancel</p>
            <ul className="list-disc pl-5">{booking.refundPolicy.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Pay with</legend>
            {([["mobile_money", "Mobile money (MTN, Telecel, AirtelTigo)"], ["card", "Card"]] as const).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2">
                <input type="radio" name="method" value={value} checked={method === value} onChange={() => setMethod(value)} />
                {label}
              </label>
            ))}
          </fieldset>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button onClick={pay} disabled={busy || secondsLeft === 0}>{busy ? "Starting payment…" : `Pay ${formatCedis(booking.totalPesewas)}`}</Button>
        </section>
      ) : null}

      {booking.state === "PAYMENT_PENDING" ? (
        <section className="flex flex-col gap-3" aria-live="polite">
          <h2 className="text-lg font-semibold">Checking your payment…</h2>
          <Notice>If you chose mobile money, approve the prompt on your phone. This can take a minute. Your seats stay held for {countdown}.</Notice>
          <Notice>You can leave this page: if the payment goes through, your tickets come by text message and appear in My trips.</Notice>
          {booking.payment?.checkoutUrl ? <a className="text-sm underline" href={booking.payment.checkoutUrl}>Open the payment page again</a> : null}
        </section>
      ) : null}

      {booking.state === "CONFIRMED" || booking.state === "COMPLETED" ? (
        <section className="flex flex-col gap-4">
          <Notice>Paid and confirmed. Show the QR code to the conductor when you board. We also sent each traveller their ticket by text message.</Notice>
          {booking.seats.map((s) =>
            s.ticket ? (
              <TicketCard
                key={s.ticket.ticketNumber}
                bookingReference={booking.reference}
                ticketNumber={s.ticket.ticketNumber}
                state={s.ticket.state}
                passengerName={s.passengerName}
                seatNumber={s.seatNumber}
                fareType={s.fareType}
                routeName={booking.journey.routeName}
                originName={booking.journey.originName}
                destinationName={booking.journey.destinationName}
                departsAt={booking.journey.departsAt}
                qrToken={s.ticket.qrToken}
                boardingCode={s.ticket.boardingCode}
              />
            ) : null,
          )}
          {booking.state === "CONFIRMED" && booking.seats.some((s) => s.ticket?.state === "VALID") ? (
            <CancelPanel path={`/api/bookings/${reference}/cancellation`} headers={tokenHeader(reference)} onDone={load} />
          ) : null}
        </section>
      ) : null}

      {booking.refunds.length ? (
        <section className="flex flex-col gap-1">
          <h2 className="font-semibold">Refunds</h2>
          <ul className="text-sm">
            {booking.refunds.map((r, i) => (
              <li key={i}>
                {formatCedis(r.amountPesewas)}: {refundWords[r.state] ?? r.state}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {booking.state === "EXPIRED" ? (
        <section className="flex flex-col gap-3">
          <Notice tone="error">
            {booking.displayStatus === "Expired, refund on its way"
              ? "Your payment arrived after the seats were sold. A full refund has been started and we've sent you a text message."
              : "The hold on these seats ended before payment, so nothing was charged."}
          </Notice>
          <Link href="/" className="underline">Search again</Link>
        </section>
      ) : null}

      {booking.state === "CANCELLED" ? <Notice>This booking was cancelled.</Notice> : null}
    </div>
  );
}

const refundWords: Record<string, string> = {
  REQUESTED: "waiting for approval",
  APPROVED: "on its way",
  PROCESSING: "on its way (mobile money usually within a few days, cards up to 10 working days)",
  COMPLETED: "paid",
};

function tokenHeader(reference: string): Record<string, string> {
  const token = bookingToken.get(reference);
  return token ? { "x-booking-token": token } : {};
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
