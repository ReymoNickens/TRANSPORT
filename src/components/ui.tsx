import type { ComponentProps, ReactNode } from "react";

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {children}
    </main>
  );
}

export function Field({ label, hint, ...input }: { label: string; hint?: string } & ComponentProps<"input">) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        {...input}
        className="h-12 rounded-lg border border-border bg-background px-3 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      {hint ? <span className="text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

export function Select({ label, hint, children, ...select }: { label: string; hint?: string } & ComponentProps<"select">) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <select
        {...select}
        className="h-12 rounded-lg border border-border bg-background px-3 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      >
        {children}
      </select>
      {hint ? <span className="text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

export function Button({ children, ...props }: ComponentProps<"button">) {
  return (
    <button
      {...props}
      className="h-12 rounded-lg bg-accent px-4 font-medium text-accent-foreground disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} className={tone === "error" ? "text-sm text-danger" : "text-sm text-muted"}>
      {children}
    </p>
  );
}
