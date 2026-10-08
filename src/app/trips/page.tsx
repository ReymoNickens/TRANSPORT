import type { Metadata } from "next";
import { TripsList } from "@/components/passenger/TripsList";
import { Page } from "@/components/ui";

export const metadata: Metadata = { title: "My trips" };

export default function TripsPage() {
  return (
    <Page title="My trips">
      <TripsList />
    </Page>
  );
}
