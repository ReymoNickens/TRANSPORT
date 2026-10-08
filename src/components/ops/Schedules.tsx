"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatDay, formatTime, todayInAccra } from "@/lib/format";
import { Button, Field, Notice, Select } from "../ui";
import { ChoiceCard } from "./Guide";

type ScheduleSummary = {
  id: string;
  name: string;
  status: "active" | "paused" | "archived";
  routeName: string;
  departureTime: string;
  daysOfWeek: number[];
  defaultVehicleRegistration: string | null;
};
type Schedule = ScheduleSummary & {
  routeId: string;
  bookingOpenDaysBefore: number | null;
  versions: { version: number; departureTime: string; daysOfWeek: number[]; defaultVehicleRegistration: string | null; createdAt: string }[];
  exceptions: { id: string; serviceDate: string; kind: "skip" | "move" | "extra"; departureTime: string | null; reason: string }[];
  upcomingJourneys: number;
};
type Impact = {
  toRetime: number;
  toCancel: number;
  unchangedBecauseBooked: number;
  journeys: { id: string; serviceDate: string; scheduledDepartureAt: string; newDepartureAt: string | null; hasBookings: boolean }[];
};
type RouteSummary = { id: string; name: string };
type Vehicle = { id: string; registration: string; fleetNumber: string | null; bookableSeats: number | null };

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const scheduleStatus = { active: "Running", paused: "Paused", archived: "Ended" } as const;
const hhmm = (time: string) => time.slice(0, 5);

export function daysText(days: number[]) {
  if (days.length === 7) return "Every day";
  if (days.join() === "1,2,3,4,5") return "Weekdays";
  if (days.join() === "6,7") return "Weekends";
  return days.map((d) => DAYS[d - 1]).join(", ");
}

