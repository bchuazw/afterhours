"use client";

import { useState, type ReactNode } from "react";
import { explorerAddress, explorerTx } from "@/lib/chain";
import { shortAddr, shortHash } from "@/lib/format";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function Skeleton({ className = "h-4 w-24" }: { className?: string }) {
  return <span className={`skeleton inline-block align-middle ${className}`} aria-hidden />;
}

export function Stat({
  label,
  value,
  sub,
  loading,
  className = "",
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  loading?: boolean;
  className?: string;
  tone?: "pos" | "neg" | "warn" | "accent";
}) {
  const toneCls = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent" : "";
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="label">{label}</div>
      <div className={`num mt-1 text-lg leading-tight ${toneCls}`}>{loading ? <Skeleton className="h-5 w-20" /> : value}</div>
      {sub !== undefined && <div className="mt-0.5 text-xs text-muted">{loading ? <Skeleton className="h-3 w-16" /> : sub}</div>}
    </div>
  );
}

export function Pill({
  children,
  tone = "default",
  dot = true,
  className = "",
}: {
  children: ReactNode;
  tone?: "default" | "live" | "closed" | "neg" | "accent";
  dot?: boolean;
  className?: string;
}) {
  const cls = tone === "live" ? "pill-live" : tone === "closed" ? "pill-closed" : tone === "neg" ? "pill-neg" : tone === "accent" ? "pill-accent" : "";
  return (
    <span className={`pill ${cls} ${className}`}>
      {dot && <span className="pill-dot" />}
      {children}
    </span>
  );
}

export function AddressLink({ address, chars = 4, className = "" }: { address: string; chars?: number; className?: string }) {
  return (
    <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className={`num link text-xs ${className}`} title={address}>
      {shortAddr(address, chars)}
    </a>
  );
}

export function TxLink({ hash, className = "" }: { hash: string; className?: string }) {
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className={`num link text-xs ${className}`} title={hash}>
      {shortHash(hash)}
    </a>
  );
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className={`btn btn-sm ${className}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {ok ? "Copied" : label}
    </button>
  );
}

export function ErrorNote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-neg/30 bg-neg/5 px-3 py-2 text-xs leading-relaxed text-neg ${className}`}>
      {children}
    </div>
  );
}

export function InfoNote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs leading-relaxed text-muted ${className}`}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-tight text-fg">{children}</h2>
      {right}
    </div>
  );
}

export function Row({ k, v, muted }: { k: ReactNode; v: ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{k}</span>
      <span className={`num text-right ${muted ? "text-muted" : "text-fg"}`}>{v}</span>
    </div>
  );
}
