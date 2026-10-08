"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatDay, formatTime } from "@/lib/format";
import { Button, Field, Notice } from "../ui";
import { stateLabel } from "./StaffJourneys";

type BoardingTicket = {
  ticketId: string;
  ticketNumber: string;
  reference: string;
  passengerName: string;
  seatNumber: string;
  boardingStop: string;
  destination: string;
  fareType: string;
  checkStudentId: boolean;
};
type BoardingResult = { outcome: "ok" | "boarded" | "refused"; code: string | null; message: string | null; ticket: BoardingTicket | null };
type ManifestRow = BoardingTicket & { state: "VALID" | "BOARDED"; boardedAt: string | null; boardedBy: string | null; method: string | null; paymentConfirmed: boolean };
type Manifest = {
  journey: { id: string; label: string; state: string; scheduledDepartureAt: string; vehicleRegistration: string | null };
  rows: ManifestRow[];
  openSheets: { id: string; sheetNumber: number; exportedAt: string }[];
};
type PaperManifest = { sheetNumber: number; exportId: string; exportedAt: string; journey: Manifest["journey"]; rows: (ManifestRow & { boardingCode: string | null })[] };
type Can = { scan: boolean; manual: boolean; override: boolean; status: boolean; print: boolean };

/** What a refused check the override permission may board against (14.4). */
const OVERRIDABLE = new Set(["payment_attention", "not_open", "journey_left"]);

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * The conductor's screen for one journey (14.3 to 14.7): scan, find a
 * passenger, the passenger list and the paper sheet for no signal. The
 * server decides every result; this screen never shows a boarding as done
 * until the server has confirmed it.
 */
