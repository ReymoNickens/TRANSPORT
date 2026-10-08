"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { generateSeatGrid, type SeatGrid } from "@/domain/seat-grid";
import { api, ApiError } from "@/lib/client/api";
import { formatDay } from "@/lib/format";
import { Button, Field, Notice, Select } from "../ui";
import { BackButton, ChoiceCard, Steps } from "./Guide";

type VehicleSummary = {
  id: string;
  registration: string;
  fleetNumber: string | null;
  vehicleType: "coach" | "bus" | "minibus";
  make: string | null;
  model: string | null;
  capacity: number;
  status: "active" | "maintenance" | "retired";
  layoutVersion: number | null;
  layoutName: string | null;
  bookableSeats: number | null;
};
type Vehicle = Omit<VehicleSummary, "layoutVersion" | "layoutName" | "bookableSeats"> & {
  year: number | null;
  notes: string | null;
  layouts: { id: string; version: number; name: string; status: "draft" | "published" | "retired"; publishedAt: string | null; bookableSeats: number }[];
};

const vehicleStatus = { active: "In service", maintenance: "In the workshop", retired: "Retired" } as const;
const vehicleType = { coach: "Coach", bus: "Bus", minibus: "Minibus" } as const;

/** The fleet (8.6): registration, seats, status. */
export function BusList() {
  const [buses, setBuses] = useState<VehicleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: VehicleSummary[] }>("/api/ops/vehicles?pageSize=100").then((p) => setBuses(p.items)).catch((e: ApiError) => setError(e.message));
  }, []);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!buses) return <Notice>Loading buses…</Notice>;
  return (
    <div className="flex flex-col gap-4">
      <Link href="/ops/fleet/new" className="flex h-12 items-center justify-center rounded-lg bg-accent font-medium text-accent-foreground">Add a bus</Link>
      {buses.length ? (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {buses.map((b) => (
            <li key={b.id}>
              <Link href={`/ops/fleet/${b.id}`} className="flex items-center justify-between gap-3 p-3">
                <span>
                  <span className="block font-medium">{b.registration}{b.fleetNumber ? ` (${b.fleetNumber})` : ""}</span>
                  <span className="text-sm text-muted">
                    {vehicleType[b.vehicleType]}{b.make ? ` · ${b.make}${b.model ? ` ${b.model}` : ""}` : ""} · {b.bookableSeats ? `${b.bookableSeats} seats for sale` : "no seat plan yet"}
                  </span>
                </span>
                <span className={`text-sm ${b.status === "active" ? "font-medium" : "text-danger"}`}>{vehicleStatus[b.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>No buses yet.</Notice>
      )}
    </div>
  );
}

/** A small drawing of a seat plan, front at the top. */
export function SeatPlan({ grid }: { grid: SeatGrid }) {
  const byPosition = new Map(grid.seats.map((s) => [`${s.rowNumber}-${s.columnNumber}`, s]));
  return (
    <div className="flex flex-col items-center gap-1" aria-label={`Seat plan with ${grid.seats.length} seats`}>
      <span className="text-xs text-muted">Front (driver)</span>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${grid.columnCount}, 2rem)` }}>
        {Array.from({ length: grid.rowCount }, (_, r) =>
          Array.from({ length: grid.columnCount }, (_, c) => {
            const seat = byPosition.get(`${r + 1}-${c + 1}`);
            return seat ? (
              <span key={`${r}-${c}`} className={`flex h-8 items-center justify-center rounded border text-[10px] ${seat.seatType === "premium" ? "border-accent font-semibold" : "border-border"}`}>
                {seat.seatNumber}
              </span>
            ) : (
              <span key={`${r}-${c}`} />
            );
          }),
        )}
      </div>
    </div>
  );
}

const patterns = [
  { label: "Coach, 2 + 2", left: 2, right: 2, rows: 13, fullBackRow: false },
  { label: "Coach, 2 + 2 with a full back row", left: 2, right: 2, rows: 12, fullBackRow: true },
  { label: "Bus, 2 + 1", left: 2, right: 1, rows: 11, fullBackRow: false },
  { label: "Minibus, 2 + 1", left: 2, right: 1, rows: 5, fullBackRow: false },
] as const;

const busSteps = ["The bus", "Seats", "Check and save"] as const;

/**
 * Adding a bus as a guided sequence: its details, then its seat plan from a
 * familiar pattern, then a check. Saving publishes the seat plan, so the bus
 * can be assigned to departures straight away.
 */
export function NewBus() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [details, setDetails] = useState({ registration: "", fleetNumber: "", vehicleType: "coach" as VehicleSummary["vehicleType"], make: "", model: "", capacity: "" });
  const [patternIndex, setPatternIndex] = useState(0);
  const [rows, setRows] = useState(String(patterns[0].rows));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pattern = { ...patterns[patternIndex], rows: Number(rows) || 0 };
  const grid = useMemo(() => {
    try {
      return generateSeatGrid(pattern);
    } catch {
      return null;
    }
  }, [pattern.left, pattern.right, pattern.rows, pattern.fullBackRow]); // eslint-disable-line react-hooks/exhaustive-deps
  const capacity = Number(details.capacity) || 0;
  const detailsOk = /^[A-Za-z0-9][A-Za-z0-9 -]{2,14}$/.test(details.registration.trim()) && capacity >= 1 && capacity <= 100;
  const seatsOk = !!grid && grid.seats.length <= capacity;

  async function save() {
    setBusy(true);
    setMessage(null);
    let vehicleId: string | null = null;
    try {
      const vehicle = await api<{ id: string }>("/api/ops/vehicles", {
        method: "POST",
        body: {
          registration: details.registration,
          fleetNumber: details.fleetNumber || null,
          vehicleType: details.vehicleType,
          make: details.make || null,
          model: details.model || null,
          capacity,
        },
      });
      vehicleId = vehicle.id;
      const layout = await api<{ id: string }>(`/api/ops/vehicles/${vehicle.id}/layouts`, {
        method: "POST",
        body: { name: patterns[patternIndex].label, pattern: { left: pattern.left, right: pattern.right, rows: pattern.rows, fullBackRow: pattern.fullBackRow } },
      });
      await api(`/api/ops/seat-layouts/${layout.id}/publish`, { method: "POST" });
      router.push(`/ops/fleet/${vehicle.id}`);
    } catch (e) {
      const text = (e as ApiError).message;
      if (vehicleId) {
        setMessage(`${text} The bus was saved without a seat plan. Opening it so you can finish.`);
        setTimeout(() => router.push(`/ops/fleet/${vehicleId}`), 2500);
      } else {
        setMessage(`${text} Nothing has been saved.`);
        setBusy(false);
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Steps steps={busSteps} current={step} />
      {step === 0 ? (
        <section className="flex flex-col gap-3">
          <Field label="Registration (number plate)" placeholder="GR-1234-22" value={details.registration} onChange={(e) => setDetails({ ...details, registration: e.target.value })} />
          <Field label="Fleet number (optional)" placeholder="C1" value={details.fleetNumber} onChange={(e) => setDetails({ ...details, fleetNumber: e.target.value })} />
          <Select label="Kind of vehicle" value={details.vehicleType} onChange={(e) => setDetails({ ...details, vehicleType: e.target.value as VehicleSummary["vehicleType"] })}>
            <option value="coach">Coach</option>
            <option value="bus">Bus</option>
            <option value="minibus">Minibus</option>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Make (optional)" placeholder="Yutong" value={details.make} onChange={(e) => setDetails({ ...details, make: e.target.value })} />
            <Field label="Model (optional)" value={details.model} onChange={(e) => setDetails({ ...details, model: e.target.value })} />
          </div>
          <Field label="Licensed passenger seats" inputMode="numeric" value={details.capacity} onChange={(e) => setDetails({ ...details, capacity: e.target.value.replace(/\D/g, "") })} hint="From the vehicle licence. The seat plan cannot have more seats than this." />
          <Button type="button" disabled={!detailsOk} onClick={() => setStep(1)}>Next: seats</Button>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">How are the seats arranged?</h2>
          <div className="flex flex-col gap-2">
            {patterns.map((p, i) => (
              <ChoiceCard key={p.label} name="pattern" checked={patternIndex === i} onChange={() => { setPatternIndex(i); setRows(String(p.rows)); }}>
                {p.label}
              </ChoiceCard>
            ))}
          </div>
          <Field label="Rows of seats" inputMode="numeric" value={rows} onChange={(e) => setRows(e.target.value.replace(/\D/g, ""))} />
          {grid ? (
            <>
              <p className="text-sm">
                <strong>{grid.seats.length} seats</strong>, all standard.
              </p>
              {!seatsOk ? <Notice tone="error">That is more seats than the {capacity} on the licence. Use fewer rows.</Notice> : null}
              <SeatPlan grid={grid} />
            </>
          ) : (
            <Notice tone="error">Use between 1 and 30 rows.</Notice>
          )}
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(0)} />
            <Button type="button" disabled={!seatsOk} onClick={() => setStep(2)}>Next: check</Button>
          </div>
        </section>
      ) : null}

      {step === 2 && grid ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Check</h2>
          <p>
            <strong>{details.registration.toUpperCase()}</strong>{details.fleetNumber ? ` (${details.fleetNumber})` : ""} · {vehicleType[details.vehicleType]}
            {details.make ? ` · ${details.make} ${details.model}` : ""} · {grid.seats.length} seats for sale
          </p>
          <Notice>Saving puts the bus in service with this seat plan. A seat plan cannot be changed once departures use it; you would add a new version for future departures.</Notice>
          {message ? <Notice tone="error">{message}</Notice> : null}
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(1)} />
            <Button type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save the bus"}</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** One bus: details, seat plan versions and whether it is in service. */
export function BusDetail() {
  const { id } = useParams<{ id: string }>();
  const [bus, setBus] = useState<Vehicle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    api<Vehicle>(`/api/ops/vehicles/${id}`).then(setBus).catch((e: ApiError) => setError(e.message));
  }, [id, refresh]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!bus) return <Notice>Loading the bus…</Notice>;

  async function setStatus(status: Vehicle["status"]) {
    const warning =
      status === "retired"
        ? "Retire this bus for good? It cannot be given new departures. A bus that still has coming departures cannot be retired until their bus is changed."
        : status === "maintenance"
          ? "Send this bus to the workshop? It cannot be given new departures until it is back in service."
          : "Put this bus back in service?";
    if (!window.confirm(warning)) return;
    setMessage(null);
    try {
      await api(`/api/ops/vehicles/${id}`, { method: "PATCH", body: { status } });
      reload();
    } catch (e) {
      setMessage(`${(e as ApiError).message} Nothing has been changed.`);
    }
  }

  async function publishDraft(layoutId: string) {
    setMessage(null);
    try {
      await api(`/api/ops/seat-layouts/${layoutId}/publish`, { method: "POST" });
      reload();
    } catch (e) {
      setMessage((e as ApiError).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{bus.registration}{bus.fleetNumber ? ` (${bus.fleetNumber})` : ""}</h1>
        <p className="text-muted">
          {vehicleType[bus.vehicleType]}{bus.make ? ` · ${bus.make}${bus.model ? ` ${bus.model}` : ""}` : ""}{bus.year ? ` · ${bus.year}` : ""} · licensed for {bus.capacity}
        </p>
        <p className="font-medium">{vehicleStatus[bus.status]}</p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Seat plans</h2>
        {bus.layouts.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {bus.layouts.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3">
                <span>Version {l.version}: {l.name} · {l.bookableSeats} seats</span>
                <span className="text-muted">
                  {l.status === "published" ? `In use since ${l.publishedAt ? formatDay(l.publishedAt) : "–"}` : l.status === "draft" ? (
                    <button type="button" className="underline" onClick={() => publishDraft(l.id)}>Start using this plan</button>
                  ) : "No longer used"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Notice tone="error">This bus has no seat plan, so it cannot be given departures.</Notice>
        )}
      </section>

      <section className="flex flex-wrap gap-2">
        {bus.status !== "active" ? <Button type="button" onClick={() => setStatus("active")}>Back in service</Button> : null}
        {bus.status === "active" ? <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => setStatus("maintenance")}>To the workshop</button> : null}
        {bus.status !== "retired" ? <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => setStatus("retired")}>Retire</button> : null}
      </section>
      {message ? <Notice tone="error">{message}</Notice> : null}
    </div>
  );
}
