import { Link } from "wouter";
import { useFeed } from "@/hooks/use-feed";
import { Empty, Failure, PageHead, Skeleton, StatusChip } from "@/components/bits";

export default function EnginesPage() {
  const q = useFeed();
  return <div>
    <PageHead kicker="Engine catalogue" title="Operational engines">Open an engine to see its current reading, evidence and run history.</PageHead>
    {q.isLoading ? <Skeleton rows={6} /> : q.isError || !q.data ? <Failure onRetry={() => q.refetch()} /> : !q.data.engines.length
      ? <Empty title="No engines reported" body="The feed returned an empty catalogue." />
      : <ul className="grid gap-3 sm:grid-cols-2">{q.data.engines.map((engine) =>
        <li key={engine.id} className="border border-border bg-card/80">
          <Link href={"/engines/" + engine.id} className="block h-full p-3 hover:bg-muted/60">
            <div className="flex items-center justify-between gap-2"><h2 className="font-display font-semibold">{engine.name}</h2><StatusChip status={engine.status} /></div>
            <p className="mt-1 font-mono text-[10px] uppercase text-muted-foreground">{engine.programme}</p>
            <p className="mt-2 font-mono text-sm text-primary break-words">{engine.metric}</p>
            <p className="mt-2 text-xs text-muted-foreground">{engine.detail}</p>
          </Link>
        </li>)}</ul>}
  </div>;
}
