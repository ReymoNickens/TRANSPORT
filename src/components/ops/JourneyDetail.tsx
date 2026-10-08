"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis, formatDay, formatTime } from "@/lib/format";
import { Button, Field, Notice } from "../ui";
import { AttentionRow, journeyStatus, SmallButton, type AttentionItem } from "./Dashboard";
import type { OpsCan } from "./OpsShell";
import { VehicleChange } from "./VehicleChange";

type Journey = {
  id: string;
  routeName: string;
  scheduledDepartureAt: string;
  scheduledArrivalAt: string;
  actualDepartureAt: string | null;
  actualArrivalAt: string | null;
  delayMinutes: number;
  state: string;
  vehicleId: string | null;
  vehicleRegistration: string | null;
  bookableSeats: number;
  needsFares: boolean;
  cancellationReason: string | null;
  staff: { id: string; userId: string; fullName: string | null; staffRole: "driver" | "conductor" }[];
  events: { eventType: string; fromState: string | null; toState: string | null; notes: string | null; recordedByName: string | null; occurredAt: string }[];
};
type Passenger = {
  ticketId: string;
  reference: string;
  passengerName: string;
  seatNumber: string;
  boardingStop: string;
  destination: string;
  fareType: string;
  state: "VALID" | "BOARDED";
  boardedAt: string | null;
  paymentConfirmed: boolean;
};
type Vehicle = { id: string; registration: string; fleetNumber: string | null; vehicleType: string; bookableSeats: number | null; status: string };
type StaffMember = { id: string; fullName: string | null; roles: string[] };

const eventWords: Record<string, string> = {
  created: "Created",
  vehicle_assigned: "Bus assigned",
  staff_assigned: "Crew member added",
  staff_removed: "Crew member removed",
  times_changed: "Times changed",
  delayed: "Delay recorded",
  stop_reached: "Stop reached",
  note: "Note",
};

function eventText(e: Journey["events"][number]) {
  if (e.eventType === "state_changed") return `${journeyStatus[e.fromState ?? ""] ?? e.fromState} → ${journeyStatus[e.toState ?? ""] ?? e.toState}`;
  return eventWords[e.eventType] ?? e.eventType;
}

