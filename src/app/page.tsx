import Link from "next/link";
import { Suspense } from "react";
import { SearchForm } from "@/components/passenger/SearchForm";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-4 py-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Book a real seat on a real bus.</h1>
        <p className="text-muted">Choose your seat, pay with mobile money or card, and board with the QR code on your phone.</p>
      </div>
      {/* Today's date is worked out on each visit, not when the page was built. */}
      <Suspense fallback={<div className="h-72 animate-pulse rounded-xl bg-border/40" aria-label="Loading search" />}>
        <SearchForm />
      </Suspense>
      <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <Link href="/trips" className="underline">My trips</Link>
        <Link href="/sign-in" className="underline">Sign in</Link>
        <Link href="/staff" className="text-muted underline">Staff</Link>
        <Link href="/ops" className="text-muted underline">Operations</Link>
      </nav>
    </main>
  );
}
