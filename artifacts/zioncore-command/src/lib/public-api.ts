export const apiBase = import.meta.env.VITE_PAGES === "true"
  ? "https://zioncore-command-public-web-pffsyl4lbq-nw.a.run.app"
  : "";

export function safeHttpsUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function safeInternalPath(value?: string): string | undefined {
  if (!value) return undefined;
  return /^\/(?:|command\.html|continuity|research|knowledge|genesis|runs(?:\/[a-z0-9-]+)?|engines(?:\/[a-z0-9-]+)?)$/i.test(value)
    ? value
    : undefined;
}
