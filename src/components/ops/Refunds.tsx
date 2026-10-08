"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { parseCedis } from "@/domain/money";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis, formatDay, formatTime } from "@/lib/format";
import { Button, Field, Notice, Select } from "../ui";
import { SmallButton } from "./Dashboard";
import type { OpsCan } from "./OpsShell";

export type RefundRow = {
  id: string;
  bookingReference: string;
  journeyLabel: string;
  purchaserName: string;
  phoneLastDigits: string;
  kind: string;
  amountPesewas: number;
  reason: string;
  state: string;
  route: string | null;
  attempts: number;
  lastError: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  manualRecordedByName: string | null;
  providerReference: string | null;
  requestedAt: string;
};

const kindWords: Record<string, string> = {
  passenger_cancellation: "Passenger cancelled",
  operator_cancellation: "We cancelled the journey",
  late_payment: "Paid after the seat was sold",
  duplicate_payment: "Paid twice",
  goodwill: "Goodwill",
  correction: "Correction",
};
const stateWords: Record<string, string> = {
  REQUESTED: "Waiting for approval",
  APPROVED: "Approved, being sent",
  PROCESSING: "Being paid",
  COMPLETED: "Paid",
  FAILED: "Could not be paid: needs Finance",
  REJECTED: "Turned down",
};
const routeWords: Record<string, string> = { paystack_refund: "Paystack refund", paystack_transfer: "Paystack transfer", manual: "Paid by hand" };

/**
 * One refund with the next action beside it (16.3, 16.4a). Approving, turning
 * down, retrying and paying by hand are high-risk: each asks for a reason and
 * a recent authenticator code.
 */
