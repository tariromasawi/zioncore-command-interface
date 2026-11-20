/* Signed-out public Command dashboard for GitHub Pages. Feed-only; no Seed text. */
(() => {
  const status = document.getElementById("command-status");
  const results = document.getElementById("command-results");
  const form = document.getElementById("command-suggestion-form");
  const approvedServiceUrl = "https://zioncore-command-public-web-pffsyl4lbq-nw.a.run.app/";
  const appLink = document.querySelector("[data-command-app]");
  const append = (parent, tag, value, className) => {
    const node = document.createElement(tag);
    if (value != null && value !== "") node.textContent = String(value);
    if (className) node.className = className;
    parent.append(node);
    return node;
  };
  const section = (title, wide) => {
    const node = document.createElement("section");
    if (wide) node.className = "wide";
    append(node, "h2", title);
    results.append(node);
    return node;
  };
  const safeEvidenceLink = (parent, item) => {
    if (!item || typeof item.url !== "string") return;
    try {
      const url = new URL(item.url);
      if (url.protocol !== "https:" || url.username || url.password) return;
      const anchor = append(parent, "a", item.label || url.hostname);
      anchor.href = url.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    } catch { /* ignore */ }
  };
  const route = () => {
    const h = (location.hash || "#/").replace(/^#/, "");
    const parts = h.split("/").filter(Boolean);
    return { view: parts[0] || "home", id: parts[1] || "" };
  };
  const setHash = (path) => { location.hash = path.startsWith("#") ? path : "#" + path; };
  const navLink = (parent, label, hash) => {
    const a = append(parent, "a", label, "nav-link");
    a.href = hash;
    a.addEventListener("click", (e) => { e.preventDefault(); setHash(hash); });
    return a;
  };
  let lastFeed = null;
  let lastHost = null;
  const renderNav = () => {
    let bar = document.getElementById("command-nav");
    if (!bar) {
      bar = document.createElement("nav");
      bar.id = "command-nav";
      bar.setAttribute("aria-label", "Command sections");
      results.parentElement.insertBefore(bar, results);
    }
    bar.replaceChildren();
    navLink(bar, "Overview", "#/");
    navLink(bar, "Engines", "#/engines");
    navLink(bar, "Runs", "#/runs");
    navLink(bar, "Research", "#/research");
    navLink(bar, "Knowledge", "#/knowledge");
    navLink(bar, "Genesis", "#/genesis");
  };
  const showOverview = (feed) => {
    const summary = section("Live operations", true);
    append(summary, "p", "State: " + (feed.state || "unknown") + " · " + (feed.cadence || ""));
    append(summary, "p", "Next expected run: " + (feed.nextExpected || "not reported"));
    append(summary, "p", "Genesis AI: " + (feed.genesis && feed.genesis.status || "not reported") +
      (feed.genesis && feed.genesis.checksum ? " · checksum " + feed.genesis.checksum.slice(0, 12) + "…" : "") +
      ". Seed text is never shown on this public page.");
    const latest = feed.runs && feed.runs[0];
    if (latest && /^[a-z0-9-]+$/i.test(latest.id)) {
      const p = append(summary, "p", "");
      const a = append(p, "a", "Latest run " + latest.id + " (" + (latest.outcome || "") + ")");
      a.href = "#/runs/" + latest.id;
      a.addEventListener("click", (e) => { e.preventDefault(); setHash("#/runs/" + latest.id); });
    }
    if (feed.learning) {
      append(summary, "p", "Learning: knowledge reused=" + String(feed.learning.knowledgeReused) +
        ", external AI=" + (feed.learning.externalAiMode || "n/a") +
        ", calls=" + String(feed.learning.externalAiCalls != null ? feed.learning.externalAiCalls : "n/a"));
    }
    const eng = section("Operational engines (" + Math.min((feed.engines || []).length, 14) + "/14)");
    const grid = append(eng, "div", "", "engine-grid");
    for (const engine of (feed.engines || []).slice(0, 14)) {
      if (!/^[a-z0-9-]+$/.test(engine.id)) continue;
      const card = append(grid, "article", "", "engine-card");
      const h = append(card, "h3", "");
      const a = append(h, "a", engine.name || engine.id);
      a.href = "#/engines/" + engine.id;
      a.addEventListener("click", (e) => { e.preventDefault(); setHash("#/engines/" + engine.id); });
      append(card, "p", (engine.status || "") + " · " + (engine.metric || ""), "metric");
      append(card, "p", engine.detail || "");
    }
    const history = section("Recent scheduled runs");
    for (const run of (feed.runs || []).slice(0, 12)) {
      if (!/^[a-z0-9-]+$/i.test(run.id)) continue;
      const item = append(history, "article", "");
      const a = append(item, "a", (run.kind || "run") + " · " + (run.outcome || "") + " · " + run.id);
      a.href = "#/runs/" + run.id;
      a.addEventListener("click", (e) => { e.preventDefault(); setHash("#/runs/" + run.id); });
      append(item, "p", "Started: " + (run.startedAt || "n/a") + " · Finished: " + (run.finishedAt || "n/a"));
    }
  };
  const showEngine = (feed, id) => {
    const engine = (feed.engines || []).find((e) => e.id === id);
    const sec = section(engine ? engine.name : "Engine", true);
    if (!engine) { append(sec, "p", "Engine not found in the public feed."); return; }
    append(sec, "p", "Programme: " + (engine.programme || "n/a"));
    append(sec, "p", "Status: " + (engine.status || "") + " · " + (engine.metric || ""), "metric");
    append(sec, "p", engine.detail || "");
    append(sec, "h3", "Evidence");
    const ev = Array.isArray(engine.evidence) ? engine.evidence : [];
    if (!ev.length) append(sec, "p", "No public evidence rows.");
    for (const item of ev) { const row = append(sec, "p", item.detail || item.label || ""); safeEvidenceLink(row, item); }
    const back = append(sec, "p", "");
    const a = append(back, "a", "← All engines");
    a.href = "#/engines";
    a.addEventListener("click", (e) => { e.preventDefault(); setHash("#/engines"); });
  };
  const showEnginesList = (feed) => {
    const sec = section("All 14 engines", true);
    for (const engine of (feed.engines || []).slice(0, 14)) {
      if (!/^[a-z0-9-]+$/.test(engine.id)) continue;
      const card = append(sec, "article", "");
      const h = append(card, "h3", "");
      const a = append(h, "a", engine.name + " (" + engine.id + ")");
      a.href = "#/engines/" + engine.id;
      a.addEventListener("click", (e) => { e.preventDefault(); setHash("#/engines/" + engine.id); });
      append(card, "p", (engine.status || "") + " · " + (engine.metric || ""));
      append(card, "p", engine.detail || "");
    }
  };
  const showRun = (feed, id) => {
    const run = (feed.runs || []).find((r) => r.id === id);
    const sec = section(run ? run.id : "Run", true);
    if (!run) { append(sec, "p", "Run not in the public feed window."); return; }
    append(sec, "p", "Kind: " + (run.kind || "") + " · Outcome: " + (run.outcome || ""));
    append(sec, "p", "Started: " + (run.startedAt || "n/a"));
    append(sec, "p", "Finished: " + (run.finishedAt || "n/a"));
    if (run.genesis) append(sec, "p", "Genesis: " + JSON.stringify(run.genesis));
    if (run.learning) append(sec, "p", "Learning: " + JSON.stringify(run.learning));
    if (Array.isArray(run.research) && run.research.length) {
      append(sec, "h3", "Research on this run");
      for (const record of run.research) {
        const card = append(sec, "article", "");
        append(card, "h4", record.title || "Research");
        append(card, "p", "Programme: " + (record.programme || ""));
        append(card, "p", "Hypothesis: " + (record.hypothesis || ""));
        append(card, "p", "Method: " + (record.method || ""));
        append(card, "p", "Result: " + (record.result || ""));
        append(card, "p", "Next: " + (record.next || ""));
      }
    }
  };
  const showRuns = (feed) => {
    const sec = section("Run history", true);
    for (const run of (feed.runs || []).slice(0, 24)) {
      if (!/^[a-z0-9-]+$/i.test(run.id)) continue;
      const item = append(sec, "article", "");
      const a = append(item, "a", run.id);
      a.href = "#/runs/" + run.id;
      a.addEventListener("click", (e) => { e.preventDefault(); setHash("#/runs/" + run.id); });
      append(item, "p", (run.kind || "") + " · " + (run.outcome || "") + " · finished " + (run.finishedAt || "n/a"));
    }
  };
  const showResearch = (feed) => {
    const sec = section("Research findings", true);
    let n = 0;
    for (const run of (feed.runs || []).slice(0, 24)) {
      if (!Array.isArray(run.research)) continue;
      for (const record of run.research) {
        n++;
        const card = append(sec, "article", "");
        append(card, "h3", record.title || "Research");
        append(card, "p", "From run " + run.id);
        append(card, "p", "Programme: " + (record.programme || ""));
        append(card, "p", "Hypothesis: " + (record.hypothesis || ""));
        append(card, "p", "Method: " + (record.method || ""));
        append(card, "p", "Result: " + (record.result || ""));
        append(card, "p", "Limits: " + (record.failedApproach || "n/a"));
        append(card, "p", "Next: " + (record.next || ""));
        for (const evidence of (Array.isArray(record.evidence) ? record.evidence : [])) {
          const row = append(card, "p", evidence.detail || "");
          safeEvidenceLink(row, evidence);
        }
      }
    }
    if (!n) append(sec, "p", "No research records in the current public feed window.");
  };
  const showKnowledge = (feed) => {
    const sec = section("Verified reusable knowledge", true);
    const entries = Array.isArray(feed.knowledge) ? feed.knowledge : [];
    if (!entries.length) {
      append(sec, "p", "No knowledge entries in this feed revision. After the release image is deployed, exportable knowledge appears here.");
      return;
    }
    for (const entry of entries) {
      const card = append(sec, "article", "");
      append(card, "h3", (entry.title || entry.id || "Entry") + " · " + (entry.version || "") + " · " + (entry.status || ""));
      append(card, "p", entry.method || "");
      append(card, "p", "Uncertainty: " + (entry.uncertainty || "n/a"));
    }
  };
  const showGenesis = (feed) => {
    const sec = section("Genesis AI status", true);
    const g = feed.genesis || {};
    append(sec, "p", "Status: " + (g.status || "not reported"));
    append(sec, "p", "Version: " + (g.version || "n/a"));
    append(sec, "p", "Checksum: " + (g.checksum || "n/a"));
    append(sec, "p", g.note || "The approved Seed payload is never rendered on GitHub Pages.");
    append(sec, "p", "Paid and free model calls remain disabled until the owner approves the canonical Seed bytes and provider.");
  };
  const render = () => {
    if (!lastFeed) return;
    results.replaceChildren();
    renderNav();
    const r = route();
    if (r.view === "engines" && r.id) showEngine(lastFeed, r.id);
    else if (r.view === "engines") showEnginesList(lastFeed);
    else if (r.view === "runs" && r.id) showRun(lastFeed, r.id);
    else if (r.view === "runs") showRuns(lastFeed);
    else if (r.view === "research") showResearch(lastFeed);
    else if (r.view === "knowledge") showKnowledge(lastFeed);
    else if (r.view === "genesis") showGenesis(lastFeed);
    else showOverview(lastFeed);
  };
  const boot = async () => {
    try {
      const config = await fetch("./command-live.json", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!config.ok) throw new Error("Missing command-live.json");
      const { serviceUrl } = await config.json();
      const host = new URL(serviceUrl);
      if (host.href !== approvedServiceUrl) throw new Error("Invalid service URL");
      lastHost = host;
      if (appLink) {
        appLink.hidden = false;
        appLink.href = host.href;
        appLink.textContent = "Cloud Run API origin (backend)";
      }
      status.textContent = "Loading production feed…";
      const response = await fetch(new URL("/api/command/feed", host), {
        credentials: "omit",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error("Feed HTTP " + response.status);
      lastFeed = await response.json();
      status.textContent = "Production feed: " + (lastFeed.state || "?") + ". " + (lastFeed.cadence || "") +
        " Next: " + (lastFeed.nextExpected || "n/a") + ".";
      render();
    } catch (err) {
      status.textContent = "Could not load the public feed. " + (err && err.message ? err.message : "Unknown error");
    }
  };
  window.addEventListener("hashchange", render);
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.getElementById("suggestion-status");
      const button = document.getElementById("suggestion-submit");
      if (!lastHost || !message || !button) return;
      button.disabled = true;
      message.textContent = "Sending for private review…";
      try {
        const body = {
          programme: document.getElementById("suggestion-programme").value,
          text: document.getElementById("suggestion-text").value,
        };
        const resource = document.getElementById("suggestion-resource");
        if (resource && resource.value) body.resourceUrl = resource.value;
        const submitted = await fetch(new URL("/api/command/suggestions", lastHost), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(12000),
        });
        const receipt = await submitted.json().catch(() => ({}));
        if (!submitted.ok) throw new Error(receipt.error || ("HTTP " + submitted.status));
        message.textContent = "Stored privately for review. Receipt: " + (receipt.id || "issued") +
          ". It was not published, executed, or fetched.";
        form.reset();
      } catch (err) {
        message.textContent = "Submission failed. " + (err && err.message ? err.message : "Try again later.") +
          " If this is a browser CORS error, the Cloud Run image still needs the release deploy.";
      } finally {
        button.disabled = false;
      }
    });
  }
  boot();
})();
