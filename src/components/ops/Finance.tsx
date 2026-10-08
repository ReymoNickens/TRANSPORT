"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis, formatDay, formatTime, todayInAccra } from "@/lib/format";
import { Button, Field, Notice } from "../ui";
import { SmallButton } from "./Dashboard";
import type { OpsCan } from "./OpsShell";

type Report = {
  from: string;
  to: string;
  paymentsPesewas: number;
  refundsApprovedPesewas: number;
  bookedRevenuePesewas: number;
  earnedRevenuePesewas: number;
  providerFeesPesewas: number;
  netOfProviderFeesPesewas: number;
  refundLiabilityPesewas: number;
  ledgerBookedRevenuePesewas: number;
  byRoute: { routeName: string; paymentsPesewas: number; refundsPesewas: number; seats: number }[];
  definitions: Record<string, string>;
};
type DaySummary = { day: string; state: "NOT_CHECKED" | "OPEN" | "SIGNED_OFF"; checkedAt: string | null; openDifferences: number; paidPesewas: number };
type Item = {
  id: string;
  kind: string;
  severity: "critical" | "high";
  description: string;
  bookingReference: string | null;
  providerReference: string | null;
  resolution: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
};
type Day = {
  day: string;
  state: "NOT_CHECKED" | "OPEN" | "SIGNED_OFF";
  checkedAt: string | null;
  signedOffAt: string | null;
  signedOffByName: string | null;
  notes: string | null;
  summary: { providerTransactions?: number; payments?: number; paidPesewas?: number; settlements?: number; settledPesewas?: number };
  items: Item[];
};

const dayWords = { NOT_CHECKED: "Not checked yet", OPEN: "Checked, not signed off", SIGNED_OFF: "Signed off" } as const;
const plusDays = (day: string, n: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Finance (18.1 to 18.4): the revenue report and the daily check against Paystack. */
export function Finance({ can }: { can: OpsCan }) {
  const [tab, setTab] = useState<"report" | "reconcile">(can.reconcile ? "reconcile" : "report");
  return (
    <div className="flex flex-col gap-5">
      <nav className="grid grid-flow-col gap-1 rounded-lg border border-border p-1" aria-label="Finance">
        {(["reconcile", "report"] as const).filter((t) => t === "report" || can.reconcile).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}
            className={`h-10 rounded-md text-sm font-medium ${tab === t ? "bg-accent text-accent-foreground" : ""}`}>
            {t === "report" ? "Revenue report" : "Check against Paystack"}
          </button>
        ))}
      </nav>
      {tab === "report" ? <RevenueReport can={can} /> : <Reconciliation />}
    </div>
  );
}

