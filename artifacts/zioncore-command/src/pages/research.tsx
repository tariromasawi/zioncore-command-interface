import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useFeed, fmt } from "@/hooks/use-feed";
import { Empty, Skeleton, Failure, EvidenceList, PageHead } from "@/components/bits";

export default function ResearchPage() {
  const q = useFeed();
  const [prog, setProg] = useState("all");
  const items = useMemo(() => (q.data?.runs ?? []).flatMap((r) => r.research.map((x) => ({ ...x, runId: r.id, at: r.startedAt }))), [q.data]);
  const progs = useMemo(() => ["all", ...Array.from(new Set(items.map((i) => i.programme)))], [items]);
  const shown = prog === "all" ? items : items.filter((i) => i.programme === prog);
  return (
    <div>
      <PageHead kicker="Reproducible research" title="Hypotheses, methods, failures">Every entry records what was tried, what failed, and what comes next. Failures are kept on purpose.</PageHead>
      {q.isLoading ? <Skeleton rows={5} /> : q.isError ? <Failure onRetry={() => q.refetch()} /> : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-4" role="group" aria-label="Filter by programme">
            {progs.map((p) => <button key={p} onClick={() => setProg(p)} aria-pressed={prog === p} data-testid={"button-filter-" + p} className={"px-3 py-2 min-h-10 border font-mono text-[11px] uppercase " + (prog === p ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground")}>{p}</button>)}
          </div>
          {shown.length === 0 ? <Empty title="No research recorded" body="No run has published a research entry yet." /> : (
            <div className="space-y-4">{shown.map((r, i) => (
              <article key={i} className="border border-card-border bg-card/80 rise" data-testid={"card-research-" + i}>
                <header className="px-3 py-2 border-b border-border flex flex-wrap justify-between gap-2">
                  <h2 className="font-display font-semibold text-sm">{r.title}</h2>
                  <span className="font-mono text-[10px] text-muted-foreground uppercase">{r.programme} · <Link href={"/runs/" + r.runId} className="text-primary hover:underline">{fmt(r.at)}</Link></span>
                </header>
                <dl className="grid md:grid-cols-2 gap-px bg-border text-xs">
                  {[["Hypothesis", r.hypothesis], ["Method", r.method], ["Result", r.result], ["Failed approach", r.failedApproach], ["Next", r.next]].map(([k, v]) => (
                    <div key={k} className={"bg-card p-3 " + (k === "Failed approach" ? "border-l-2 border-destructive/60" : "")}><dt className="font-mono text-[10px] uppercase text-muted-foreground">{k}</dt><dd className="mt-1">{v}</dd></div>
                  ))}
                  <div className="bg-card p-3"><dt className="font-mono text-[10px] uppercase text-muted-foreground mb-1">Evidence</dt><dd><EvidenceList items={r.evidence} /></dd></div>
                </dl>
              </article>))}</div>
          )}
        </>
      )}
    </div>
  );
}
