"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { Button, Field, Notice, Select } from "../ui";
import { BackButton, ChoiceCard, Steps } from "./Guide";

type Vehicle = { id: string; registration: string; fleetNumber: string | null; bookableSeats: number | null };
type Choice = { bookedSeatId: string; seatNumber: string } | { bookedSeatId: string; refund: true };
type PlanRow = {
  bookedSeatId: string;
  bookingReference: string;
  passengerName: string;
  oldSeatNumber: string;
  oldSeatType: string;
  newSeatNumber: string | null;
  newSeatType: string | null;
  rule: number | null;
  outcome: "moved" | "manager_seat" | "refund" | "needs_choice";
};
type Preview = {
  vehicle: { registration: string; inService: boolean; seats: number };
  passengers: number;
  rows: PlanRow[];
  freeSeats: { seatNumber: string; seatType: string; position: string | null }[];
  needsChoice: number;
  planFingerprint: string;
};

const ruleWords: Record<number, string> = {
  1: "same seat",
  2: "same row",
  3: "next row",
  4: "same window or aisle side",
  5: "nearest seat of the same kind",
};
const steps = ["New bus", "Where everyone sits", "Confirm"] as const;

/**
 * Changing the bus of a departure on sale (15.1), as a guided screen: choose
 * the bus, see where every passenger will sit, settle anyone the rules could
 * not place, then confirm. Nothing changes until the last step.
 */