function DayPicker({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">Days it runs</legend>
      <div className="flex flex-wrap gap-1">
        {DAYS.map((label, i) => {
          const day = i + 1;
          const on = value.includes(day);
          return (
            <button
              key={label}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((d) => d !== day) : [...value, day].sort())}
              className={`h-10 w-12 rounded-lg border text-sm font-medium ${on ? "border-accent bg-accent text-accent-foreground" : "border-border"}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function useBuses() {
  const [buses, setBuses] = useState<Vehicle[]>([]);
  useEffect(() => {
    api<{ items: Vehicle[] }>("/api/ops/vehicles?status=active&pageSize=100")
      .then((p) => setBuses(p.items.filter((v) => v.bookableSeats)))
      .catch(() => {});
  }, []);
  return buses;
}

/** Every schedule: route, time, days, default bus. */
export function ScheduleList() {
  const [schedules, setSchedules] = useState<ScheduleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: ScheduleSummary[] }>("/api/ops/schedules?pageSize=100").then((p) => setSchedules(p.items)).catch((e: ApiError) => setError(e.message));
  }, []);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!schedules) return <Notice>Loading schedules…</Notice>;
  return (
    <div className="flex flex-col gap-4">
      <Link href="/ops/schedules/new" className="flex h-12 items-center justify-center rounded-lg bg-accent font-medium text-accent-foreground">Create a schedule</Link>
      <Notice>Departures are created from running schedules every night, up to 30 days ahead.</Notice>
      {schedules.length ? (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {schedules.map((s) => (
            <li key={s.id}>
              <Link href={`/ops/schedules/${s.id}`} className="flex items-center justify-between gap-3 p-3">
                <span>
                  <span className="block font-medium">{hhmm(s.departureTime)} · {s.routeName}</span>
                  <span className="text-sm text-muted">{s.name} · {daysText(s.daysOfWeek)} · {s.defaultVehicleRegistration ?? "no default bus"}</span>
                </span>
                <span className={`text-sm ${s.status === "active" ? "font-medium" : "text-muted"}`}>{scheduleStatus[s.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>No schedules yet.</Notice>
      )}
    </div>
  );
}

/** A recurring departure: route, time, days and the bus it normally uses. */
export function NewSchedule() {
  const router = useRouter();
  const buses = useBuses();
  const [routes, setRoutes] = useState<RouteSummary[] | null>(null);
  const [routeId, setRouteId] = useState("");
  const [time, setTime] = useState("07:00");
  const [days, setDays] = useState([1, 2, 3, 4, 5, 6, 7]);
  const [vehicleId, setVehicleId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: RouteSummary[] }>("/api/ops/routes?status=active&pageSize=100").then((p) => setRoutes(p.items)).catch((e: ApiError) => setMessage(e.message));
  }, []);

  const route = routes?.find((r) => r.id === routeId);
  const suggested = route ? `${route.name}, ${daysText(days).toLowerCase()} ${time}` : "";

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Route</h2>
        {routes && !routes.length ? <Notice>There are no live routes yet. Create a route first.</Notice> : null}
        {routes?.map((r) => (
          <ChoiceCard key={r.id} name="route" checked={routeId === r.id} onChange={() => setRouteId(r.id)}>{r.name}</ChoiceCard>
        ))}
      </section>
      <Field label="Departure time (Ghana time)" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      <DayPicker value={days} onChange={setDays} />
      <Select label="Bus it normally uses" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} hint="Departures with a bus go on sale by themselves. Without one they wait on the dashboard as 'needs a bus'.">
        <option value="">No default bus</option>
        {buses.map((b) => <option key={b.id} value={b.id}>{b.registration}{b.fleetNumber ? ` (${b.fleetNumber})` : ""} · {b.bookableSeats} seats</option>)}
      </Select>
      <Field label="Name" value={name || suggested} onChange={(e) => setName(e.target.value)} hint="For staff, for example 'Morning Cape Coast'." />
      {route ? (
        <Notice>
          {route.name} will leave at {time}, {daysText(days).toLowerCase()}. Departures for the next 30 days are created tonight; booking opens 30 days before each one.
        </Notice>
      ) : null}
      {message ? <Notice tone="error">{message}</Notice> : null}
      <Button
        type="button"
        disabled={busy || !routeId || !days.length || (name || suggested).trim().length < 2}
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          try {
            const schedule = await api<{ id: string }>("/api/ops/schedules", {
              method: "POST",
              body: { routeId, name: (name || suggested).slice(0, 120), departureTime: time, daysOfWeek: days, defaultVehicleId: vehicleId || null },
            });
            router.push(`/ops/schedules/${schedule.id}`);
          } catch (e) {
            setMessage(`${(e as ApiError).message} Nothing has been saved.`);
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : "Create the schedule"}
      </Button>
    </div>
  );
}

/** One schedule: its pattern, changes with a preview, holidays and one-off runs, pause and end. */
export function ScheduleDetail() {
  const { id } = useParams<{ id: string }>();
  const buses = useBuses();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const [editing, setEditing] = useState<{ time: string; days: number[]; vehicleId: string } | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [exception, setException] = useState({ serviceDate: "", kind: "skip" as "skip" | "move" | "extra", departureTime: "", reason: "" });

  useEffect(() => {
    api<Schedule>(`/api/ops/schedules/${id}`).then(setSchedule).catch((e: ApiError) => setError(e.message));
  }, [id, refresh]);

  async function run<T>(fn: () => Promise<T>, done?: (result: T) => void) {
    setMessage(null);
    try {
      const result = await fn();
      done?.(result);
      reload();
    } catch (e) {
      setMessage({ tone: "error", text: `${(e as ApiError).message} Nothing has been changed.` });
    }
  }

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!schedule) return <Notice>Loading the schedule…</Notice>;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{schedule.name}</h1>
        <p className="text-muted">{schedule.routeName}</p>
        <p className="font-medium">
          {hhmm(schedule.departureTime)} · {daysText(schedule.daysOfWeek)} · {schedule.defaultVehicleRegistration ?? "no default bus"} · {scheduleStatus[schedule.status]}
        </p>
        <p className="text-sm text-muted">{schedule.upcomingJourneys} upcoming departures created from it.</p>
      </header>

      {schedule.status !== "archived" ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Change the time, days or bus</h2>
          {editing ? (
            <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
              <Field label="Departure time" type="time" value={editing.time} onChange={(e) => setEditing({ ...editing, time: e.target.value })} />
              <DayPicker value={editing.days} onChange={(days) => setEditing({ ...editing, days })} />
              <Select label="Bus it normally uses" value={editing.vehicleId} onChange={(e) => setEditing({ ...editing, vehicleId: e.target.value })}>
                <option value="">No default bus</option>
                {buses.map((b) => <option key={b.id} value={b.id}>{b.registration} · {b.bookableSeats} seats</option>)}
              </Select>
              <div className="flex gap-2">
                <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => setEditing(null)}>Cancel</button>
                <Button
                  type="button"
                  disabled={!editing.days.length}
                  onClick={() =>
                    run(
                      () => api<{ impact: Impact }>(`/api/ops/schedules/${id}/versions`, { method: "POST", body: { departureTime: editing.time, daysOfWeek: editing.days, defaultVehicleId: editing.vehicleId || null } }),
                      (r) => {
                        setEditing(null);
                        setImpact(r.impact);
                      },
                    )
                  }
                >
                  Save the change
                </Button>
              </div>
            </div>
          ) : (
            <button type="button" className="self-start text-sm underline" onClick={() =>
                setEditing({
                  time: hhmm(schedule.departureTime),
                  days: schedule.daysOfWeek,
                  vehicleId: buses.find((b) => b.registration === schedule.defaultVehicleRegistration)?.id ?? "",
                })
              }>
              Change
            </button>
          )}
          {impact && (impact.toRetime || impact.toCancel || impact.unchangedBecauseBooked) ? (
            <div className="flex flex-col gap-2 rounded-xl border-2 border-accent p-3">
              <p className="font-medium">New departures follow the change. For departures already created:</p>
              <ul className="list-disc pl-5 text-sm">
                {impact.toRetime ? <li>{impact.toRetime} will move to the new time</li> : null}
                {impact.toCancel ? <li>{impact.toCancel} will be cancelled because the schedule no longer runs that day</li> : null}
                {impact.unchangedBecauseBooked ? <li>{impact.unchangedBecauseBooked} already have passengers and stay as they are</li> : null}
              </ul>
              <div className="flex gap-2">
                <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => setImpact(null)}>Leave them as they are</button>
                <Button
                  type="button"
                  onClick={() =>
                    run(
                      () => api<{ retimed: number; cancelled: number }>(`/api/ops/schedules/${id}/changes`, { method: "POST" }),
                      (r) => {
                        setImpact(null);
                        setMessage({ tone: "info", text: `${r.retimed} departures moved and ${r.cancelled} cancelled.` });
                      },
                    )
                  }
                >
                  Apply to them
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Holidays and one-off changes</h2>
        {schedule.exceptions.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {schedule.exceptions.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3">
                <span>
                  {formatDay(`${e.serviceDate}T12:00:00Z`)}:{" "}
                  {e.kind === "skip" ? "does not run" : e.kind === "move" ? `runs at ${hhmm(e.departureTime ?? "")}` : `extra run at ${hhmm(e.departureTime ?? "")}`}
                  <span className="text-muted"> · {e.reason}</span>
                </span>
                <button type="button" className="underline" onClick={() => run(() => api(`/api/ops/schedule-exceptions/${e.id}`, { method: "DELETE" }))}>Remove</button>
              </li>
            ))}
          </ul>
        ) : (
          <Notice>None.</Notice>
        )}
        {schedule.status !== "archived" ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <Field label="Date" type="date" min={todayInAccra()} value={exception.serviceDate} onChange={(e) => setException({ ...exception, serviceDate: e.target.value })} />
            <Select label="What happens that day" value={exception.kind} onChange={(e) => setException({ ...exception, kind: e.target.value as "skip" | "move" | "extra" })}>
              <option value="skip">It does not run (holiday)</option>
              <option value="move">It runs at a different time</option>
              <option value="extra">An extra run on a day it does not normally run</option>
            </Select>
            {exception.kind !== "skip" ? (
              <Field label="Departure time that day" type="time" value={exception.departureTime} onChange={(e) => setException({ ...exception, departureTime: e.target.value })} />
            ) : null}
            <Field label="Reason" placeholder="Public holiday" value={exception.reason} onChange={(e) => setException({ ...exception, reason: e.target.value })} />
            <Button
              type="button"
              disabled={!exception.serviceDate || exception.reason.trim().length < 2 || (exception.kind !== "skip" && !exception.departureTime)}
              onClick={() =>
                run(
                  () =>
                    api<{ notice: string | null }>(`/api/ops/schedules/${id}/exceptions`, {
                      method: "POST",
                      body: { ...exception, departureTime: exception.kind === "skip" ? null : exception.departureTime },
                    }),
                  (r) => {
                    setException({ serviceDate: "", kind: "skip", departureTime: "", reason: "" });
                    if (r.notice) setMessage({ tone: "info", text: r.notice });
                  },
                )
              }
            >
              Add
            </Button>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">History</h2>
        <ol className="flex flex-col gap-1 text-sm">
          {[...schedule.versions].reverse().map((v) => (
            <li key={v.version}>
              <span className="text-muted">{formatDay(v.createdAt)} {formatTime(v.createdAt)} · </span>
              {hhmm(v.departureTime)}, {daysText(v.daysOfWeek).toLowerCase()}, {v.defaultVehicleRegistration ?? "no default bus"}
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-wrap gap-2">
        {schedule.status === "active" ? (
          <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => window.confirm("Pause this schedule? No new departures are created while it is paused. Departures already created are not affected.") && run(() => api(`/api/ops/schedules/${id}/status`, { method: "POST", body: { status: "paused" } }))}>
            Pause
          </button>
        ) : null}
        {schedule.status === "paused" ? (
          <Button type="button" onClick={() => run(() => api(`/api/ops/schedules/${id}/status`, { method: "POST", body: { status: "active" } }))}>Start again</Button>
        ) : null}
        {schedule.status !== "archived" ? (
          <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => window.confirm("End this schedule for good? No new departures are created. Departures already created are not affected.") && run(() => api(`/api/ops/schedules/${id}/status`, { method: "POST", body: { status: "archived" } }))}>
            End
          </button>
        ) : null}
      </section>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </div>
  );
}
