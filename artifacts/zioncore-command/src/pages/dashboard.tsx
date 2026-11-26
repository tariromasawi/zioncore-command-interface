import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSubmitCommandSuggestion, getGetCommandFeedQueryKey, SuggestionInputProgramme, type CommandFeed } from "@workspace/api-client-react";
import { useFeed, fmt, dur } from "@/hooks/use-feed";
import { Panel, StatusChip, Empty, Skeleton, Failure } from "@/components/bits";

const stateCopy: Record<string, string> = {
  live: "Feed is live. Results below come from recorded runs.",
  stale: "Feed is stale. The last expected run did not arrive; treat figures as historical.",
  blocked: "Feed is blocked. Engines could not run; nothing below is current.",
  example: "Preview only. Runs were executed locally; simulations are labeled and do not establish production results.",
};

export default function Dashboard() {
  const q = useFeed();
  if (q.isLoading) return <div className="grid gap-4 lg:grid-cols-3"><div className="lg:col-span-2"><Skeleton rows={6} /></div><Skeleton rows={6} /></div>;
  if (q.isError || !q.data) return <Failure onRetry={() => q.refetch()} />;
  return <Board feed={q.data} />;
}

function Board({ feed }: { feed: CommandFeed }) {
  const latest = feed.runs[0];
  const warnings = useMemo(() => feed.runs.flatMap((r) => r.warnings.map((w) => ({ ...w, run: r.id }))).slice(0, 8), [feed]);
  const advice = latest?.advice ?? [];
  const counts = useMemo(() => {
    const c = { measured: 0, example: 0, blocked: 0 };
    feed.engines.forEach((e) => { c[e.status]++; });
    return c;
  }, [feed]);
  return (
    <div className="space-y-4">
      <div className="rise grid gap-3 md:grid-cols-[1fr_auto] items-end">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">Evidence observatory · next version</div>
          <h1 className="font-display text-2xl sm:text-4xl font-semibold mt-1">What the engines actually measured.</h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-2xl" data-testid="text-state-copy">{stateCopy[feed.state]}</p>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 border border-border font-mono text-center text-[10px] uppercase">
          {[["State", <StatusChip key="s" status={feed.state} />], ["Cadence", feed.cadence], ["Next", fmt(feed.nextExpected)], ["Runs", String(feed.runs.length)]].map(([k, v], i) => (
            <div key={i} className="px-2 py-2 border-r even:border-r-0 sm:even:border-r last:border-r-0 nth-[-n+2]:border-b sm:nth-[-n+2]:border-b-0 border-border min-w-0"><dt className="text-muted-foreground">{k}</dt><dd className="mt-1 text-foreground normal-case text-[11px] break-words">{v}</dd></div>
          ))}
        </dl>
      </div>
      <div className="brand-rule" />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel kicker="Alerts & forecasts" title="Warnings" className="lg:col-span-2">
          {warnings.length === 0 ? <Empty title="No warnings recorded" body="No run has emitted a warning signal. Absence of a warning is not a forecast of safety." /> : (
            <>
            <ul className="space-y-3 md:hidden">{warnings.map((w,i)=>(
              <li key={i} className="p-3 border border-border space-y-2 text-sm">
                <div className="flex items-start justify-between gap-2"><strong>{w.signal}</strong><StatusChip status={w.status} /></div>
                <p className="text-xs text-muted-foreground">{w.source}</p>
                <p>{w.outcome}</p>
                <p className="text-xs text-muted-foreground">{w.horizon} · {w.confidence}</p>
                <p><span className="text-primary">Action:</span> {w.action}</p>
                <Link href={"/runs/"+w.run} className="inline-flex min-h-11 items-center text-primary underline">Run evidence</Link>
              </li>
            ))}</ul>
            <div className="hidden md:block overflow-x-auto -mx-3"><table className="w-full text-xs min-w-[560px]">
              <thead><tr className="text-left font-mono text-[10px] uppercase text-muted-foreground border-b border-border">{["Signal", "Outcome", "Horizon", "Conf.", "Action", "Status"].map((h) => <th key={h} className="px-3 py-1.5 font-normal">{h}</th>)}</tr></thead>
              <tbody>{warnings.map((w, i) => (
                <tr key={i} className="border-b border-border/60 align-top" data-testid={"row-warning-" + i}>
                  <td className="px-3 py-2"><div className="font-medium">{w.signal}</div><div className="text-muted-foreground font-mono text-[10px]">{w.source}</div></td>
                  <td className="px-3 py-2 text-muted-foreground">{w.outcome}</td>
                  <td className="px-3 py-2 font-mono">{w.horizon}</td>
                  <td className="px-3 py-2 font-mono">{w.confidence}</td>
                  <td className="px-3 py-2">{w.action}</td>
                  <td className="px-3 py-2"><StatusChip status={w.status} /><Link href={"/runs/"+w.run} className="mt-1 inline-block text-primary underline">Evidence</Link></td>
                </tr>))}</tbody>
            </table></div>
            </>
          )}
        </Panel>
        <Panel kicker="Latest mission" title={latest ? latest.kind : "No mission yet"} action={latest && <Link href={"/runs/" + latest.id} data-testid="link-latest-run" className="text-primary text-xs font-mono inline-flex items-center gap-1 p-1">open <ArrowUpRight className="size-3" /></Link>}>
          {!latest ? <Empty title="No runs on record" body="When the first run completes, its outcome appears here." /> : (
            <div className="space-y-2 text-xs">
              <p className="text-sm" data-testid="text-latest-outcome">{latest.outcome}</p>
              <dl className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                <div><dt className="text-muted-foreground">started</dt><dd>{fmt(latest.startedAt)}</dd></div>
                <div><dt className="text-muted-foreground">duration</dt><dd>{dur(latest.startedAt, latest.finishedAt)}</dd></div>
                <div><dt className="text-muted-foreground">engines</dt><dd>{latest.engines.length}</dd></div>
                <div><dt className="text-muted-foreground">research</dt><dd>{latest.research.length}</dd></div>
              </dl>
              <div className="border border-border p-2 font-mono text-[10px] text-muted-foreground">Earnings: no verified earnings recorded.</div>
            </div>
          )}
        </Panel>
      </div>

      <Panel kicker="Advice" title="What to do with this">
        {advice.length === 0 ? <Empty title="No advice in the latest run" body="Advice is only issued when evidence supports it." /> : (
          <div className="grid gap-3 md:grid-cols-2">{advice.map((a, i) => (
            <article key={i} className="border-l-2 border-accent pl-3" data-testid={"card-advice-" + i}>
              <h3 className="font-display font-medium text-sm">{a.title}</h3>
              <p className="text-xs text-muted-foreground mt-1">{a.why}</p>
              <p className="text-xs mt-1.5"><span className="font-mono text-primary">do </span>{a.action}</p>
              <p className="text-[11px] mt-1 text-muted-foreground"><span className="font-mono">uncertainty </span>{a.uncertainty}</p>
            </article>))}</div>
        )}
      </Panel>
      <Panel kicker="Knowledge retained" title="Proven methods that run without AI" action={<Link href="/knowledge" className="inline-flex min-h-10 items-center px-2 text-xs text-primary underline">Knowledge base</Link>}>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <div><dt className="font-mono text-[10px] uppercase text-muted-foreground">Internal replays</dt><dd className="mt-1">{feed.learning.internalMissionRuns} verified</dd></div>
          <div><dt className="font-mono text-[10px] uppercase text-muted-foreground">External support</dt><dd className="mt-1">{feed.learning.externallyAssistedRuns} runs</dd></div>
          <div><dt className="font-mono text-[10px] uppercase text-muted-foreground">Paid AI calls</dt><dd className="mt-1">{feed.learning.paidAiCalls} · mission calls disabled</dd></div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">Latest retained method: {feed.learning.latestMethodVersion}. <a href="/api/command/knowledge/export" download className="text-primary underline">Export evidence and method versions</a></p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel kicker={"Catalogue · " + feed.engines.length + " engines"} title="Operational engines" action={<span className="font-mono text-[10px] text-muted-foreground">{counts.measured} measured · {counts.example} example · {counts.blocked} blocked</span>}>
          {feed.engines.length === 0 ? <Empty title="No engines reported" body="The feed returned an empty catalogue." /> : (
            <ul className="grid sm:grid-cols-2 gap-px bg-border border border-border">{feed.engines.map((e) => (
              <li key={e.id} className="bg-card">
                <Link href={"/engines/" + e.id} data-testid={"link-engine-" + e.id} className="block p-2.5 hover:bg-muted/60 h-full">
                  <div className="flex items-center justify-between gap-2"><span className="font-display text-sm font-medium truncate">{e.name}</span><StatusChip status={e.status} /></div>
                  <div className="font-mono text-[10px] uppercase text-muted-foreground mt-0.5">{e.programme}</div>
                  <div className="font-mono text-xs mt-1.5 text-primary truncate">{e.metric}</div>
                </Link>
              </li>))}</ul>
          )}
        </Panel>
        <div className="space-y-4">
          <Panel kicker="Run activity" title="Recent runs" action={<Link href="/runs" data-testid="link-all-runs" className="text-xs font-mono text-primary p-1">all</Link>}>
            {feed.runs.length === 0 ? <Empty title="No runs" body="No run history has been recorded." /> : (
              <ol className="space-y-1">{feed.runs.slice(0, 6).map((r) => (
                <li key={r.id}><Link href={"/runs/" + r.id} data-testid={"link-run-" + r.id} className="flex items-center gap-2 py-1.5 px-1 hover:bg-muted/60 text-xs">
                  <span className="diamond size-2 shrink-0" /><span className="font-mono text-muted-foreground w-28 shrink-0">{fmt(r.startedAt)}</span><span className="truncate">{r.outcome}</span>
                </Link></li>))}</ol>
            )}
          </Panel>
          <SuggestionForm />
        </div>
      </div>
    </div>
  );
}

