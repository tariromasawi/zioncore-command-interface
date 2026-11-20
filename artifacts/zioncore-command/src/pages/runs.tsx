import { Link } from "wouter";
import { useFeed, fmt, dur } from "@/hooks/use-feed";
import { Empty, Skeleton, Failure, PageHead } from "@/components/bits";

export default function RunsPage() {
  const q = useFeed();
  return (
    <div>
      <PageHead kicker="Historical evidence" title="Run ledger">Every recorded run, newest first. Open a run to see engine results, warnings and research it produced.</PageHead>
      {q.isLoading ? <Skeleton rows={8} /> : q.isError || !q.data ? <Failure onRetry={() => q.refetch()} /> : q.data.runs.length === 0 ? <Empty title="No runs recorded" body="The ledger is empty. No run has completed." /> : (
        <ol className="border border-border divide-y divide-border bg-card/70">{q.data.runs.map((r) => (
          <li key={r.id}><Link href={"/runs/" + r.id} data-testid={"link-run-" + r.id} className="grid grid-cols-[auto_1fr] sm:grid-cols-[170px_110px_1fr_auto] gap-x-3 gap-y-1 p-3 hover:bg-muted/50 text-xs items-center">
            <span className="font-mono text-primary">{fmt(r.startedAt)}</span>
            <span className="font-mono uppercase text-[10px] text-muted-foreground text-right sm:text-left">{r.kind}</span>
            <span className="col-span-2 sm:col-span-1">{r.outcome}</span>
            <span className="col-span-2 sm:col-span-1 font-mono text-[10px] text-muted-foreground">{dur(r.startedAt, r.finishedAt)} · {r.engines.length}e · {r.warnings.length}w · {r.research.length}r</span>
          </Link></li>))}</ol>
      )}
    </div>
  );
}