export function VehicleChange({ journeyId, currentRegistration, onDone }: { journeyId: string; currentRegistration: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [vehicleId, setVehicleId] = useState("");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api<{ items: Vehicle[] }>("/api/ops/vehicles?status=active&pageSize=100")
      .then((p) => setVehicles(p.items.filter((v) => v.bookableSeats && v.registration !== currentRegistration)))
      .catch((e: ApiError) => setMessage(e.message));
  }, [open, currentRegistration]);

  async function loadPreview(nextChoices: Choice[]) {
    setBusy(true);
    setMessage(null);
    try {
      setPreview(await api<Preview>(`/api/ops/journeys/${journeyId}/vehicle-change/preview`, { method: "POST", body: { vehicleId, choices: nextChoices } }));
      setChoices(nextChoices);
      setStep(1);
    } catch (e) {
      setMessage((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  function decide(bookedSeatId: string, value: string) {
    const rest = choices.filter((c) => c.bookedSeatId !== bookedSeatId);
    if (!value) return loadPreview(rest);
    return loadPreview([...rest, value === "refund" ? { bookedSeatId, refund: true } : { bookedSeatId, seatNumber: value }]);
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/ops/journeys/${journeyId}/vehicle-change`, {
        method: "POST",
        body: { vehicleId, choices, reason, planFingerprint: preview.planFingerprint },
      });
      setOpen(false);
      setStep(0);
      setPreview(null);
      onDone();
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.message);
      if (err.code === "conflict") await loadPreview(choices);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button type="button" className="self-start text-sm underline" onClick={() => setOpen(true)}>Change the bus</button>;
  }

  const moved = preview?.rows.filter((r) => r.outcome === "moved" || r.outcome === "manager_seat").length ?? 0;
  const refunded = preview?.rows.filter((r) => r.outcome === "refund").length ?? 0;
  const sameSeat = preview?.rows.filter((r) => r.newSeatNumber === r.oldSeatNumber).length ?? 0;

  return (
    <div className="flex flex-col gap-4 rounded-xl border-2 border-accent p-4">
      <Steps steps={steps} current={step} />

      {step === 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Which bus replaces {currentRegistration ?? "the current bus"}?</h3>
          {!vehicles ? <Notice>Loading buses…</Notice> : null}
          {vehicles?.map((v) => (
            <ChoiceCard key={v.id} name="new-bus" checked={vehicleId === v.id} onChange={() => setVehicleId(v.id)}>
              {v.registration}{v.fleetNumber ? ` (${v.fleetNumber})` : ""} · {v.bookableSeats} seats
            </ChoiceCard>
          ))}
          <div className="flex gap-2">
            <BackButton onClick={() => setOpen(false)} />
            <Button type="button" disabled={!vehicleId || busy} onClick={() => loadPreview([])}>{busy ? "Working out seats…" : "See where everyone sits"}</Button>
          </div>
        </section>
      ) : null}

      {step === 1 && preview ? (
        <section className="flex flex-col gap-3">
          <h3 className="font-semibold">Where everyone sits on {preview.vehicle.registration}</h3>
          <p className="text-sm text-muted">
            {preview.passengers} passenger{preview.passengers === 1 ? "" : "s"} · {sameSeat} keep their seat number · {preview.vehicle.seats} seats on this bus.
            Tickets and boarding codes do not change.
          </p>
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border text-sm">
            {preview.rows.map((r) => (
              <li key={r.bookedSeatId} className="flex flex-wrap items-center justify-between gap-2 p-2">
                <span>
                  <span className="font-medium">{r.passengerName}</span> <span className="font-mono text-muted">{r.bookingReference}</span>
                  <span className="block text-muted">Seat {r.oldSeatNumber}{r.oldSeatType !== "standard" ? ` (${r.oldSeatType})` : ""}</span>
                </span>
                {r.outcome === "moved" ? (
                  <span>→ <strong>{r.newSeatNumber}</strong> <span className="text-muted">({ruleWords[r.rule ?? 0]})</span></span>
                ) : (
                  <Select
                    label={r.outcome === "needs_choice" ? "No matching seat: choose" : "Your choice"}
                    value={r.outcome === "refund" ? "refund" : r.outcome === "manager_seat" ? r.newSeatNumber ?? "" : ""}
                    onChange={(e) => void decide(r.bookedSeatId, e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {r.outcome === "manager_seat" && r.newSeatNumber ? <option value={r.newSeatNumber}>Seat {r.newSeatNumber}</option> : null}
                    {preview.freeSeats
                      .filter((s) => r.oldSeatType !== "accessible" || s.seatType === "accessible")
                      .map((s) => <option key={s.seatNumber} value={s.seatNumber}>Seat {s.seatNumber}{s.seatType !== "standard" ? ` (${s.seatType})` : ""}</option>)}
                    <option value="refund">Full refund instead</option>
                  </Select>
                )}
              </li>
            ))}
          </ul>
          {preview.needsChoice ? <Notice tone="error">Choose a seat or a refund for {preview.needsChoice} passenger{preview.needsChoice === 1 ? "" : "s"} before going on.</Notice> : null}
          <Notice>A passenger moved to a cheaper kind of seat gets the difference back automatically. Nobody pays more.</Notice>
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(0)} />
            <Button type="button" disabled={preview.needsChoice > 0 || busy} onClick={() => setStep(2)}>Next: confirm</Button>
          </div>
        </section>
      ) : null}

      {step === 2 && preview ? (
        <section className="flex flex-col gap-3">
          <h3 className="font-semibold">Confirm the change</h3>
          <ul className="list-disc pl-5 text-sm">
            <li>The departure moves from {currentRegistration ?? "its bus"} to {preview.vehicle.registration}</li>
            <li>{moved} passenger{moved === 1 ? "" : "s"} get a seat on the new bus and a text message with their seat</li>
            {refunded ? <li>{refunded} passenger{refunded === 1 ? "" : "s"} refunded in full and told by text message</li> : null}
          </ul>
          <Field label="Why is the bus changing?" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Coach needs a new tyre" />
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(1)} />
            <Button type="button" disabled={busy || reason.trim().length < 5} onClick={apply}>{busy ? "Changing…" : "Change the bus"}</Button>
          </div>
        </section>
      ) : null}
      {message ? <Notice tone="error">{message}</Notice> : null}
    </div>
  );
}
