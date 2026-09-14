"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastKind = "pending" | "success" | "error" | "info";
export type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  link?: { href: string; label: string };
};

type Ctx = {
  push: (t: Omit<Toast, "id">) => number;
  update: (id: number, patch: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
};

const ToastCtx = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const schedule = useCallback((id: number, kind: ToastKind) => {
    const prev = timers.current.get(id);
    if (prev) clearTimeout(prev);
    if (kind === "pending") return;
    const ttl = kind === "error" ? 12_000 : 7_000;
    timers.current.set(
      id,
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), ttl),
    );
  }, []);

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    setToasts((ts) => ts.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = seq.current++;
      setToasts((ts) => [...ts, { ...t, id }].slice(-5));
      schedule(id, t.kind);
      return id;
    },
    [schedule],
  );

  const update = useCallback(
    (id: number, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      if (patch.kind) schedule(id, patch.kind);
    },
    [schedule],
  );

  const value = useMemo(() => ({ push, update, dismiss }), [push, update, dismiss]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto rounded-lg border bg-panel p-3 shadow-lg shadow-black/40 backdrop-blur ${
              t.kind === "error"
                ? "border-neg/40"
                : t.kind === "success"
                  ? "border-pos/40"
                  : t.kind === "pending"
                    ? "border-accent/40"
                    : "border-line"
            }`}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0">
                {t.kind === "pending" && <Spinner />}
                {t.kind === "success" && <Dot className="bg-pos" />}
                {t.kind === "error" && <Dot className="bg-neg" />}
                {t.kind === "info" && <Dot className="bg-accent" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{t.title}</div>
                {t.description && <div className="mt-0.5 text-xs leading-relaxed text-muted break-words">{t.description}</div>}
                {t.link && (
                  <a
                    href={t.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-xs text-accent hover:underline"
                  >
                    {t.link.label} ↗
                  </a>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="shrink-0 text-muted hover:text-fg"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={`block h-2.5 w-2.5 rounded-full ${className}`} />;
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent ${className}`}
    />
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}
