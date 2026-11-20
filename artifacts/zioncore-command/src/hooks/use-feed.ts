import { useGetCommandFeed, getGetCommandFeedQueryKey, type CommandFeed, type LearningMetrics } from "@workspace/api-client-react";

// Older deployed feeds do not include the newer knowledge and learning fields.
export function normalizeFeed(feed: CommandFeed): CommandFeed & { knowledgeAvailable: boolean } {
  if (!Array.isArray(feed.engines) || !Array.isArray(feed.runs)) throw new Error("Unexpected public feed");
  const engine = (e: CommandFeed["engines"][number]) => ({ ...e, evidence: e.evidence ?? [] });
  return {
    ...feed,
    knowledgeAvailable: Array.isArray(feed.knowledge),
    genesis: feed.genesis ?? { status: "not reported", version: "not reported", checksum: "not reported", note: "Genesis metadata is unavailable." },
    learning: feed.learning ?? ({} as LearningMetrics),
    knowledge: (feed.knowledge ?? []).map((entry) => ({ ...entry, evidence: entry.evidence ?? [], evaluations: entry.evaluations ?? [] })),
    engines: feed.engines.map(engine),
    runs: feed.runs.map((run) => ({
      ...run,
      engines: (run.engines ?? []).map(engine),
      warnings: run.warnings ?? [],
      advice: run.advice ?? [],
      research: (run.research ?? []).map((entry) => ({ ...entry, evidence: entry.evidence ?? [] })),
    })),
  };
}
export function useFeed() {
  return useGetCommandFeed({ query: { queryKey: getGetCommandFeedQueryKey(), select: normalizeFeed, refetchInterval: 60_000, refetchOnWindowFocus: true, retry: 1 }, request: { credentials: "omit" } });
}
export function fmt(ts?: string | null) {
  if (!ts) return "not scheduled";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
export function dur(a: string, b: string) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}
