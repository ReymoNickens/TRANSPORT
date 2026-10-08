"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { Button, Notice } from "../ui";

export function FakeCheckout() {
  const router = useRouter();
  const { attemptId } = useParams<{ attemptId: string }>();
  const reference = useSearchParams().get("ref") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(outcome: "success" | "failed") {
    setBusy(true);
    try {
      await api(`/api/payments/fake/${attemptId}`, { method: "POST", body: { outcome } });
      router.push(`/booking/${reference}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Notice>This is a test checkout. No money moves. On the live service this is Paystack&apos;s payment page.</Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button onClick={() => decide("success")} disabled={busy}>Approve payment</Button>
      <button type="button" className="h-12 rounded-lg border border-border font-medium" onClick={() => decide("failed")} disabled={busy}>
        Decline payment
      </button>
    </div>
  );
}
