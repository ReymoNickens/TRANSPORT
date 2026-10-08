import type { Metadata } from "next";
import { Suspense } from "react";
import { TicketCard } from "@/components/passenger/TicketCard";
import { Notice } from "@/components/ui";
import { withOrganisation } from "@/lib/db";
import { env } from "@/lib/env";
import { currentOrganisation } from "@/lib/organisation";
import { headers } from "next/headers";
import { AppError } from "@/lib/api/errors";
import { guardedLookup } from "@/lib/api/rate-limit";
import { getTicketByLink } from "@/server/tickets";

export const metadata: Metadata = { title: "Your ticket", robots: { index: false } };

/** The ticket link from the text message (14.2). */
export default function TicketLinkPage({ params }: PageProps<"/t/[token]">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-10">
      <Suspense fallback={<Notice>Loading your ticket…</Notice>}>
        <Ticket params={params} />
      </Suspense>
    </main>
  );
}

async function Ticket({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const secret = env().TICKET_TOKEN_SECRET;
  const organisation = await currentOrganisation();
  const address = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  let ticket = null;
  try {
    ticket = secret
      ? await guardedLookup({ organisationId: organisation.id }, address, () =>
          withOrganisation({ organisationId: organisation.id }, (tx) => getTicketByLink(tx, token, secret)),
        )
      : null;
  } catch (error) {
    if (!(error instanceof AppError && error.code === "rate_limited")) throw error;
    return <Notice tone="error">Too many tries from this connection. Please wait a few minutes, or sign in and open My trips.</Notice>;
  }
  if (!ticket) {
    return <Notice tone="error">This ticket link is not valid any more. Use the latest text message, or sign in and open My trips.</Notice>;
  }
  return <TicketCard {...ticket} />;
}
