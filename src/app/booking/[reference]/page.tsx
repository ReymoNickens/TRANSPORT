import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingView } from "@/components/passenger/BookingView";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Your booking" };

export default function BookingPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-10">
      <Suspense fallback={<Notice>Loading your booking…</Notice>}>
        <BookingView />
      </Suspense>
    </main>
  );
}
