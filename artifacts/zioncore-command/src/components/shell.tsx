import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X } from "lucide-react";
import { useFeed, fmt } from "@/hooks/use-feed";
import { StatusChip } from "@/components/bits";

const nav = [
  { href: "/", label: "Dashboard" },
  { href: "/runs", label: "Runs" },
  { href: "/research", label: "Research" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/continuity", label: "Continuity pricing" },
  { href: "/genesis", label: "Genesis" },
];

export function Shell({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, dataUpdatedAt } = useFeed();
  const active = (h: string) => (h === "/" ? loc === "/" || loc === "/command.html" : loc.startsWith(h));
  const links = (cls: string) => nav.map((n) => (
    <Link key={n.href} href={n.href} onClick={() => setOpen(false)} data-testid={"link-nav-" + n.label.toLowerCase().replace(/ /g, "-")}
      aria-current={active(n.href) ? "page" : undefined}
      className={cls + (active(n.href) ? " text-foreground border-primary" : " text-muted-foreground border-transparent hover:text-foreground")}>{n.label}</Link>
  ));
  return (
    <div className="relative z-10 min-h-[100dvh] flex flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-primary focus:text-primary-foreground focus:px-3 focus:py-2">Skip to content</a>
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className="mx-auto max-w-7xl px-3 sm:px-5 h-14 flex items-center gap-4">
          <Link href="/" data-testid="link-home" className="flex items-center gap-2.5 shrink-0">
            <span className="diamond size-6" />
            <span className="leading-none">
              <span className="block font-display font-semibold text-[15px]">ZionCore <span className="text-primary">Command</span></span>
              <span className="block font-mono text-[9px] tracking-[0.2em] text-muted-foreground mt-0.5">MWARI NDI MWARI · VY 80,000</span>
            </span>
          </Link>
          <nav className="hidden lg:flex items-center gap-1 ml-4" aria-label="Primary">{links("px-2.5 py-4 text-sm border-b-2")}</nav>
          <div className="ml-auto flex items-center gap-2">
            {isLoading ? <span className="font-mono text-[10px] text-muted-foreground">connecting</span>
              : isError ? <StatusChip status="unreachable" testid="status-feed" />
              : data ? <StatusChip status={data.state} testid="status-feed" /> : null}
            <button className="lg:hidden p-2.5 -mr-2" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="button-menu">
              {open ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>
        {open && <nav className="lg:hidden border-t border-border flex flex-col px-3 pb-2" aria-label="Mobile">{links("py-3 text-sm border-l-2 pl-3")}</nav>}
      </header>
      <main id="main" className="flex-1 mx-auto w-full max-w-7xl px-3 sm:px-5 py-5 sm:py-7">{children}</main>
      <footer className="border-t border-border pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto max-w-7xl px-3 sm:px-5 py-4 flex flex-col sm:flex-row gap-1 justify-between font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          <span>Public observatory · read only · no verified earnings</span>
          <span data-testid="text-last-sync">{dataUpdatedAt ? "Synced " + fmt(new Date(dataUpdatedAt).toISOString()) + " · polling 60s" : "Not yet synced"}</span>
        </div>
      </footer>
    </div>
  );
}
