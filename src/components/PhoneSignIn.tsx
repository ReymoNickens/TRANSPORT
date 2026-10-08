"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { normaliseGhanaPhone } from "@/lib/phone";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { Button, Field, Notice } from "./ui";

/**
 * Passenger sign-in: phone number, then a six-digit text code (spec D8, 19.1).
 * The answer is the same whether or not an account exists.
 */
export function PhoneSignIn({ next = "/account" }: { next?: string }) {
  const router = useRouter();
  const [phoneInput, setPhoneInput] = useState("");
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const normalised = normaliseGhanaPhone(phoneInput);
    if (!normalised) {
      setError("Enter a Ghana mobile number, for example 024 123 4567.");
      return;
    }
    setBusy(true);
    const { error } = await supabaseBrowser().auth.signInWithOtp({ phone: normalised });
    setBusy(false);
    if (error) {
      setError(error.status === 429 ? "Too many codes requested. Please wait a few minutes." : "We couldn't send a code. Please try again.");
      return;
    }
    setPhone(normalised);
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (!phone) return;
    setError(null);
    setBusy(true);
    const { error } = await supabaseBrowser().auth.verifyOtp({ phone, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) {
      setError("That code is not right or has expired. Check the message or request a new code.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  if (!phone) {
    return (
      <form onSubmit={sendCode} className="flex flex-col gap-4">
        <Field
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="024 123 4567"
          value={phoneInput}
          onChange={(e) => setPhoneInput(e.target.value)}
          required
        />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Sending code…" : "Send me a code"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={verifyCode} className="flex flex-col gap-4">
      <Notice>We sent a six-digit code by text message. It expires in 10 minutes.</Notice>
      <Field
        label="Code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit" disabled={busy}>
        {busy ? "Checking…" : "Sign in"}
      </Button>
      <button type="button" className="text-sm text-muted underline" onClick={() => { setPhone(null); setCode(""); }}>
        Use a different number
      </button>
    </form>
  );
}
