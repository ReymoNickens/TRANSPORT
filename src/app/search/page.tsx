import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchResults } from "@/components/passenger/SearchResults";
import { Notice, Page } from "@/components/ui";

export const metadata: Metadata = { title: "Buses" };

export default function SearchPage() {
  return (
    <Page title="Choose a bus">
      <Suspense fallback={<Notice>Finding buses…</Notice>}>
        <SearchResults />
      </Suspense>
    </Page>
  );
}