export function BoardingConsole({ can }: { can: Can }) {
  const { id } = useParams<{ id: string }>();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<"scan" | "find" | "list" | "paper">(can.scan ? "scan" : "find");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    api<Manifest>(`/api/staff/journeys/${id}/manifest`)
      .then((m) => live && (setManifest(m), setError(null)))
      .catch((e: ApiError) => live && setError(e));
    return () => {
      live = false;
    };
  }, [id, refresh]);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  if (error && !manifest) return <Notice tone="error">{error.message}</Notice>;
  if (!manifest) return <Notice>Loading the passenger list…</Notice>;

  const boarded = manifest.rows.filter((r) => r.state === "BOARDED").length;
  const tabs = [
    can.scan && (["scan", "Scan"] as const),
    can.manual && (["find", "Find"] as const),
    ["list", "Passengers"] as const,
    can.print && (["paper", "No signal"] as const),
  ].filter(Boolean) as (readonly [typeof tab, string])[];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1 print:hidden">
        <Link href="/staff" className="text-sm text-muted underline">← Today</Link>
        <h1 className="text-2xl font-semibold tracking-tight">{manifest.journey.label}</h1>
        <p className="text-sm text-muted">
          {stateLabel[manifest.journey.state] ?? manifest.journey.state} · {manifest.journey.vehicleRegistration ?? "no bus"} ·{" "}
          <strong className="text-foreground">{boarded} of {manifest.rows.length} boarded</strong>
        </p>
      </header>

      {can.status ? <StatusActions journeyId={id} state={manifest.journey.state} onChange={reload} /> : null}

      <nav className="grid grid-flow-col gap-1 rounded-lg border border-border p-1 print:hidden" aria-label="Boarding tools">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`h-10 rounded-md text-sm font-medium ${tab === key ? "bg-accent text-accent-foreground" : ""}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "scan" ? <ScanTab journeyId={id} can={can} onBoarded={reload} /> : null}
      {tab === "find" ? <FindTab journeyId={id} can={can} onBoarded={reload} /> : null}
      {tab === "list" ? <PassengerList rows={manifest.rows} /> : null}
      {tab === "paper" ? <PaperTab journeyId={id} manifest={manifest} onChange={reload} /> : null}
    </div>
  );
}

function StatusActions({ journeyId, state, onChange }: { journeyId: string; state: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const next =
    state === "SCHEDULED" || state === "SALES_CLOSED"
      ? { to: "BOARDING", label: "Start boarding" }
      : state === "BOARDING"
        ? { to: "DEPARTED", label: "Record departure" }
        : state === "DEPARTED"
          ? { to: "COMPLETED", label: "Record arrival" }
          : null;
  if (!next) return null;

  async function move() {
    if (next!.to !== "BOARDING" && !window.confirm(`${next!.label} now?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/staff/journeys/${journeyId}/status`, { method: "POST", body: { to: next!.to } });
      onChange();
    } catch (e) {
      setMessage((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2 print:hidden">
      <Button type="button" onClick={move} disabled={busy}>{busy ? "Saving…" : next.label}</Button>
      {message ? <Notice tone="error">{message}</Notice> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A checked ticket and its Confirm button
// ---------------------------------------------------------------------------

function ResultCard({
  result,
  can,
  onConfirm,
  onOverride,
  onDone,
}: {
  result: BoardingResult;
  can: Can;
  onConfirm: () => Promise<void>;
  onOverride: (reason: string) => Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const t = result.ticket;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      const err = e as ApiError;
      setMessage(
        err.code === "offline"
          ? "No reply from the server, so the passenger is NOT boarded yet. Press Confirm again; it is safe to repeat."
          : err.code === "reconfirmation_required"
            ? "Enter your authenticator code again (sign out and in), then retry."
            : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  const tone =
    result.outcome === "boarded" ? "border-accent bg-accent/10" : result.outcome === "refused" ? "border-danger bg-danger/10" : "border-border";

  return (
    <section className={`flex flex-col gap-3 rounded-xl border-2 p-4 ${tone}`} aria-live="polite">
      {result.outcome === "boarded" ? <p className="text-xl font-semibold">✓ Boarded</p> : null}
      {result.outcome === "refused" ? <p className="text-xl font-semibold text-danger">✕ {result.message}</p> : null}
      {t ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
          <dt className="text-muted">Name</dt>
          <dd className="font-semibold">{t.passengerName}</dd>
          <dt className="text-muted">Seat</dt>
          <dd className="text-2xl font-bold">{t.seatNumber}</dd>
          <dt className="text-muted">From</dt>
          <dd>{t.boardingStop}</dd>
          <dt className="text-muted">To</dt>
          <dd>{t.destination}</dd>
          <dt className="text-muted">Fare</dt>
          <dd>{t.fareType}</dd>
          <dt className="text-muted">Ticket</dt>
          <dd className="font-mono text-sm">{t.ticketNumber} · {t.reference}</dd>
        </dl>
      ) : null}
      {t?.checkStudentId && result.outcome !== "refused" ? (
        <p className="rounded-lg bg-foreground px-3 py-2 font-semibold text-background">Check student ID</p>
      ) : null}
      {result.outcome === "ok" ? (
        <Button type="button" disabled={busy} onClick={() => run(onConfirm)}>
          {busy ? "Boarding…" : "Confirm boarding"}
        </Button>
      ) : null}
      {result.outcome === "refused" && can.override && t && result.code && OVERRIDABLE.has(result.code) ? (
        <button
          type="button"
          className="h-11 rounded-lg border border-border font-medium"
          disabled={busy}
          onClick={() => {
            const reason = window.prompt("Why are you boarding this passenger anyway? This is recorded.");
            if (reason) void run(() => onOverride(reason));
          }}
        >
          Board anyway (manager)
        </button>
      ) : null}
      {message ? <Notice tone="error">{message}</Notice> : null}
      {result.outcome !== "ok" ? (
        <button type="button" className="h-11 rounded-lg border border-border font-medium" onClick={onDone}>
          Next passenger
        </button>
      ) : null}
    </section>
  );
}

/** Holds the current check and confirms it with one idempotency key, so a retried confirm never boards twice. */
function useBoarding(journeyId: string, onBoarded: () => void) {
  const [result, setResult] = useState<BoardingResult | null>(null);
  const [subject, setSubject] = useState<{ kind: "scan"; token: string } | { kind: "manual"; ticketId: string } | null>(null);
  const key = useRef<string>("");

  const check = useCallback(
    async (next: { kind: "scan"; token: string } | { kind: "manual"; ticketId: string }) => {
      const path = next.kind === "scan" ? "scan" : "board";
      const body = next.kind === "scan" ? { token: next.token, confirm: false } : { ticketId: next.ticketId, confirm: false };
      const r = await api<BoardingResult>(`/api/staff/journeys/${journeyId}/${path}`, { method: "POST", body });
      key.current = newKey();
      setSubject(next);
      setResult(r);
    },
    [journeyId],
  );

  const confirm = useCallback(async () => {
    if (!subject) return;
    const path = subject.kind === "scan" ? "scan" : "board";
    const body = subject.kind === "scan" ? { token: subject.token, confirm: true } : { ticketId: subject.ticketId, confirm: true };
    const r = await api<BoardingResult>(`/api/staff/journeys/${journeyId}/${path}`, {
      method: "POST",
      body,
      headers: { "Idempotency-Key": key.current },
    });
    setResult(r);
    if (r.outcome === "boarded") onBoarded();
  }, [journeyId, subject, onBoarded]);

  const override = useCallback(
    async (reason: string) => {
      const ticketId = result?.ticket?.ticketId;
      if (!ticketId) return;
      const r = await api<BoardingResult>(`/api/staff/journeys/${journeyId}/override`, { method: "POST", body: { ticketId, reason } });
      setResult(r);
      if (r.outcome === "boarded") onBoarded();
    },
    [journeyId, result, onBoarded],
  );

  const clear = useCallback(() => {
    setResult(null);
    setSubject(null);
  }, []);

  return { result, check, confirm, override, clear };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
type DetectorConstructor = new (options: { formats: string[] }) => Detector;

function ScanTab({ journeyId, can, onBoarded }: { journeyId: string; can: Can; onBoarded: () => void }) {
  const boarding = useBoarding(journeyId, onBoarded);
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [camera, setCamera] = useState<"off" | "on" | "unsupported">("off");
  const video = useRef<HTMLVideoElement>(null);
  const busy = useRef(false);
  const { check, result } = boarding;

  const submit = useCallback(
    async (token: string) => {
      if (busy.current || !token.trim()) return;
      busy.current = true;
      setMessage(null);
      try {
        await check({ kind: "scan", token: token.trim() });
        setTyped("");
      } catch (e) {
        setMessage((e as ApiError).message);
      } finally {
        busy.current = false;
      }
    },
    [check],
  );

  // The phone camera reads the QR where the browser can (BarcodeDetector); otherwise type or paste.
  useEffect(() => {
    if (camera !== "on" || result) return;
    const Detector = (globalThis as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    (async () => {
      if (!Detector || !navigator.mediaDevices?.getUserMedia) {
        setCamera("unsupported");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        setMessage("The camera could not be opened. Allow camera access, or type the code instead.");
        setCamera("off");
        return;
      }
      if (stopped || !video.current) return;
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      const detector = new Detector({ formats: ["qr_code"] });
      timer = setInterval(async () => {
        if (!video.current || busy.current) return;
        const codes = await detector.detect(video.current).catch(() => []);
        if (codes[0]?.rawValue) void submit(codes[0].rawValue);
      }, 300);
    })();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [camera, result, submit]);

  if (boarding.result) {
    return <ResultCard result={boarding.result} can={can} onConfirm={boarding.confirm} onOverride={boarding.override} onDone={boarding.clear} />;
  }

  return (
    <section className="flex flex-col gap-3">
      {camera === "on" ? (
        <video ref={video} className="aspect-square w-full rounded-xl bg-foreground object-cover" muted playsInline />
      ) : (
        <Button type="button" onClick={() => setCamera("on")}>Open camera to scan</Button>
      )}
      {camera === "unsupported" ? <Notice>This browser cannot read QR codes. Use Chrome on Android, a scanner, or type the code.</Notice> : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(typed);
        }}
      >
        <Field label="Or scan with a scanner / paste the QR" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </form>
      {message ? <Notice tone="error">{message}</Notice> : null}
      <Notice>No QR? Use Find with the boarding code, booking reference or phone number.</Notice>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Find (manual lookup, 14.4)
// ---------------------------------------------------------------------------

function FindTab({ journeyId, can, onBoarded }: { journeyId: string; can: Can; onBoarded: () => void }) {
  const boarding = useBoarding(journeyId, onBoarded);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ManifestRow[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (boarding.result) {
    return (
      <ResultCard
        result={boarding.result}
        can={can}
        onConfirm={boarding.confirm}
        onOverride={boarding.override}
        onDone={() => {
          boarding.clear();
          setRows(null);
          setQ("");
        }}
      />
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage(null);
          try {
            setRows(await api<ManifestRow[]>(`/api/staff/journeys/${journeyId}/lookup?q=${encodeURIComponent(q)}`));
          } catch (err) {
            setMessage((err as ApiError).message);
          }
        }}
      >
        <Field label="Boarding code, reference, ticket number, phone or name" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <Button type="submit" disabled={q.trim().length < 2}>Find</Button>
      </form>
      {message ? <Notice tone="error">{message}</Notice> : null}
      {rows && !rows.length ? <Notice>No passenger on this journey matches. Check the journey and the spelling.</Notice> : null}
      {rows?.length ? (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.ticketId}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-border p-3 text-left"
                onClick={() => boarding.check({ kind: "manual", ticketId: r.ticketId }).catch((err: ApiError) => setMessage(err.message))}
              >
                <span>
                  <span className="block font-semibold">{r.passengerName}</span>
                  <span className="text-sm text-muted">Seat {r.seatNumber} · {r.boardingStop} → {r.destination}</span>
                </span>
                <span className="text-sm font-medium">{r.state === "BOARDED" ? "Boarded" : "Check"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Passenger list (14.5)
// ---------------------------------------------------------------------------

function PassengerList({ rows }: { rows: ManifestRow[] }) {
  if (!rows.length) return <Notice>No tickets sold for this journey.</Notice>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
      {rows.map((r) => (
        <li key={r.ticketId} className="flex items-center justify-between gap-3 p-3">
          <span>
            <span className="block font-medium">{r.seatNumber} · {r.passengerName}</span>
            <span className="text-sm text-muted">
              {r.boardingStop} → {r.destination}
              {r.fareType !== "Standard" ? ` · ${r.fareType}` : ""}
              {!r.paymentConfirmed ? " · payment needs attention" : ""}
            </span>
          </span>
          <span className="text-right text-sm">
            {r.state === "BOARDED" ? (
              <>✓ {r.boardedAt ? formatTime(r.boardedAt) : ""}<span className="block text-muted">{r.boardedBy}</span></>
            ) : (
              <span className="text-muted">Not yet</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// No signal: printed sheet and entry after the trip (14.7, D28)
// ---------------------------------------------------------------------------

function PaperTab({ journeyId, manifest, onChange }: { journeyId: string; manifest: Manifest; onChange: () => void }) {
  const [sheet, setSheet] = useState<PaperManifest | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function print() {
    setBusy(true);
    setMessage(null);
    try {
      const printed = await api<PaperManifest>(`/api/staff/journeys/${journeyId}/manifest-exports`, { method: "POST" });
      setSheet(printed);
      onChange();
      setTimeout(() => window.print(), 100);
    } catch (e) {
      setMessage((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 print:hidden">
        <Notice>
          With no signal, check each passenger against the printed sheet and tick it. When signal returns, enter the ticks
          below. Sheets carry personal data: return them after the trip to be destroyed.
        </Notice>
        <Button type="button" onClick={print} disabled={busy}>{busy ? "Preparing…" : "Print passenger sheet"}</Button>
        {message ? <Notice tone="error">{message}</Notice> : null}
      </div>
      {sheet ? <PrintedSheet sheet={sheet} /> : null}
      {manifest.openSheets.map((s) => (
        <SheetEntry key={s.id} journeyId={journeyId} sheet={s} manifest={manifest} onChange={onChange} />
      ))}
    </section>
  );
}

function PrintedSheet({ sheet }: { sheet: PaperManifest }) {
  return (
    <div className="hidden print:block">
      <h1 className="text-xl font-semibold">Passenger sheet no. {sheet.sheetNumber}</h1>
      <p className="text-sm">
        {sheet.journey.label} · {sheet.journey.vehicleRegistration ?? ""} · printed {formatDay(sheet.exportedAt)} {formatTime(sheet.exportedAt)}.
        Payment status as of printing. Return this sheet after the trip.
      </p>
      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr className="text-left">
            {["✓", "Time", "Seat", "Name", "From → To", "Fare", "Code", "Ref", "Paid"].map((h) => (
              <th key={h} className="border border-black px-1">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((r) => (
            <tr key={r.ticketId}>
              <td className="w-6 border border-black px-1">{r.state === "BOARDED" ? "✓" : ""}</td>
              <td className="w-14 border border-black px-1" />
              <td className="border border-black px-1 font-semibold">{r.seatNumber}</td>
              <td className="border border-black px-1">{r.passengerName}</td>
              <td className="border border-black px-1">{r.boardingStop} → {r.destination}</td>
              <td className="border border-black px-1">{r.checkStudentId ? `${r.fareType} (check ID)` : r.fareType}</td>
              <td className="border border-black px-1 font-mono">{r.boardingCode ?? ""}</td>
              <td className="border border-black px-1 font-mono">{r.reference}</td>
              <td className="border border-black px-1">{r.paymentConfirmed ? "Yes" : "NO"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SheetEntry({ journeyId, sheet, manifest, onChange }: { journeyId: string; sheet: Manifest["openSheets"][number]; manifest: Manifest; onChange: () => void }) {
  const waiting = manifest.rows.filter((r) => r.state === "VALID");
  const [times, setTimes] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const day = manifest.journey.scheduledDepartureAt.slice(0, 10);
  const ticked = Object.entries(times).filter(([, time]) => /^\d\d:\d\d$/.test(time));

  async function enter() {
    setBusy(true);
    setMessage(null);
    try {
      // Accra keeps UTC all year, so the time on the sheet is a UTC time on the service date.
      const entries = ticked.map(([ticketId, time]) => ({ ticketId, boardedAt: `${day}T${time}:00Z` }));
      const r = await api<{ boarded: number; refused: number; results: (BoardingResult & { ticketId: string })[] }>(
        `/api/staff/journeys/${journeyId}/manifest-exports/${sheet.id}/entries`,
        { method: "POST", body: { entries } },
      );
      const problems = r.results.filter((x) => x.outcome === "refused").map((x) => `${x.ticket?.seatNumber ?? "?"}: ${x.message}`);
      setOutcome(`${r.boarded} entered.${problems.length ? ` Not entered: ${problems.join(" ")}` : ""}`);
      setTimes({});
      onChange();
    } catch (e) {
      setMessage((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!window.confirm(`Every tick on sheet ${sheet.sheetNumber} has been entered?`)) return;
    try {
      await api(`/api/staff/journeys/${journeyId}/manifest-exports/${sheet.id}/close`, { method: "POST" });
      onChange();
    } catch (e) {
      setMessage((e as ApiError).message);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4 print:hidden">
      <h2 className="font-medium">Enter ticks from sheet no. {sheet.sheetNumber}</h2>
      <p className="text-sm text-muted">For each ticked passenger, type the time written on the sheet.</p>
      {waiting.length ? (
        <ul className="flex flex-col gap-2">
          {waiting.map((r) => (
            <li key={r.ticketId} className="flex items-center justify-between gap-3">
              <span className="text-sm"><strong>{r.seatNumber}</strong> {r.passengerName}</span>
              <input
                type="time"
                aria-label={`Boarding time for seat ${r.seatNumber}`}
                className="h-10 rounded-lg border border-border bg-background px-2"
                value={times[r.ticketId] ?? ""}
                onChange={(e) => setTimes((t) => ({ ...t, [r.ticketId]: e.target.value }))}
              />
            </li>
          ))}
        </ul>
      ) : (
        <Notice>Everyone on this journey is already boarded.</Notice>
      )}
      <Button type="button" onClick={enter} disabled={busy || !ticked.length}>
        {busy ? "Entering…" : `Enter ${ticked.length} boarding${ticked.length === 1 ? "" : "s"}`}
      </Button>
      {outcome ? <Notice>{outcome}</Notice> : null}
      {message ? <Notice tone="error">{message}</Notice> : null}
      <button type="button" className="h-11 rounded-lg border border-border font-medium" onClick={close}>
        Sheet fully entered
      </button>
    </div>
  );
}
