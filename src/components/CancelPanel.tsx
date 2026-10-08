"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis } from "@/lib/format";
import { Button, Notice } from "./ui";

type Quote = {
  hoursBefore: number | null;
  seats: { seatNumber: string; passengerName: string; allowed: boolean; amountPesewas: number; percent: number; feeDeductedPesewas: number; reason: string | null }[];
  policy: string[];
};

/**
 * Cancelling seats (16.2): the server's refund for each seat is shown before
 * anything changes, and the confirmation states the consequence (8.5). The
 * same panel serves passengers and staff, with different endpoints.
 */
export function CancelPanel({ path, headers = {}, onDone, who = "you" }: { path: string; headers?: Record<string, string>; onDone: () => void; who?: "you" | "staff" }) {
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef("");
  const headersKey = JSON.stringify(headers);

  useEffect(() => {
    if (!open) return;
    api<Quote>(path, { headers: JSON.parse(headersKey) })
      .then((q) => {
        setQuote(q);
        setChosen(q.seats.filter((s) => s.allowed).map((s) => s.seatNumber));
        key.current = crypto.randomUUID();
      })
      .catch((e: ApiError) => setMessage(e.message));
  }, [open, path, headersKey]);

  if (!open) {
    return (
      <button type="button" className="self-start text-sm underline" onClick={() => setOpen(true)}>
        Cancel {who === "you" ? "seats" : "seats for the passenger"}
      </button>
    );
  }
  if (!quote) return message ? <Notice tone="error">{message}</Notice> : <Notice>Working out the refund…</Notice>;

  const cancellable = quote.seats.filter((s) => s.allowed);
  const refund = quote.seats.filter((s) => chosen.includes(s.seatNumber)).reduce((sum, s) => sum + s.amountPesewas, 0);

  async function cancel() {
    const seats = chosen.join(", ");
    const consequence = refund > 0 ? `${formatCedis(refund)} will be refunded to the number or card that paid.` : "Nothing will be refunded.";
    if (!window.confirm(`Cancel seat${chosen.length > 1 ? "s" : ""} ${seats}? Those tickets stop working at once. ${consequence}`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(path, { method: "POST", headers: { ...headers, "Idempotency-Key": key.current }, body: { seatNumbers: chosen } });
      setOpen(false);
      onDone();
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.code === "offline" ? "No reply. Your seats may or may not be cancelled; refresh the page to see." : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <h2 className="font-semibold">Cancel seats</h2>
      {quote.hoursBefore !== null && quote.hoursBefore > 0 ? <p className="text-sm text-muted">Departure is in about {Math.round(quote.hoursBefore)} hours.</p> : null}
      <ul className="flex flex-col gap-2">
        {quote.seats.map((s) => (
          <li key={s.seatNumber}>
            <label className={`flex items-start gap-3 ${s.allowed ? "" : "text-muted"}`}>
              <input
                type="checkbox"
                className="mt-1"
                disabled={!s.allowed}
                checked={chosen.includes(s.seatNumber)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, s.seatNumber] : c.filter((n) => n !== s.seatNumber)))}
              />
              <span>
                <span className="block font-medium">Seat {s.seatNumber} · {s.passengerName}</span>
                <span className="text-sm">
                  {s.allowed
                    ? s.amountPesewas > 0
                      ? `Refund ${formatCedis(s.amountPesewas)}${s.feeDeductedPesewas ? ` (after the ${formatCedis(s.feeDeductedPesewas)} payment fee)` : ""}`
                      : "No refund at this time"
                    : s.reason}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <ul className="list-disc pl-5 text-sm text-muted">
        {quote.policy.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {message ? <Notice tone="error">{message}</Notice> : null}
      <div className="flex gap-2">
        <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => setOpen(false)}>Keep my seats</button>
        <Button type="button" disabled={busy || !chosen.length || !cancellable.length} onClick={cancel}>
          {busy ? "Cancelling…" : `Cancel ${chosen.length} seat${chosen.length === 1 ? "" : "s"}${refund ? `, refund ${formatCedis(refund)}` : ""}`}
        </Button>
      </div>
    </section>
  );
}
