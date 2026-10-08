"use client";
import { createBrowserClient } from "@supabase/ssr";

/** Supabase client for the browser. It only signs people in; it never reads business data. */
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
