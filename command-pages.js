/* Pages stays read-only. All remote text is inserted as text, never HTML. */
(() => {
  const status = document.getElementById("command-status");
  const results = document.getElementById("command-results");
  const append = (parent, tag, value) => {
    const node = document.createElement(tag);
    node.textContent = value;
    parent.append(node);
    return node;
  };
  const update = async () => {
    const config = await fetch("./command-live.json", {cache:"no-store",signal:AbortSignal.timeout(8000)});
    if (!config.ok) throw new Error("Configuration unavailable");
    const {url} = await config.json();
    if (!url) {
      if (status) status.textContent = "A verified production feed has not been linked to this page yet.";
      return;
    }
    const host = new URL(url);
    if (host.protocol !== "https:" || !host.hostname.endsWith(".run.app") || host.username || host.password || host.port || host.pathname !== "/" || host.search || host.hash) throw new Error("Invalid service URL");
    for (const link of document.querySelectorAll("[data-command-app]")) {
      link.href = host.href;
      link.hidden = false;
    }
    if (!status || !results) return;
    const response = await fetch(new URL("/api/command/feed",host),{credentials:"omit",signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error("Feed unavailable");
    const feed = await response.json();
    if (!Array.isArray(feed.engines) || !Array.isArray(feed.runs)) throw new Error("Unexpected feed");
    status.textContent = `Feed: ${feed.state}. ${feed.cadence}`;
    results.replaceChildren();
    const latest = feed.runs[0];
    if (latest && /^[a-z0-9-]+$/i.test(latest.id)) {
      const a = append(results, "a", `Latest public run: ${latest.id} (${latest.outcome})`);
      a.href = new URL(`/runs/${latest.id}`,host).href;
    }
    for (const engine of feed.engines.slice(0,14)) {
      if (!/^[a-z0-9-]+$/.test(engine.id)) continue;
      const card = append(results,"article","");
      const h = append(card,"h2","");
      const a = append(h,"a",engine.name);
      a.href = new URL(`/engines/${engine.id}`,host).href;
      append(card,"p",`${engine.status} · ${engine.metric}`);
      append(card,"p",engine.detail);
    }
  };
  update().catch(() => {
    if (status) status.textContent = "The public feed is temporarily unavailable. Try the dashboard once available.";
  });
})();
