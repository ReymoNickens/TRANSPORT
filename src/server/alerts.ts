import type { Tx } from "@/lib/db";

/** One operational alert (spec 22.3), in words a manager can act on. */
export type Alert = { signal: string; severity: "critical" | "high"; message: string };

/** What each alert means and what to do first. The full steps are in docs/runbooks.md. */
export const runbookFirstStep: Record<string, string> = {
  payment_callbacks: "Check Paystack's status page and the webhook address in the Paystack dashboard.",
  pending_payments: "Check Paystack's status page; pending payments are checked with Paystack every minute.",
  late_success: "Open the needs-attention list and confirm each re-seat or refund.",
  background_job: "Check the scheduler that calls /api/jobs/tick every minute.",
  notifications: "Check the Arkesel balance and status; failed messages are retried.",
  refunds: "Open Refunds and pay each failed one by hand, or try Paystack again.",
  reconciliation: "Open Finance, check yesterday against Paystack and sign it off.",
};

export async function currentAlerts(tx: Tx): Promise<Alert[]> {
  const [row] = await tx<{ alerts: Alert[] }[]>`select app.operational_alerts() as alerts`;
  return row.alerts;
}

/** Puts each alert on the needs-attention list, at most once an hour per signal. */
export async function raiseAlerts(tx: Tx, organisationId: string, alerts: Alert[]) {
  const hour = new Date().toISOString().slice(0, 13);
  for (const alert of alerts) {
    await tx`select app.raise_exception(${organisationId}, ${`alert_${alert.signal}`}, ${alert.severity},
      ${`alert:${alert.signal}:${hour}`}, ${alert.message}, ${runbookFirstStep[alert.signal] ?? "See the runbook."})`;
  }
}
