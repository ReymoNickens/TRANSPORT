import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { BoardingConsole } from "@/components/staff/BoardingConsole";
import { Notice } from "@/components/ui";
import { currentActor } from "@/lib/auth/actor";
import { hasPermission } from "@/lib/auth/permissions";

export const metadata: Metadata = { title: "Boarding" };

/** Signed-in staff with a second factor only; the API checks every action again. */
async function Guarded() {
  const actor = await currentActor();
  if (!actor || actor.kind !== "staff" || actor.assuranceLevel !== "aal2") redirect("/staff/sign-in");
  return (
    <BoardingConsole
      can={{
        scan: hasPermission(actor, "ticket.scan"),
        manual: hasPermission(actor, "ticket.board.manual"),
        override: hasPermission(actor, "ticket.override.board"),
        status: hasPermission(actor, "journey.update.status"),
        print: hasPermission(actor, "ticket.board.manual") || hasPermission(actor, "passenger.export"),
      }}
    />
  );
}

export default function BoardingPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-6 print:max-w-none print:p-0">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <Guarded />
      </Suspense>
    </main>
  );
}
