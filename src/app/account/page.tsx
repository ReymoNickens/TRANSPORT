import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SignOutButton } from "@/components/SignOutButton";
import { Notice, Page } from "@/components/ui";
import { currentActor } from "@/lib/auth/actor";

export const metadata: Metadata = { title: "Your account" };

export default function AccountPage() {
  return (
    <Page title="Your account">
      <Suspense fallback={<Notice>Loading your account…</Notice>}>
        <AccountDetails />
      </Suspense>
    </Page>
  );
}

async function AccountDetails() {
  const actor = await currentActor();
  if (!actor) redirect("/sign-in");
  return (
    <div className="flex flex-col gap-4">
      <Notice>You&apos;re signed in. Your trips and tickets will appear here once booking opens.</Notice>
      <SignOutButton redirectTo="/" />
    </div>
  );
}
