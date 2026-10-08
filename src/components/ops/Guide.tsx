"use client";

import type { ReactNode } from "react";

/** The step indicator at the top of a guided workflow (8.3). */
export function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="flex gap-2 text-sm" aria-label="Steps">
      {steps.map((label, i) => (
        <li key={label} className={`flex-1 border-t-4 pt-1 ${i <= current ? "border-accent font-medium" : "border-border text-muted"}`} aria-current={i === current ? "step" : undefined}>
          {label}
        </li>
      ))}
    </ol>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="h-12 rounded-lg border border-border px-4 font-medium">Back</button>;
}

/** A selectable card used for single choices (route, bus, pattern). */
export function ChoiceCard({ name, checked, onChange, children }: { name: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${checked ? "border-accent" : "border-border"}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1" />
      <span>{children}</span>
    </label>
  );
}
