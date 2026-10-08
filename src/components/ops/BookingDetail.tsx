"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis, formatDay, formatTime } from "@/lib/format";
import { Notice } from "../ui";

type Booking = {
  reference: string;
  displayStatus: string;
  journey: { routeName: string; originName: string; destinationName: string; departsAt: string; arrivesAt: string };
  totalPesewas: number;
  feesPesewas: number;
  payment: { state: string; startedAt: string } | null;
  seats: { seatNumber: string; passengerName: string; fareType: string; amountPesewas: number; state: string; ticket: { ticketNumber: string; state: string | null } | null }[];
};

const paymentWords: Record<string, string> = {
  INITIATED: "Starting",
  PENDING: "Waiting for the passenger to pay",
  SUCCEEDED: "Paid",
  FAILED: "Failed",
  EXPIRED: "Not completed in time",
};
const seatWords: Record<string, string> = {
  HELD: "Held",
  CONFIRMED: "Booked",
  BOARDED: "Boarded",
  NO_SHOW: "Did not travel",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

/** One booking for staff: journey, passengers, seats, tickets and payment. Never the QR or boarding code. */
export function BookingDetail() {
  const { reference } = useParams<{ reference: string }>();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<Booking>(`/api/ops/bookings/${reference}`).then(setBooking).catch(setError);
  }, [reference]);

  if (error) return <Notice tone="error">{error.message}</Notice>;
  if (!booking) return <Notice>Loading the booking…</Notice>;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="font-mono text-2xl font-semibold">{booking.reference}</h1>
        <p className="font-medium">{booking.displayStatus}</p>
        <p className="text-muted">
          {booking.journey.originName} → {booking.journey.destinationName} · {formatDay(booking.journey.departsAt)} {formatTime(booking.journey.departsAt)}
        </p>
      </header>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
        {booking.seats.map((s) => (
          <li key={s.seatNumber} className="flex justify-between gap-3 p-3 text-sm">
            <span>
              <span className="block font-medium">Seat {s.seatNumber} · {s.passengerName}</span>
              <span className="text-muted">{s.fareType}{s.ticket ? ` · ticket ${s.ticket.ticketNumber}` : ""}</span>
            </span>
            <span className="text-right">
              {seatWords[s.state] ?? s.state}
              <span className="block text-muted">{formatCedis(s.amountPesewas)}</span>
            </span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Total</dt>
        <dd className="font-semibold">{formatCedis(booking.totalPesewas)} (fees {formatCedis(booking.feesPesewas)})</dd>
        <dt className="text-muted">Payment</dt>
        <dd>{booking.payment ? `${paymentWords[booking.payment.state] ?? booking.payment.state}, started ${formatDay(booking.payment.startedAt)} ${formatTime(booking.payment.startedAt)}` : "Not started"}</dd>
      </dl>
      <Notice>Cancellations and refunds from this page are coming in the next slice.</Notice>
    </div>
  );
}
