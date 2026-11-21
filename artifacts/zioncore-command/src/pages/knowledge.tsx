import { Download, History, ShieldCheck, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useFeed, fmt } from "@/hooks/use-feed";
import { Empty, Failure, PageHead, Skeleton, StatusChip } from "@/components/bits";

const usd=(micros:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(micros/1_000_000);
type KnowledgeVersionRecord={versionId:string;knowledgeId:string;supersedes:string|null;entry:{sourceRunId:string};recordedAt:string};

export default function KnowledgePage() {
  const query=useFeed();
  const versionsQuery=useQuery({
    queryKey:["command-knowledge-versions"],
    queryFn:async()=>{
      const response=await fetch("/api/command/knowledge/versions",{headers:{accept:"application/json"}});
      if(!response.ok)throw new Error("Knowledge version history is unavailable");
      return (await response.json() as {versions:KnowledgeVersionRecord[]}).versions;
    },
    staleTime:60_000,
  });
  if(query.isLoading)return <Skeleton rows={8}/>;
  if(query.isError||!query.data)return <Failure onRetry={()=>query.refetch()}/>;
  const {learning,knowledge}=query.data;
  return <div>
    <PageHead kicker="Reusable methods · portable memory" title="Knowledge that survives the model">
      A capability is counted only when Command retrieves a versioned method, runs it on fresh inputs and verifies the result. Stored advice alone does not count as an operational capability.
    </PageHead>
    <div className="mb-4 flex flex-wrap gap-2">
      <a href="/api/command/knowledge/export" download className="inline-flex min-h-11 items-center gap-2 border border-primary/50 bg-primary/10 px-3 text-xs font-mono text-primary hover:bg-primary/20">
        <Download className="size-4"/>Export portable JSON
      </a>
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-4 text-primary"/>Checksum-verified methods only
      </span>
    </div>
    <div className="mb-5 grid grid-cols-2 md:grid-cols-3 gap-px border border-border bg-border">
      {[
        ["Internally completed missions",String(learning.internalMissionRuns)],
        ["External research runs",String(learning.externallyAssistedRuns)],
        ["Paid AI calls · recorded",String(learning.paidAiCalls)],
        ["Paid calls avoided",String(learning.paidAiCallsAvoided)],
        ["Versioned methods",String(knowledge.length)],
        ["Paid AI spend · month to date",usd(learning.monthlyPaidAiSpendMicros)],
        ["Uncertain spend held",usd(learning.monthlyPaidAiReservedMicros)],
        ["Paid AI requests · month to date",String(learning.monthlyPaidAiRequests)],
        ["Paid AI allowance",learning.monthlyPaidAiAllowanceMicros>0?usd(learning.monthlyPaidAiAllowanceMicros):"Disabled"],
        ["Billing month",learning.billingPeriod],
        ["Method version",learning.latestMethodVersion],
        ["Mission AI mode",learning.externalAiDisabledForMission?"Disabled":"Enabled"],
      ].map(([label,value])=><div key={label} className="bg-card p-3 min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-1 break-words font-display text-lg">{value}</div>
      </div>)}
    </div>
    <p className="mb-5 border border-border p-3 text-xs text-muted-foreground">
      AI amounts are measured in USD microdollars and include conservative reservations for requests with unknown outcomes. Cloud Run, Firestore, Scheduler and storage charges are not connected to this feed; check the project billing report for total spend.
      {" "}<a className="text-primary underline" href="https://console.cloud.google.com/billing?project=gen-lang-client-0266144152" target="_blank" rel="noreferrer">Open project billing</a>
    </p>
    <section className="space-y-3" aria-labelledby="knowledge-entries">
      <h2 id="knowledge-entries" className="font-display font-semibold">Versioned methods</h2>
      {!knowledge.length?<Empty title="No verified knowledge yet" body="The first successful research cycle records its reproducible method and evidence here."/>:
        knowledge.map(entry=>{
          const versions=versionsQuery.data?.filter(version=>version.knowledgeId===entry.id)??[];
          return <article key={entry.id} className="border border-card-border bg-card/80">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
            <h3 className="font-display font-semibold text-sm">{entry.title}</h3>
            <StatusChip status={entry.status}/>
          </header>
          <dl className="grid md:grid-cols-2 gap-px bg-border text-xs">
            {[
              ["Mission",entry.programme],
              ["Method",entry.method],
              ["Version",`${entry.methodId} · ${entry.version}`],
              ["Method SHA-256",entry.methodChecksum],
              ["Recorded",fmt(entry.createdAt)],
              ["Review by",fmt(entry.refreshAt)],
              ["Uncertainty",entry.uncertainty],
            ].map(([label,value])=><div key={label} className="bg-card p-3 min-w-0">
              <dt className="font-mono text-[10px] uppercase text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-words">{value}</dd>
            </div>)}
            <div className="bg-card p-3">
              <dt className="font-mono text-[10px] uppercase text-muted-foreground">Evidence</dt>
              {entry.evidence.map((item,index)=><p key={index} className="mt-1 break-words">
                {item.url?<a className="text-primary underline" href={item.url} target="_blank" rel="noreferrer">{item.label}</a>:item.label}
                <span className="block text-muted-foreground">{item.detail}</span>
              </p>)}
            </div>
          </dl>
          <div className="border-t border-border p-3">
            <h4 className="inline-flex items-center gap-2 font-mono text-[10px] uppercase text-muted-foreground">
              <History className="size-3.5"/>Verification ledger · {entry.evaluations.length} checks
            </h4>
            {!entry.evaluations.length?<p className="mt-2 text-xs text-muted-foreground">No subsequent replay is verified yet.</p>:
              <ul className="mt-2 flex flex-wrap gap-2">{entry.evaluations.slice(-12).map(item=><li key={item.runId}>
                <Link href={`/runs/${item.runId}`} className="inline-flex min-h-10 items-center gap-2 border border-border px-2 text-xs hover:border-primary">
                  <span>{item.outcome}</span><span className="font-mono text-muted-foreground">{fmt(item.recordedAt)}</span>
                </Link>
              </li>)}</ul>}
          </div>
          <div className="border-t border-border p-3">
            <h4 className="font-mono text-[10px] uppercase text-muted-foreground">
              Append-only record history · {versionsQuery.isLoading?"loading":versionsQuery.isError?"unavailable":`${versions.length} versions`}
            </h4>
            {versionsQuery.isError?<p className="mt-2 text-xs text-muted-foreground">Stored history could not be loaded; the current verified method remains available.</p>:
              versions.length>0?<ol className="mt-2 space-y-2 text-xs">
                {versions.map(version=><li id={`knowledge-version-${version.versionId}`} key={version.versionId} className="border border-border p-2">
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <span className="font-mono">record {version.versionId}</span>
                    <span>{fmt(version.recordedAt)}</span>
                    {version.supersedes?<a className="text-primary underline" href={`#knowledge-version-${version.supersedes}`}>supersedes {version.supersedes}</a>:<span className="text-muted-foreground">first retained version</span>}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    Source run: <Link className="text-primary underline" href={`/runs/${version.entry.sourceRunId}`}>{version.entry.sourceRunId}</Link>
                  </div>
                </li>)}
              </ol>:<p className="mt-2 text-xs text-muted-foreground">No version records have been written yet.</p>}
          </div>
        </article>})}
    </section>
    <p className="mt-5 border border-border p-3 text-xs text-muted-foreground">
      <Sparkles className="mr-1 inline size-3.5 text-primary"/>This mission uses deterministic code and synthetic fixtures. No model or paid AI call was needed to run or replay it. Suggestions, model output and stored research cannot launch jobs or change deployments.
    </p>
  </div>;
}
