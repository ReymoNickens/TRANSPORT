"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, bookingToken } from "@/lib/client/api";
import { formatCedis, formatDay, formatTime } from "@/lib/format";
import { Button, Field, Notice } from "../ui";

type Seat = { id: string; seatNumber: string; seatType: "standard" | "premium" | "accessible"; rowNumber: number; columnNumber: number; status: "available" | "held" | "taken" | "blocked" };
type SeatMap = {
  journey: { routeName: string; departsAt: string; arrivesAt: string; rows: number; columns: number };
  seats: Seat[];
  fares: { seatType: string; amountPesewas: number }[];
  concessions: { code: string; name: string; requiresReference: boolean }[];
  holdMinutes: number;
};
type Passenger = { fullName: string; phone: string; concession: string; concessionReference: string };

const MAX_SEATS = 6;
const emptyPassenger = (): Passenger => ({ fullName: "", phone: "", concession: "", concessionReference: "" });

/** Seat selection (7.5) and passenger details (7.6). The server decides availability and price. */
export function SeatPicker() {
  const router = useRouter();
  const { id: journeyId } = useParams<{ id: string }>();
  const params = useSearchParams();
  const origin = params.get("origin") ?? "";
  const destination = params.get("destination") ?? "";

  const [map, setMap] = useState<SeatMap | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [passengers, setPassengers] = useState<Record<string, Passenger>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per booking attempt, reused if the network drops, so a retry never holds seats twice (11.3).
  const idempotencyKey = useRef(crypto.randomUUID());

  const load = useCallback(() => {
    return api<SeatMap>(`/api/public/journeys/${journeyId}/seats?origin=${origin}&destination=${destination}`)
      .then((m) => {
        setMap(m);
        // Drop any chosen seat that someone else now has.
        setSelected((current) => current.filter((id) => m.seats.find((s) => s.id === id)?.status === "available"));
      })
      .catch((e: Error) => setError(e.message));
  }, [journeyId, origin, destination]);

  useEffect(() => {
    load();
  }, [load]);

  if (!map) return error ? <Notice tone="error">{error}</Notice> : <Notice>Loading the bus…</Notice>;

  const fare = (type: string) => map.fares.find((f) => f.seatType === type)?.amountPesewas;
  const seatById = new Map(map.seats.map((s) => [s.id, s]));

  function toggle(seat: Seat) {
    setError(null);
    if (selected.includes(seat.id)) {
      setSelected(selected.filter((id) => id !== seat.id));
      return;
    }
    if (selected.length >= MAX_SEATS) {
      setError(`You can book up to ${MAX_SEATS} seats at a time.`);
      return;
    }
    setSelected([...selected, seat.id]);
    setPassengers((p) => ({ ...p, [seat.id]: p[seat.id] ?? emptyPassenger() }));
  }

  function update(seatId: string, patch: Partial<Passenger>) {
    setPassengers((p) => ({ ...p, [seatId]: { ...p[seatId], ...patch } }));
  }

  async function hold(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const first = passengers[selected[0]];
    try {
      const result = await api<{ reference: string; accessToken: string }>("/api/bookings", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: {
          journeyId,
          originStopId: origin,
          destinationStopId: destination,
          purchaser: { name: first.fullName, phone: first.phone },
          seats: selected.map((id) => ({
            journeySeatId: id,
            passenger: {
              fullName: passengers[id].fullName,
              phone: passengers[id].phone,
              concession: passengers[id].concession || null,
              concessionReference: passengers[id].concessionReference || null,
            },
          })),
        },
      });
      bookingToken.set(result.reference, result.accessToken);
      router.push(`/booking/${result.reference}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
      if (err.code !== "offline") {
        // A refused request may be retried with changes: use a fresh key.
        idempotencyKey.current = crypto.randomUUID();
        await load();
      }
      setBusy(false);
    }
  }

  const rows = Array.from({ length: map.journey.rows }, (_, i) => i + 1);
  const cols = Array.from({ length: map.journey.columns }, (_, i) => i + 1);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        {map.journey.routeName} · {formatDay(map.journey.departsAt)} · {formatTime(map.journey.departsAt)} → {formatTime(map.journey.arrivesAt)}
      </p>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Seat key">
        <li><span className="mr-1 inline-block h-3 w-3 rounded border border-foreground align-middle" />Free</li>
        <li><span className="mr-1 inline-block h-3 w-3 rounded bg-accent align-middle" />✓ Yours</li>
        <li><span className="mr-1 inline-block h-3 w-3 rounded border border-dashed border-muted align-middle" />Held by someone</li>
        <li>× Taken</li>
        <li>— Not for sale</li>
        {fare("premium") ? <li>P Premium {formatCedis(fare("premium")!)}</li> : null}
        {map.seats.some((s) => s.seatType === "accessible") ? <li>A Accessible</li> : null}
      </ul>

      <div className="self-center rounded-2xl border border-border p-3" role="group" aria-label="Seat map, front of the bus at the top">
        <p className="mb-2 text-center text-xs text-muted">Front</p>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols.length}, 2.75rem)` }}>
          {rows.flatMap((row) =>
            cols.map((col) => {
              const seat = map.seats.find((s) => s.rowNumber === row && s.columnNumber === col);
              if (!seat) return <div key={`${row}-${col}`} aria-hidden />;
              const mine = selected.includes(seat.id);
              const free = seat.status === "available";
              const mark = mine ? "✓" : seat.status === "taken" ? "×" : seat.status === "blocked" ? "—" : seat.seatType === "premium" ? "P" : seat.seatType === "accessible" ? "A" : "";
              const statusText = mine ? "selected" : seat.status === "available" ? "free" : seat.status === "held" ? "held by someone else" : seat.status === "taken" ? "taken" : "not for sale";
              return (
                <button
                  key={seat.id}
                  type="button"
                  disabled={!free && !mine}
                  onClick={() => toggle(seat)}
                  aria-pressed={mine}
                  aria-label={`Seat ${seat.seatNumber}, ${seat.seatType}, ${statusText}`}
                  className={[
                    "flex h-11 w-11 flex-col items-center justify-center rounded-lg text-xs leading-tight",
                    mine ? "bg-accent text-accent-foreground" : free ? "border border-foreground" : seat.status === "held" ? "border border-dashed border-muted text-muted" : "bg-border/60 text-muted",
                  ].join(" ")}
                >
                  <span className="font-medium">{seat.seatNumber}</span>
                  {mark ? <span aria-hidden>{mark}</span> : null}
                </button>
              );
            }),
          )}
        </div>
      </div>

      {selected.length ? (
        <form onSubmit={hold} className="flex flex-col gap-6">
          {selected.map((id, index) => {
            const seat = seatById.get(id)!;
            const p = passengers[id] ?? emptyPassenger();
            const concession = map.concessions.find((c) => c.code === p.concession);
            return (
              <fieldset key={id} className="flex flex-col gap-3 rounded-xl border border-border p-4">
                <legend className="px-1 font-medium">Seat {seat.seatNumber} · {formatCedis(fare(seat.seatType) ?? 0)}{index === 0 ? " · you pay" : ""}</legend>
                <Field label="Full name" value={p.fullName} onChange={(e) => update(id, { fullName: e.target.value })} required autoComplete={index === 0 ? "name" : "off"} />
                <Field label="Phone number" type="tel" inputMode="tel" value={p.phone} onChange={(e) => update(id, { phone: e.target.value })} required hint="The ticket is sent here by text message." />
                {map.concessions.length ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Fare</span>
                    <select className="h-12 rounded-lg border border-border bg-background px-3" value={p.concession} onChange={(e) => update(id, { concession: e.target.value })}>
                      <option value="">Standard</option>
                      {map.concessions.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                    </select>
                  </label>
                ) : null}
                {concession?.requiresReference ? (
                  <Field label="Student number" value={p.concessionReference} onChange={(e) => update(id, { concessionReference: e.target.value })} required hint="Your student ID will be checked at boarding." />
                ) : null}
              </fieldset>
            );
          })}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Notice>Your seats are held for {map.holdMinutes} minutes while you pay. The final price, with any fees, is shown on the next step.</Notice>
          <Button type="submit" disabled={busy}>{busy ? "Holding your seats…" : `Hold ${selected.length} seat${selected.length === 1 ? "" : "s"} and continue`}</Button>
        </form>
      ) : (
        <>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Notice>Tap a free seat to choose it.</Notice>
        </>
      )}
    </div>
  );
}
