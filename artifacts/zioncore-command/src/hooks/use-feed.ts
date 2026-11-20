import { useGetCommandFeed, getGetCommandFeedQueryKey } from "@workspace/api-client-react";
export function useFeed() {
  return useGetCommandFeed({ query: { queryKey: getGetCommandFeedQueryKey(), refetchInterval: 60_000, refetchOnWindowFocus: true, retry: 1 } });
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
