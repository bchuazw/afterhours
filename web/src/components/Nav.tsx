"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { WalletButton } from "./WalletButton";
import { NetworkBadge } from "./NetworkBadge";

const TABS = [
  { href: "/", label: "Protect" },
  { href: "/earn/", label: "Earn" },
  { href: "/positions/", label: "Positions" },
  { href: "/how-it-works/", label: "How it works" },
];

function normalize(p: string) {
  return p.endsWith("/") ? p : `${p}/`;
}

export function Nav() {
  const pathname = normalize(usePathname() ?? "/");
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="shrink-0">
          <Logo />
        </Link>
        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {TABS.map((t) => {
            const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  active ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <NetworkBadge />
          <WalletButton />
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-t border-line px-2 py-1.5 md:hidden">
        {TABS.map((t) => {
          const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm ${active ? "bg-panel-2 text-fg" : "text-muted"}`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