/** One departure (8.6): bus, crew, passengers, boarding progress, items needing attention and history. */
export function JourneyDetail({ can }: { can: OpsCan }) {
  const { id } = useParams<{ id: string }>();
  const [journey, setJourney] = useState<Journey | null>(null);
  const [passengers, setPassengers] = useState<Passenger[] | null>(null);
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    api<Journey>(`/api/ops/journeys/${id}`)
      .then((j) => live && setJourney(j))
      .catch((e: ApiError) => live && setError(e));
    if (can.bookings) {
      api<{ rows: Passenger[] }>(`/api/staff/journeys/${id}/manifest`)
        .then((m) => live && setPassengers(m.rows))
        .catch(() => live && setPassengers(null));
    }
    if (can.exceptions) {
      api<AttentionItem[]>(`/api/ops/exceptions?journeyId=${id}`)
        .then((x) => live && setItems(x))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [id, refresh, can.bookings, can.exceptions]);

  if (error) return <Notice tone="error">{error.code === "not_found" ? "That departure does not exist." : error.message}</Notice>;
  if (!journey) return <Notice>Loading the departure…</Notice>;

  const sold = passengers?.length ?? null;
  const boarded = passengers?.filter((p) => p.state === "BOARDED").length ?? 0;
  const live = !["CANCELLED", "COMPLETED"].includes(journey.state);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{journey.routeName}</h1>
        <p className="text-muted">
          {formatDay(journey.scheduledDepartureAt)}, {formatTime(journey.scheduledDepartureAt)} to {formatTime(journey.scheduledArrivalAt)}
          {journey.delayMinutes ? ` · delayed ${journey.delayMinutes} min` : ""}
        </p>
        <p className="font-medium">{journeyStatus[journey.state] ?? journey.state}</p>
        {journey.cancellationReason ? <p className="text-sm text-danger">Cancelled: {journey.cancellationReason}</p> : null}
        <p className="text-sm text-muted">
          {sold !== null ? `${sold} of ${journey.bookableSeats} seats sold · ${journey.bookableSeats - sold} free` : `${journey.bookableSeats} seats`}
          {sold !== null && ["BOARDING", "DEPARTED", "COMPLETED"].includes(journey.state) ? ` · ${boarded} boarded` : ""}
        </p>
      </header>

      {items.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Needs attention</h2>
          <ul className="flex flex-col gap-2">
            {items.map((item) => <AttentionRow key={item.id} item={item} can={can} onChange={reload} />)}
          </ul>
        </section>
      ) : null}

      {journey.state === "DRAFT" && can.journeys ? <PutOnSale journey={journey} onChange={reload} /> : null}

      <BusSection journey={journey} can={can} onChange={reload} />
      <CrewSection journey={journey} can={can} live={live} onChange={reload} />

      {passengers ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Passengers</h2>
            <Link className="text-sm underline" href={`/staff/journeys/${journey.id}`}>Open boarding</Link>
          </div>
          {passengers.length ? (
            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
              {passengers.map((p) => (
                <li key={p.ticketId} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span>
                    <span className="block font-medium">{p.seatNumber} · {p.passengerName}</span>
                    <span className="text-muted">
                      {p.boardingStop} → {p.destination}
                      {p.fareType !== "Standard" ? ` · ${p.fareType}` : ""} ·{" "}
                      <Link className="underline" href={`/ops/bookings/${p.reference}`}>{p.reference}</Link>
                      {!p.paymentConfirmed ? <span className="text-danger"> · payment needs attention</span> : null}
                    </span>
                  </span>
                  <span>{p.state === "BOARDED" ? `✓ ${p.boardedAt ? formatTime(p.boardedAt) : ""}` : <span className="text-muted">Not boarded</span>}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Notice>No seats sold yet.</Notice>
          )}
        </section>
      ) : null}

      {can.cancelJourney && live && journey.state !== "DEPARTED" ? <CancelJourney journeyId={journey.id} onDone={reload} /> : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">History</h2>
        <ol className="flex flex-col gap-1 text-sm">
          {journey.events.map((e, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-28 shrink-0 text-muted tabular-nums">{formatDay(e.occurredAt)} {formatTime(e.occurredAt)}</span>
              <span>
                {eventText(e)}
                {e.recordedByName ? <span className="text-muted"> · {e.recordedByName}</span> : null}
                {e.notes ? <span className="text-muted"> · {e.notes}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function PutOnSale({ journey, onChange }: { journey: Journey; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const missing = [!journey.vehicleRegistration && "a bus", journey.needsFares && "a live fare table for the route"].filter(Boolean);
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border p-4">
      <h2 className="font-semibold">Not on sale yet</h2>
      {missing.length ? (
        <Notice>Before passengers can book, this departure needs {missing.join(" and ")}.</Notice>
      ) : (
        <Notice>Everything is ready. Putting it on sale copies today&apos;s fares to this departure; later fare changes do not affect it.</Notice>
      )}
      <Button
        type="button"
        disabled={busy || missing.length > 0}
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          try {
            await api(`/api/ops/journeys/${journey.id}/publish`, { method: "POST" });
            onChange();
          } catch (e) {
            setMessage((e as ApiError).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Put on sale
      </Button>
      {message ? <Notice tone="error">{message}</Notice> : null}
    </section>
  );
}

function BusSection({ journey, can, onChange }: { journey: Journey; can: OpsCan; onChange: () => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [choice, setChoice] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canChange = can.assignBus && journey.state === "DRAFT";

  useEffect(() => {
    if (!canChange) return;
    api<{ items: Vehicle[] }>("/api/ops/vehicles?status=active&pageSize=100")
      .then((p) => setVehicles(p.items))
      .catch(() => setVehicles([]));
  }, [canChange]);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Bus</h2>
      <p>{journey.vehicleRegistration ?? <span className="text-danger">No bus assigned</span>}</p>
      {canChange && vehicles ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {journey.vehicleRegistration ? "Choose a different bus" : "Choose a bus"}
            <select className="h-12 rounded-lg border border-border bg-background px-3 text-base" value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Select…</option>
              {vehicles.filter((v) => v.bookableSeats).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.registration}{v.fleetNumber ? ` (${v.fleetNumber})` : ""} · {v.bookableSeats} seats
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            disabled={!choice || busy}
            onClick={async () => {
              setBusy(true);
              setMessage(null);
              try {
                await api(`/api/ops/journeys/${journey.id}/vehicle`, { method: "POST", body: { vehicleId: choice } });
                setChoice("");
                onChange();
              } catch (e) {
                setMessage((e as ApiError).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Assign this bus
          </Button>
          {message ? <Notice tone="error">{message} Nothing has been changed.</Notice> : null}
        </div>
      ) : null}
      {can.assignBus && journey.state !== "DRAFT" && !["CANCELLED", "COMPLETED", "DEPARTED"].includes(journey.state) ? (
        <VehicleChange journeyId={journey.id} currentRegistration={journey.vehicleRegistration} onDone={onChange} />
      ) : null}
    </section>
  );
}

function CrewSection({ journey, can, live, onChange }: { journey: Journey; can: OpsCan; live: boolean; onChange: () => void }) {
  const [people, setPeople] = useState<StaffMember[] | null>(null);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"conductor" | "driver">("conductor");
  const [message, setMessage] = useState<string | null>(null);
  const canChange = can.journeys && live && journey.state !== "DEPARTED";

  useEffect(() => {
    if (!canChange) return;
    api<StaffMember[]>("/api/ops/staff-members").then(setPeople).catch(() => setPeople([]));
  }, [canChange]);

  async function call(fn: () => Promise<unknown>) {
    setMessage(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setMessage((e as ApiError).message);
    }
  }

  const onCrew = new Set(journey.staff.map((s) => s.userId));
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Crew</h2>
      {journey.staff.length ? (
        <ul className="flex flex-col gap-1">
          {journey.staff.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3">
              <span>{s.fullName ?? "Unnamed staff member"} · {s.staffRole}</span>
              {canChange ? (
                <SmallButton onClick={() => call(() => api(`/api/ops/journeys/${journey.id}/staff/${s.id}`, { method: "DELETE" }))}>Remove</SmallButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-danger">No crew yet</p>
      )}
      {canChange && people ? (
        <div className="flex flex-wrap items-end gap-2">
          <select aria-label="Staff member" className="h-10 flex-1 rounded-lg border border-border bg-background px-2" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Add someone…</option>
            {people.filter((p) => !onCrew.has(p.id)).map((p) => (
              <option key={p.id} value={p.id}>{p.fullName ?? "Unnamed"} ({p.roles.join(", ")})</option>
            ))}
          </select>
          <select aria-label="Role on this journey" className="h-10 rounded-lg border border-border bg-background px-2" value={role} onChange={(e) => setRole(e.target.value as "conductor" | "driver")}>
            <option value="conductor">Conductor</option>
            <option value="driver">Driver</option>
          </select>
          <SmallButton
            disabled={!userId}
            onClick={() =>
              call(async () => {
                await api(`/api/ops/journeys/${journey.id}/staff`, { method: "POST", body: { userId, staffRole: role } });
                setUserId("");
              })
            }
          >
            Add
          </SmallButton>
        </div>
      ) : null}
      {message ? <Notice tone="error">{message}</Notice> : null}
    </section>
  );
}

type CancellationPreview = {
  passengers: number;
  bookings: number;
  refundTotalPesewas: number;
  unpaidHolds: number;
  nextDeparture: { id: string; label: string; freeSeats: number } | null;
  messageTemplate: string;
};

/**
 * Cancelling a departure (15.2): who is affected, the refund total and the
 * exact text passengers receive are shown before anything happens (8.4).
 */
function CancelJourney({ journeyId, onDone }: { journeyId: string; onDone: () => void }) {
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function open() {
    setMessage(null);
    try {
      setPreview(await api<CancellationPreview>(`/api/ops/journeys/${journeyId}/cancellation`));
    } catch (e) {
      setMessage((e as ApiError).message);
    }
  }

  async function cancel() {
    if (!preview) return;
    const who = preview.passengers ? `${preview.passengers} passenger${preview.passengers === 1 ? "" : "s"} will be refunded ${formatCedis(preview.refundTotalPesewas)} in total and sent a text message.` : "No passengers are booked.";
    if (!window.confirm(`Cancel this departure? ${who} This cannot be undone.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/ops/journeys/${journeyId}/cancel`, { method: "POST", body: { reason } });
      setPreview(null);
      onDone();
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.code === "reconfirmation_required" ? "Enter your authenticator code again (sign out and in), then retry. Nothing has been changed." : `${err.message} Nothing has been changed.`);
    } finally {
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <section className="flex flex-col gap-2">
        <button type="button" className="self-start text-sm text-danger underline" onClick={open}>Cancel this departure</button>
        {message ? <Notice tone="error">{message}</Notice> : null}
      </section>
    );
  }

  const text = preview.messageTemplate.replace("{reason}", reason.trim() || "…").replace("{refund}", "(their amount)");
  return (
    <section className="flex flex-col gap-3 rounded-xl border-2 border-danger p-4">
      <h2 className="text-lg font-semibold">Cancel this departure</h2>
      <ul className="list-disc pl-5 text-sm">
        <li>{preview.passengers} passenger{preview.passengers === 1 ? "" : "s"} on {preview.bookings} booking{preview.bookings === 1 ? "" : "s"}</li>
        <li>{formatCedis(preview.refundTotalPesewas)} refunded in total, including fees, automatically</li>
        {preview.unpaidHolds ? <li>{preview.unpaidHolds} unpaid hold{preview.unpaidHolds === 1 ? "" : "s"} will end; a payment that still arrives is refunded</li> : null}
        <li>{preview.nextDeparture ? `Passengers are pointed to the next bus: ${preview.nextDeparture.label} (${preview.nextDeparture.freeSeats} seats free)` : "There is no later departure on this route to offer"}</li>
      </ul>
      <Field label="Reason passengers will be told" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="the bus has broken down" />
      <div className="rounded-lg bg-foreground/5 p-3 text-sm">
        <p className="mb-1 font-medium">The text message each passenger receives:</p>
        <p>{text}</p>
      </div>
      {message ? <Notice tone="error">{message}</Notice> : null}
      <div className="flex gap-2">
        <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => setPreview(null)}>Keep the departure</button>
        <Button type="button" disabled={busy || reason.trim().length < 5} onClick={cancel}>{busy ? "Cancelling…" : "Cancel and refund everyone"}</Button>
      </div>
    </section>
  );
}
