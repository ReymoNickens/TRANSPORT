import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentActor } from "@/lib/auth/actor";
import { hasPermission, type Actor } from "@/lib/auth/permissions";
import { SignOutButton } from "../SignOutButton";

export type OpsCan = {
  journeys: boolean;
  assignBus: boolean;
  bookings: boolean;
  exceptions: boolean;
  dismiss: boolean;
  status: boolean;
  routes: boolean;
  fleet: boolean;
  fares: boolean;
  schedules: boolean;
  cancelBooking: boolean;
  cancelJourney: boolean;
  refundRequest: boolean;
  refundApprove: boolean;
  refunds: boolean;
  finance: boolean;
  reconcile: boolean;
  financeExport: boolean;
};

export function opsCan(actor: Actor): OpsCan {
  return {
    journeys: hasPermission(actor, "journey.create"),
    assignBus: hasPermission(actor, "vehicle.assign"),
    bookings: hasPermission(actor, "booking.view.scope"),
    exceptions: hasPermission(actor, "exception.manage"),
    dismiss: hasPermission(actor, "exception.dismiss"),
    status: hasPermission(actor, "journey.update.status"),
    routes: hasPermission(actor, "route.manage"),
    fleet: hasPermission(actor, "fleet.manage"),
    fares: hasPermission(actor, "fare.manage"),
    schedules: hasPermission(actor, "schedule.manage"),
    cancelBooking: hasPermission(actor, "booking.cancel.scope"),
    cancelJourney: hasPermission(actor, "journey.cancel"),
    refundRequest: hasPermission(actor, "refund.request"),
    refundApprove: hasPermission(actor, "refund.approve"),
    refunds: ["refund.approve", "payment.view", "refund.request"].some((code) => hasPermission(actor, code)),
    finance: hasPermission(actor, "payment.view") || hasPermission(actor, "finance.reconcile"),
    reconcile: hasPermission(actor, "finance.reconcile"),
    financeExport: hasPermission(actor, "finance.export"),
  };
}

/**
 * Every operations page: signed-in staff with a second factor, and the
 * navigation. The API checks each action again; this only decides what to show.
 */
export async function OpsShell({ children }: { children: (can: OpsCan) => ReactNode }) {
  const actor = await currentActor();
  if (!actor || actor.kind !== "staff" || actor.assuranceLevel !== "aal2") redirect("/ops/sign-in");
  const can = opsCan(actor);
  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium" aria-label="Operations">
        <Link href="/ops" className="underline-offset-4 hover:underline">Dashboard</Link>
        {can.journeys ? <Link href="/ops/journeys/new" className="underline-offset-4 hover:underline">Create a departure</Link> : null}
        {can.bookings ? <Link href="/ops/bookings" className="underline-offset-4 hover:underline">Look up a booking</Link> : null}
        {can.routes ? <Link href="/ops/routes" className="underline-offset-4 hover:underline">Routes</Link> : null}
        {can.fleet ? <Link href="/ops/fleet" className="underline-offset-4 hover:underline">Buses</Link> : null}
        {can.schedules ? <Link href="/ops/schedules" className="underline-offset-4 hover:underline">Schedules</Link> : null}
        {can.refunds ? <Link href="/ops/refunds" className="underline-offset-4 hover:underline">Refunds</Link> : null}
        {can.finance ? <Link href="/ops/finance" className="underline-offset-4 hover:underline">Finance</Link> : null}
        <Link href="/staff" className="underline-offset-4 hover:underline">Boarding app</Link>
      </nav>
      {children(can)}
      <SignOutButton redirectTo="/ops/sign-in" />
    </div>
  );
}

/** The wider page frame for operations screens. */
export function OpsPage({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8">
      {title ? <h1 className="text-3xl font-semibold tracking-tight">{title}</h1> : null}
      {children}
    </main>
  );
}
