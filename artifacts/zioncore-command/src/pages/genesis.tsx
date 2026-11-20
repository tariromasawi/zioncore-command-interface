import { useFeed } from "@/hooks/use-feed";
import { Skeleton, Failure, PageHead, StatusChip } from "@/components/bits";

export default function GenesisPage() {
  const q = useFeed();
  return (
    <div className="max-w-2xl">
      <PageHead kicker="Genesis · metadata only" title="Origin record">The genesis record is published as metadata. Its contents are not exposed here.</PageHead>
      {q.isLoading ? <Skeleton rows={4} /> : q.isError || !q.data ? <Failure onRetry={() => q.refetch()} /> : (
        <dl className="border border-border divide-y divide-border bg-card/80 text-sm" data-testid="list-genesis">
          <div className="grid grid-cols-[110px_1fr] p-3"><dt className="font-mono text-[11px] text-muted-foreground uppercase">status</dt><dd><StatusChip status={q.data.genesis.status} /></dd></div>
          <div className="grid grid-cols-[110px_1fr] p-3"><dt className="font-mono text-[11px] text-muted-foreground uppercase">version</dt><dd className="font-mono">{q.data.genesis.version}</dd></div>
          <div className="grid grid-cols-[110px_1fr] p-3"><dt className="font-mono text-[11px] text-muted-foreground uppercase">checksum</dt><dd className="font-mono text-xs break-all text-primary">{q.data.genesis.checksum}</dd></div>
          <div className="grid grid-cols-[110px_1fr] p-3"><dt className="font-mono text-[11px] text-muted-foreground uppercase">note</dt><dd>{q.data.genesis.note}</dd></div>
        </dl>
      )}
    </div>
  );
}