function RefundItem({ refund, can, onChange, showBooking }: { refund: RefundRow; can: OpsCan; onChange: () => void; showBooking: boolean }) {
  const [message, setMessage] = useState<string | null>(null);

  async function act(action: string, extra: Record<string, string> = {}, ask = "Why? This is recorded.") {
    const reason = window.prompt(ask);
    if (!reason) return;
    setMessage(null);
    try {
      await api(`/api/ops/refunds/${refund.id}/${action}`, { method: "POST", body: { reason, ...extra } });
      onChange();
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.code === "reconfirmation_required" ? "Enter your authenticator code again (sign out and in), then retry." : err.message);
    }
  }

  return (
    <li className={`flex flex-col gap-1 rounded-xl border-2 p-3 ${refund.state === "FAILED" ? "border-danger" : "border-border"}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold">{formatCedis(refund.amountPesewas)} · {kindWords[refund.kind] ?? refund.kind}</span>
        <span className={`text-sm font-medium ${refund.state === "FAILED" ? "text-danger" : ""}`}>{stateWords[refund.state] ?? refund.state}</span>
      </div>
      {showBooking ? (
        <p className="text-sm">
          <Link className="font-mono underline" href={`/ops/bookings/${refund.bookingReference}`}>{refund.bookingReference}</Link> · {refund.journeyLabel} · {refund.purchaserName}, phone ending {refund.phoneLastDigits}
        </p>
      ) : null}
      <p className="text-sm text-muted">
        {refund.reason} · asked {formatDay(refund.requestedAt)} {formatTime(refund.requestedAt)}
        {refund.requestedByName ? ` by ${refund.requestedByName}` : " by the system"}
        {refund.approvedByName ? ` · approved by ${refund.approvedByName}` : ""}
        {refund.route ? ` · ${routeWords[refund.route] ?? refund.route}` : ""}
        {refund.providerReference && refund.route === "manual" ? ` (reference ${refund.providerReference}, recorded by ${refund.manualRecordedByName ?? "someone"})` : ""}
      </p>
      {refund.lastError && refund.state !== "COMPLETED" ? <p className="text-sm text-danger">Last try: {refund.lastError}</p> : null}
      {can.refundApprove ? (
        <div className="flex flex-wrap gap-2">
          {refund.state === "REQUESTED" ? (
            <>
              <SmallButton onClick={() => act("approve", {}, "Why approve this refund? This is recorded.")}>Approve</SmallButton>
              <SmallButton onClick={() => act("reject", {}, "Why turn it down? This is recorded.")}>Turn down</SmallButton>
            </>
          ) : null}
          {refund.state === "FAILED" ? <SmallButton onClick={() => act("retry", {}, "Why try Paystack again?")}>Try Paystack again</SmallButton> : null}
          {refund.state === "FAILED" || refund.state === "APPROVED" ? (
            <SmallButton
              onClick={() => {
                const paymentReference = window.prompt("The reference of the payment you made (bank or mobile money):");
                if (paymentReference) void act("manual", { paymentReference }, "How was it paid? This is recorded.");
              }}
            >
              I paid it by hand
            </SmallButton>
          ) : null}
          {refund.state === "PROCESSING" && refund.route === "manual" ? (
            <SmallButton onClick={() => act("confirm", {}, "Confirm you have seen the payment evidence. Note what you checked:")}>Confirm the payment</SmallButton>
          ) : null}
        </div>
      ) : null}
      {message ? <Notice tone="error">{message}</Notice> : null}
    </li>
  );
}

/** Finance's refund queue (16.3, 16.4): failed first, then waiting for approval, then being paid. */
export function RefundQueue({ can }: { can: OpsCan }) {
  const [state, setState] = useState("open");
  const [rows, setRows] = useState<RefundRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    api<RefundRow[]>(`/api/ops/refunds?state=${state}`).then(setRows).catch((e: ApiError) => setError(e.message));
  }, [state, refresh]);

  if (error) return <Notice tone="error">{error}</Notice>;
  return (
    <div className="flex flex-col gap-4">
      <Select label="Show" value={state} onChange={(e) => setState(e.target.value)}>
        <option value="open">Still to finish</option>
        <option value="FAILED">Could not be paid</option>
        <option value="REQUESTED">Waiting for approval</option>
        <option value="PROCESSING">Being paid</option>
        <option value="COMPLETED">Paid</option>
        <option value="REJECTED">Turned down</option>
      </Select>
      {!rows ? <Notice>Loading refunds…</Notice> : rows.length ? (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => <RefundItem key={r.id} refund={r} can={can} onChange={reload} showBooking />)}
        </ul>
      ) : (
        <Notice>Nothing here.</Notice>
      )}
    </div>
  );
}

/** The refunds on one booking, and a goodwill refund request (16.3). */
export function BookingRefunds({ reference, can, refresh }: { reference: string; can: OpsCan; refresh: number }) {
  const [rows, setRows] = useState<RefundRow[] | null>(null);
  const [inner, setInner] = useState(0);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    api<RefundRow[]>(`/api/ops/bookings/${reference}/refunds`).then(setRows).catch(() => setRows([]));
  }, [reference, refresh, inner]);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Refunds</h2>
      {rows?.length ? (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => <RefundItem key={r.id} refund={r} can={can} onChange={() => setInner((n) => n + 1)} showBooking={false} />)}
        </ul>
      ) : (
        <Notice>No refunds on this booking.</Notice>
      )}
      {can.refundRequest ? (
        asking ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <Notice>A refund outside the policy. Someone else with refund approval must approve it before any money moves.</Notice>
            <Field label="Amount (GH₵)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Bus was three hours late" />
            <div className="flex gap-2">
              <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => setAsking(false)}>Cancel</button>
              <Button
                type="button"
                disabled={!parseCedis(amount) || reason.trim().length < 5}
                onClick={async () => {
                  setMessage(null);
                  try {
                    await api(`/api/ops/bookings/${reference}/refunds`, { method: "POST", body: { amountPesewas: parseCedis(amount), reason, kind: "goodwill" } });
                    setAsking(false);
                    setAmount("");
                    setReason("");
                    setMessage({ tone: "info", text: "Refund requested. It is waiting for approval on the Refunds page." });
                    setInner((n) => n + 1);
                  } catch (e) {
                    setMessage({ tone: "error", text: `${(e as ApiError).message} Nothing has been saved.` });
                  }
                }}
              >
                Ask for approval
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" className="self-start text-sm underline" onClick={() => setAsking(true)}>Refund outside the policy</button>
        )
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </section>
  );
}