function RevenueReport({ can }: { can: OpsCan }) {
  const today = todayInAccra();
  const [from, setFrom] = useState(plusDays(today, -6));
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    api<Report>(`/api/ops/finance/report?from=${from}&to=${to}`)
      .then((r) => live && (setReport(r), setMessage(null)))
      .catch((e: ApiError) => live && setMessage(e.message));
    return () => {
      live = false;
    };
  }, [from, to]);

  async function exportCsv() {
    const reason = window.prompt("Why is this report being exported? This is recorded.");
    if (!reason) return;
    try {
      const file = await api<{ filename: string; csv: string }>("/api/ops/finance/export", { method: "POST", body: { from, to, reason } });
      const url = URL.createObjectURL(new Blob([file.csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.code === "reconfirmation_required" ? "Enter your authenticator code again (sign out and in), then retry." : err.message);
    }
  }

  const figures: [string, number][] = report
    ? [
        ["Booked revenue", report.bookedRevenuePesewas],
        ["Earned revenue", report.earnedRevenuePesewas],
        ["Net of provider fees", report.netOfProviderFeesPesewas],
        ["Refund liability", report.refundLiabilityPesewas],
      ]
    : [];

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <Field label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Field label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      {message ? <Notice tone="error">{message}</Notice> : null}
      {report ? (
        <>
          <dl className="grid grid-cols-2 gap-3">
            {figures.map(([name, value]) => (
              <div key={name} className="rounded-xl border border-border p-3">
                <dt className="text-sm text-muted">{name}</dt>
                <dd className="text-xl font-semibold tabular-nums">{formatCedis(value)}</dd>
                <dd className="mt-1 text-xs text-muted">{report.definitions[name]}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted">
            Payments received {formatCedis(report.paymentsPesewas)} · refunds approved {formatCedis(report.refundsApprovedPesewas)} · Paystack fees {formatCedis(report.providerFeesPesewas)}
          </p>
          {report.ledgerBookedRevenuePesewas === report.bookedRevenuePesewas ? (
            <Notice>✓ These figures agree with the ledger to the pesewa.</Notice>
          ) : (
            <Notice tone="error">The ledger shows {formatCedis(report.ledgerBookedRevenuePesewas)} booked revenue. Tell support: the books and the payments disagree.</Notice>
          )}
          {report.byRoute.length ? (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted"><th className="py-1">Route</th><th>Paid</th><th>Refunds</th><th>Seats</th></tr></thead>
              <tbody>
                {report.byRoute.map((r) => (
                  <tr key={r.routeName} className="border-t border-border">
                    <td className="py-1">{r.routeName}</td><td className="tabular-nums">{formatCedis(r.paymentsPesewas)}</td>
                    <td className="tabular-nums">{formatCedis(r.refundsPesewas)}</td><td className="tabular-nums">{r.seats}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Notice>No payments in this period.</Notice>
          )}
          {can.financeExport ? <SmallButton onClick={exportCsv}>Download as a spreadsheet</SmallButton> : null}
        </>
      ) : !message ? <Notice>Working out the figures…</Notice> : null}
    </section>
  );
}

function Reconciliation() {
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<DaySummary[]>("/api/ops/finance/days").then(setDays).catch((e: ApiError) => setMessage(e.message));
  }, [refresh]);

  if (message) return <Notice tone="error">{message}</Notice>;
  if (!days) return <Notice>Loading days…</Notice>;
  if (selected) return <ReconciliationDay day={selected} onBack={() => { setSelected(null); reload(); }} />;

  return (
    <section className="flex flex-col gap-2">
      <Notice>Each day is checked against Paystack&apos;s records automatically the next morning. Open a day to see differences and sign it off.</Notice>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
        {days.map((d) => (
          <li key={d.day}>
            <button type="button" onClick={() => setSelected(d.day)} className="flex w-full items-center justify-between gap-3 p-3 text-left">
              <span>
                <span className="block font-medium">{formatDay(`${d.day}T12:00:00Z`)}</span>
                <span className="text-sm text-muted">{formatCedis(d.paidPesewas)} paid</span>
              </span>
              <span className={`text-sm ${d.openDifferences ? "font-medium text-danger" : d.state === "SIGNED_OFF" ? "" : "text-muted"}`}>
                {d.openDifferences ? `${d.openDifferences} difference${d.openDifferences === 1 ? "" : "s"}` : dayWords[d.state]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReconciliationDay({ day, onBack }: { day: string; onBack: () => void }) {
  const [data, setData] = useState<Day | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api<Day>(`/api/ops/finance/days/${day}`).then(setData).catch((e: ApiError) => setMessage(e.message));
  }, [day, refresh]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setRefresh((n) => n + 1);
    } catch (e) {
      setMessage((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return message ? <Notice tone="error">{message}</Notice> : <Notice>Loading the day…</Notice>;
  const open = data.items.filter((i) => !i.resolution);

  return (
    <section className="flex flex-col gap-4">
      <button type="button" className="self-start text-sm underline" onClick={onBack}>← All days</button>
      <header>
        <h2 className="text-xl font-semibold">{formatDay(`${data.day}T12:00:00Z`)}</h2>
        <p className="text-muted">
          {dayWords[data.state]}
          {data.checkedAt ? ` · last checked ${formatDay(data.checkedAt)} ${formatTime(data.checkedAt)}` : ""}
          {data.signedOffAt ? ` · signed off by ${data.signedOffByName ?? "Finance"} on ${formatDay(data.signedOffAt)}` : ""}
        </p>
      </header>
      {data.checkedAt ? (
        <p className="text-sm">
          Paystack: {data.summary.providerTransactions ?? 0} transactions. Here: {data.summary.payments ?? 0} payments, {formatCedis(data.summary.paidPesewas ?? 0)}.
          Settlements to the bank: {data.summary.settlements ?? 0}, {formatCedis(data.summary.settledPesewas ?? 0)}.
        </p>
      ) : null}

      {data.items.length ? (
        <ul className="flex flex-col gap-2">
          {data.items.map((i) => (
            <li key={i.id} className={`flex flex-col gap-1 rounded-xl border-2 p-3 ${i.resolution ? "border-border" : i.severity === "critical" ? "border-danger" : "border-accent"}`}>
              <p className={i.resolution ? "text-muted" : "font-medium"}>{i.description}</p>
              {i.bookingReference ? <Link className="self-start font-mono text-sm underline" href={`/ops/bookings/${i.bookingReference}`}>{i.bookingReference}</Link> : null}
              {i.resolution ? (
                <p className="text-sm text-muted">✓ {i.resolution}{i.resolvedByName ? ` (${i.resolvedByName})` : ""}</p>
              ) : data.state !== "SIGNED_OFF" ? (
                <SmallButton disabled={busy} onClick={() => {
                  const resolution = window.prompt("How was this resolved? This note is kept.");
                  if (resolution) void run(() => api(`/api/ops/finance/days/${day}/items/${i.id}/resolve`, { method: "POST", body: { resolution } }));
                }}>Mark as resolved</SmallButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : data.checkedAt ? <Notice>✓ No differences: everything matches Paystack.</Notice> : null}

      {data.state !== "SIGNED_OFF" ? (
        <div className="flex flex-col gap-2">
          <Button type="button" disabled={busy} onClick={() => run(() => api(`/api/ops/finance/days/${day}/check`, { method: "POST" }))}>
            {busy ? "Checking…" : data.checkedAt ? "Check against Paystack again" : "Check against Paystack"}
          </Button>
          {data.checkedAt ? (
            <>
              <Field label="Notes for the sign-off (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
              <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium disabled:opacity-60" disabled={busy || open.length > 0}
                onClick={() => window.confirm("Sign this day off? It cannot be changed afterwards; corrections go on a later day.") &&
                  run(() => api(`/api/ops/finance/days/${day}/sign-off`, { method: "POST", body: { notes } }))}>
                {open.length ? `Resolve ${open.length} difference${open.length === 1 ? "" : "s"} to sign off` : "Sign off this day"}
              </button>
            </>
          ) : null}
        </div>
      ) : data.notes ? <Notice>Notes: {data.notes}</Notice> : null}
      {message ? <Notice tone="error">{message}</Notice> : null}
    </section>
  );
}
