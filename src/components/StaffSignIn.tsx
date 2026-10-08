"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { Button, Field, Notice } from "./ui";

type Step =
  | { kind: "password" }
  | { kind: "enrol"; factorId: string; qrCode: string; secret: string }
  | { kind: "challenge"; factorId: string };

/**
 * Staff sign-in: email and password, then an authenticator-app code
 * (spec 19.2). A first sign-in sets up the authenticator app.
 */
export function StaffSignIn({ next }: { next: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setBusy(false);
      setError("Email or password is not right.");
      return;
    }

    const { data: factors } = await supabase.auth.mfa.listFactors();
    const verified = factors?.totp.find((factor) => factor.status === "verified");
    if (verified) {
      setStep({ kind: "challenge", factorId: verified.id });
    } else {
      const { data, error: enrolError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
      });
      if (enrolError || !data) {
        setError("We couldn't set up your authenticator app. Please try again.");
        setBusy(false);
        return;
      }
      setStep({ kind: "enrol", factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    }
    setBusy(false);
  }

  async function confirmCode(event: FormEvent) {
    event.preventDefault();
    if (step.kind === "password") return;
    setError(null);
    setBusy(true);
    const { error } = await supabaseBrowser().auth.mfa.challengeAndVerify({ factorId: step.factorId, code: code.trim() });
    setBusy(false);
    if (error) {
      setError("That code is not right. Codes change every 30 seconds; use the newest one.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  if (step.kind === "password") {
    return (
      <form onSubmit={signIn} className="flex flex-col gap-4">
        <Field label="Work email" name="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Continue"}</Button>
      </form>
    );
  }

  return (
    <form onSubmit={confirmCode} className="flex flex-col gap-4">
      {step.kind === "enrol" ? (
        <>
          <Notice>
            Staff accounts need an authenticator app (for example Google Authenticator). Scan this code with it, then enter the six digits it shows.
          </Notice>
          {/* eslint-disable-next-line @next/next/no-img-element -- Supabase returns the QR code as an SVG data URL */}
          <img src={step.qrCode} alt="QR code for your authenticator app" width={200} height={200} className="self-center rounded bg-white p-2" />
          <Notice>Can&apos;t scan? Enter this key instead: <code className="break-all">{step.secret}</code></Notice>
        </>
      ) : (
        <Notice>Enter the six-digit code from your authenticator app.</Notice>
      )}
      <Field label="Authenticator code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit" disabled={busy}>{busy ? "Checking…" : "Sign in"}</Button>
    </form>
  );
}