function SuggestionForm() {
  const qc = useQueryClient();
  const m = useSubmitCommandSuggestion({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetCommandFeedQueryKey() }) } });
  const [programme, setProgramme] = useState<SuggestionInputProgramme>("continuity");
  const [text, setText] = useState("");
  const len = text.trim().length;
  const ok = len >= 20 && len <= 1000;
  if (m.data) return (
    <Panel kicker="Private suggestion" title="Receipt">
      <div className="text-xs space-y-2" data-testid="text-receipt" role="status">
        <div className="flex items-center gap-2 text-primary"><Check className="size-4" />Received and stored privately.</div>
        <dl className="font-mono text-[11px] grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"><dt className="text-muted-foreground">id</dt><dd className="break-all">{m.data.id}</dd><dt className="text-muted-foreground">status</dt><dd>{m.data.status}</dd></dl>
        <p className="text-muted-foreground">This note is inert. It does not start, schedule or change any engine run. It is not published.</p>
        <button onClick={() => { m.reset(); setText(""); }} data-testid="button-new-suggestion" className="text-xs font-mono underline py-2">write another</button>
      </div>
    </Panel>
  );
  return (
    <Panel kicker="Private · inert" title="Suggest a research question">
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (ok) m.mutate({ data: { programme, text: text.trim() } }); }}>
        <label className="block text-[11px] font-mono text-muted-foreground" htmlFor="prog">programme</label>
        <select id="prog" value={programme} onChange={(e) => setProgramme(e.target.value as SuggestionInputProgramme)} data-testid="select-programme" className="w-full bg-input/40 border border-input px-2 py-2 text-base sm:text-sm min-h-11">
          {Object.values(SuggestionInputProgramme).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="block text-[11px] font-mono text-muted-foreground" htmlFor="sug">suggestion (20–1000 characters)</label>
        <textarea id="sug" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} data-testid="input-suggestion" className="w-full bg-input/40 border border-input px-2 py-2 text-base sm:text-sm resize-y" aria-describedby="sug-help" />
        <div id="sug-help" className="flex justify-between text-[10px] font-mono text-muted-foreground"><span>Stored privately. Never triggers a run.</span><span>{len}/1000</span></div>
        {m.isError && <p role="alert" className="text-xs text-destructive">Could not store the suggestion. Try again.</p>}
        <button type="submit" disabled={!ok || m.isPending} data-testid="button-submit-suggestion" className="w-full min-h-11 bg-primary text-primary-foreground font-mono text-xs uppercase tracking-wider disabled:opacity-40">{m.isPending ? "Storing" : "Send privately"}</button>
      </form>
    </Panel>
  );
}
