import { useMemo } from "react";
import { useParams } from "wouter";
import { useFeed, fmt } from "@/hooks/use-feed";
import { Panel, StatusChip, Empty, Skeleton, Failure, EvidenceList, PageHead, Back } from "@/components/bits";
import { Link } from "wouter";

export default function EnginePage() {
  const { id } = useParams<{ id: string }>();
  const q = useFeed();
  const history = useMemo(() => (q.data?.runs ?? []).flatMap((r) => r.engines.filter((e) => e.id === id).map((e) => ({ run: r, e }))), [q.data, id]);
  if (q.isLoading) return <Skeleton rows={6} />;
  if (q.isError || !q.data) return <Failure onRetry={() => q.refetch()} />;
  const engine = q.data.engines.find((e) => e.id === id);
  if (!engine) return <div><Back href="/" label="Dashboard" /><Empty title="Engine not in catalogue" body={"No engine with id " + id + " is reported by the feed."} /></div>;
  const others = q.data.engines.filter((e) => e.id !== id);
  return (
    <div>
      <Back href="/" label="Dashboard" />
      <PageHead kicker={engine.programme + " · engine " + engine.id} title={engine.name}>{engine.detail}</PageHead>
      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <Panel kicker="Current reading" title="Metric" action={<StatusChip status={engine.status} testid="status-engine" />}>
            <div className="font-mono text-xl sm:text-2xl text-primary break-words" data-testid="text-metric">{engine.metric}</div>
            {engine.status !== "measured" && <p className="text-xs text-muted-foreground mt-2">{engine.status === "example" ? "Example value. Not a measurement." : "Blocked. The engine could not produce a measurement."}</p>}
          </Panel>
          <Panel kicker="Evidence" title="Supporting records"><EvidenceList items={engine.evidence} /></Panel>
          <Panel kicker={history.length + " entries"} title="Run history">
            {history.length === 0 ? <Empty title="No run history for this engine" body="This engine has not appeared in any recorded run." /> : (
              <ol className="space-y-2">{history.map(({ run, e }) => (
                <li key={run.id} className="border border-border p-2.5 text-xs" data-testid={"row-history-" + run.id}>
                  <div className="flex flex-wrap items-center gap-2 justify-between">
                    <Link href={"/runs/" + run.id} className="font-mono text-primary hover:underline">{fmt(run.startedAt)}</Link>
                    <StatusChip status={e.status} />
                  </div>
                  <div className="font-mono mt-1">{e.metric}</div>
                  <p className="text-muted-foreground mt-1">{e.detail}</p>
                  {e.evidence.length > 0 && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{e.evidence.length} evidence record(s)</p>}
                </li>))}</ol>
            )}
          </Panel>
        </div>
        <Panel kicker="Catalogue" title="Other engines">
          <ul className="space-y-0.5">{others.map((o) => (
            <li key={o.id}><Link href={"/engines/" + o.id} data-testid={"link-engine-" + o.id} className="flex items-center justify-between gap-2 py-2 px-1 text-xs hover:bg-muted/60"><span className="truncate">{o.name}</span><StatusChip status={o.status} /></Link></li>))}</ul>
        </Panel>
      </div>
    </div>
  );
}
