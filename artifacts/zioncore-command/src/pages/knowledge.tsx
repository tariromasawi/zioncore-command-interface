import { Download, History, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { useFeed, fmt } from "@/hooks/use-feed";
import { Empty, EvidenceLink, Failure, PageHead, Skeleton, StatusChip } from "@/components/bits";
import { apiBase } from "@/lib/public-api";

const usd=(micros:number | undefined)=>typeof micros === "number" ? new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(micros/1_000_000) : "Not reported";
const reported = (value: string | number | undefined) => value == null ? "Not reported" : String(value);

export default function KnowledgePage() {
  const query=useFeed();
  if(query.isLoading)return <Skeleton rows={8}/>;
  if(query.isError||!query.data)return <Failure onRetry={()=>query.refetch()}/>;
  const {learning,knowledge}=query.data;
  return <div>
    <PageHead kicker="Reusable methods · portable memory" title="Knowledge that survives the model">
      A capability is counted only when Command retrieves a versioned method, runs it on fresh inputs and verifies the result. Stored advice alone does not count as an operational capability.
    </PageHead>
    <div className="mb-4 flex flex-wrap gap-2">
      <a href={`${apiBase}/api/command/knowledge/export`} className="inline-flex min-h-11 items-center gap-2 border border-primary/50 bg-primary/10 px-3 text-xs font-mono text-primary hover:bg-primary/20">
        <Download className="size-4"/>Export portable JSON
      </a>
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-4 text-primary"/>Checksum-verified methods only
      </span>
    </div>
    <div className="mb-5 grid grid-cols-2 md:grid-cols-3 gap-px border border-border bg-border">
      {[
        ["Internally completed missions",reported(learning.internalMissionRuns)],
        ["External research runs",reported(learning.externallyAssistedRuns)],
        ["Paid AI calls · recorded",reported(learning.paidAiCalls)],
        ["Paid calls avoided",reported(learning.paidAiCallsAvoided)],
        ["Versioned methods",query.data.knowledgeAvailable ? String(knowledge.length) : "Not reported"],
        ["Paid AI spend · month to date",usd(learning.monthlyPaidAiSpendMicros)],
        ["Uncertain spend held",usd(learning.monthlyPaidAiReservedMicros)],
        ["Paid AI requests · month to date",reported(learning.monthlyPaidAiRequests)],
        ["Paid AI allowance",learning.monthlyPaidAiAllowanceMicros == null ? "Not reported" : learning.monthlyPaidAiAllowanceMicros>0?usd(learning.monthlyPaidAiAllowanceMicros):"Disabled"],
        ["Billing month",reported(learning.billingPeriod)],
        ["Method version",reported(learning.latestMethodVersion)],
        ["Mission AI mode",learning.externalAiDisabledForMission == null ? "Not reported" : learning.externalAiDisabledForMission?"Disabled":"Enabled"],
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
      {!knowledge.length?<Empty title={query.data.knowledgeAvailable ? "No knowledge entries reported" : "Knowledge unavailable"} body={query.data.knowledgeAvailable ? "The feed reports no versioned methods." : "This feed does not report knowledge entries; unavailable does not mean zero."}/>:
        knowledge.map(entry=><article key={entry.id} className="border border-card-border bg-card/80">
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
                <EvidenceLink url={item.url} fallback={item.label} className="text-primary underline">{item.label}</EvidenceLink>
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
        </article>)}
    </section>
    <p className="mt-5 border border-border p-3 text-xs text-muted-foreground">
      <Sparkles className="mr-1 inline size-3.5 text-primary"/>Suggestions, model output and stored research cannot launch jobs or change deployments. Usage is shown only when reported by the feed.
    </p>
  </div>;
}
