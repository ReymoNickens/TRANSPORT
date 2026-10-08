"use client";

import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase-browser";

export function SignOutButton({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="h-12 rounded-lg border border-border px-4 font-medium"
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.replace(redirectTo);
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
