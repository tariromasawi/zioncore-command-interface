import { useParams, Link } from "wouter";
import { useFeed, fmt, dur } from "@/hooks/use-feed";
import { Panel, StatusChip, Empty, Skeleton, Failure, PageHead, Back, EvidenceList } from "@/components/bits";

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const q = useFeed();
  if (q.isLoading) return <Skeleton rows={6} />;
  if (q.isError || !q.data) return <Failure onRetry={() => q.refetch()} />;
  const run = q.data.runs.find((r) => r.id === id);
  if (!run) return <div><Back href="/runs" label="Runs" /><Empty title="Run not found" body={"No run " + id + " in the ledger."} /></div>;
  return (
    <div>
      <Back href="/runs" label="Runs" />
      <PageHead kicker={run.kind + " · " + run.id} title={run.outcome}>Started {fmt(run.startedAt)} · finished {fmt(run.finishedAt)} · {dur(run.startedAt, run.finishedAt)}</PageHead>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel kicker={run.engines.length + " results"} title="Engines" className="lg:col-span-2">
          {run.engines.length === 0 ? <Empty title="No engine results" body="This run recorded no engine output." /> : (
            <ul className="grid sm:grid-cols-2 gap-3">{run.engines.map((e) => (
              <li key={e.id} className="border border-border p-2.5 text-xs">
                <div className="flex justify-between gap-2"><Link href={"/engines/" + e.id} className="font-display font-medium text-sm hover:text-primary">{e.name}</Link><StatusChip status={e.status} /></div>
                <div className="font-mono text-primary mt-1">{e.metric}</div>
                <p className="text-muted-foreground mt-1 mb-2">{e.detail}</p>
                <EvidenceList items={e.evidence} />
              </li>))}</ul>
          )}
        </Panel>
        <Panel kicker="Signals" title="Warnings">
          {run.warnings.length === 0 ? <Empty title="No warnings" body="This run emitted none." /> : <ul className="space-y-2 text-xs">{run.warnings.map((w, i) => (
            <li key={i} className="border-l-2 border-[hsl(40_90%_62%)] pl-2"><div className="flex justify-between gap-2"><b className="font-medium">{w.signal}</b><StatusChip status={w.status} /></div><p className="text-muted-foreground">{w.outcome} · {w.horizon} · conf {w.confidence}</p><p>{w.action}</p></li>))}</ul>}
        </Panel>
        <Panel kicker="Guidance" title="Advice">
          {run.advice.length === 0 ? <Empty title="No advice" body="This run issued none." /> : <ul className="space-y-2 text-xs">{run.advice.map((a, i) => (
            <li key={i} className="border-l-2 border-accent pl-2"><b className="font-medium">{a.title}</b><p className="text-muted-foreground">{a.why}</p><p>{a.action}</p><p className="text-muted-foreground text-[11px]">uncertainty: {a.uncertainty}</p></li>))}</ul>}
        </Panel>
        <Panel kicker="Research" title={run.research.length + " entries"} className="lg:col-span-2">
          {run.research.length === 0 ? <Empty title="No research" body="This run produced no research entries." /> : <ul className="space-y-2 text-xs">{run.research.map((r, i) => (
            <li key={i} className="border border-border p-2.5"><b className="font-display">{r.title}</b><p className="mt-1"><span className="font-mono text-muted-foreground">result </span>{r.result}</p><p className="mt-1"><span className="font-mono text-destructive">failed </span>{r.failedApproach}</p></li>))}</ul>}
          <Link href="/research" className="inline-block mt-3 text-xs font-mono text-primary py-1">full research log &rarr;</Link>
        </Panel>
      </div>
    </div>
  );
}
