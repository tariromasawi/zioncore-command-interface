import type { ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, RotateCw, ExternalLink } from "lucide-react";
import type { Evidence } from "@workspace/api-client-react";

const tone: Record<string, string> = {
  live: "text-primary border-primary/40 bg-primary/10",
  measured: "text-primary border-primary/40 bg-primary/10",
  stale: "text-[hsl(40_90%_62%)] border-[hsl(40_90%_62%/.4)] bg-[hsl(40_90%_62%/.1)]",
  blocked: "text-destructive border-destructive/40 bg-destructive/10",
  example: "text-accent border-accent/40 bg-accent/10",
};
export function StatusChip({ status, testid }: { status: string; testid?: string }) {
  const t = tone[status.toLowerCase()] ?? "text-muted-foreground border-border bg-muted";
  return (
    <span data-testid={testid} className={"inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider rounded-sm " + t}>
      <span className={"size-1.5 rounded-full bg-current " + (status === "live" ? "pulse-dot" : "")} />
      {status}
    </span>
  );
}
export function Panel({ title, kicker, children, action, className = "" }: { title: string; kicker?: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section className={"relative border border-card-border bg-card/80 rise " + className}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          {kicker && <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{kicker}</div>}
          <h2 className="font-display text-sm font-semibold truncate">{title}</h2>
        </div>
        {action}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}
export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 border border-dashed border-border p-4" data-testid="state-empty">
      <div className="diamond size-3 mt-1 opacity-50 shrink-0" />
      <div><div className="font-display text-sm font-medium">{title}</div><p className="text-xs text-muted-foreground mt-1">{body}</p></div>
    </div>
  );
}
export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" data-testid="state-loading" aria-busy="true" aria-label="Loading feed">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 bg-muted/60 animate-pulse" style={{ animationDelay: i * 90 + "ms" }} />
      ))}
    </div>
  );
}
export function Failure({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <div role="alert" className="border border-destructive/40 bg-destructive/10 p-4 flex flex-col sm:flex-row sm:items-center gap-3" data-testid="state-failure">
      <AlertTriangle className="size-5 text-destructive shrink-0" />
      <div className="flex-1 text-sm"><div className="font-medium">Feed unreachable</div><div className="text-muted-foreground text-xs">{message ?? "The Command feed did not respond. Nothing shown here is current."}</div></div>
      <button data-testid="button-retry" onClick={onRetry} className="inline-flex items-center gap-2 border border-border px-3 py-2 text-xs font-mono uppercase hover:bg-muted min-h-11"><RotateCw className="size-3.5" />Retry</button>
    </div>
  );
}
export function EvidenceList({ items }: { items: Evidence[] }) {
  if (!items.length) return <p className="text-xs text-muted-foreground font-mono">No evidence attached.</p>;
  return (
    <ul className="divide-y divide-border border border-border">
      {items.map((e, i) => (
        <li key={i} className="p-2.5 text-xs" data-testid={"evidence-" + i}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-primary">{e.label}</span>
            {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground underline-offset-2 hover:underline">source <ExternalLink className="size-3" /></a>}
          </div>
          <p className="text-muted-foreground mt-1 break-words">{e.detail}</p>
        </li>
      ))}
    </ul>
  );
}
export function PageHead({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-5 rise">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">{kicker}</div>
      <h1 className="font-display text-2xl sm:text-3xl font-semibold mt-1 break-words">{title}</h1>
      <div className="brand-rule w-24 mt-3" />
      {children && <div className="mt-3 text-sm text-muted-foreground max-w-2xl">{children}</div>}
    </div>
  );
}
export function Back({ href, label }: { href: string; label: string }) {
  return <Link href={href} data-testid="link-back" className="inline-block font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground mb-3 py-2">&larr; {label}</Link>;
}
