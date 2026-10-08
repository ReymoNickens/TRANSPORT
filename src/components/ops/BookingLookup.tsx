"use client";

import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis } from "@/lib/format";
import { Button, Field, Notice } from "../ui";

type BookingSummary = { reference: string; state: string; purchaserName: string; phoneLastDigits: string; journeyLabel: string; seats: number; totalPesewas: number };

const bookingWords: Record<string, string> = {
  PENDING: "Seats held, not paid",
  PAYMENT_PENDING: "Payment in progress",
  CONFIRMED: "Paid",
  EXPIRED: "Expired, not paid",
  CANCELLED: "Cancelled",
  COMPLETED: "Travelled",
};

/** Look up a booking by reference or phone number. */
export function BookingLookup() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<BookingSummary[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage(null);
          try {
            setRows(await api<BookingSummary[]>(`/api/ops/bookings?q=${encodeURIComponent(q)}`));
          } catch (err) {
            setMessage((err as ApiError).message);
          }
        }}
      >
        <Field label="Booking reference or phone number" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <Button type="submit" disabled={q.trim().length < 3}>Find</Button>
      </form>
      {message ? <Notice tone="error">{message}</Notice> : null}
      {rows && !rows.length ? <Notice>No booking matches. Check the reference or try the phone number.</Notice> : null}
      {rows?.length ? (
        <ul className="flex flex-col gap-2">
          {rows.map((b) => (
            <li key={b.reference}>
              <Link href={`/ops/bookings/${b.reference}`} className="flex flex-col gap-1 rounded-xl border border-border p-3">
                <span className="flex justify-between gap-3">
                  <span className="font-mono font-semibold">{b.reference}</span>
                  <span className="text-sm font-medium">{bookingWords[b.state] ?? b.state}</span>
                </span>
                <span className="text-sm">{b.journeyLabel}</span>
                <span className="text-sm text-muted">
                  {b.purchaserName} · phone ending {b.phoneLastDigits} · {b.seats} seat{b.seats === 1 ? "" : "s"} · {formatCedis(b.totalPesewas)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
