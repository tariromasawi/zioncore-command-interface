/* Public results use text-only rendering; submissions are private and inert. */
(() => {
  const status = document.getElementById("command-status");
  const results = document.getElementById("command-results");
  const form = document.getElementById("command-suggestion-form");
  const approvedServiceUrl = "https://zioncore-command-public-web-pffsyl4lbq-nw.a.run.app/";
  const append = (parent, tag, value, className = "") => {
    const node = document.createElement(tag);
    node.textContent = value == null ? "" : String(value);
    if (className) node.className = className;
    parent.append(node);
    return node;
  };
  const section = (title, wide = false) => {
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
    } catch { /* Invalid evidence links are shown as text only. */ }
  };
  const linkTo = (parent, label, path, host) => {
    const anchor = append(parent, "a", label);
    anchor.href = new URL(path, host).href;
    return anchor;
  };
  const showFeed = (feed, host) => {
    if (!Array.isArray(feed.engines) || !Array.isArray(feed.runs)) throw new Error("Unexpected feed");
    status.textContent = `Production feed: ${feed.state}. ${feed.cadence} Next scheduled run: ${feed.nextExpected || "not reported"}.`;
    results.replaceChildren();

    const summary = section("Latest verified activity", true);
    append(summary, "p", `Scheduled cadence: ${feed.cadence}`);
    append(summary, "p", `Genesis AI status: ${feed.genesis?.status || "not reported"}. The canonical Seed is never displayed on this public page.`);
    const latest = feed.runs[0];
    if (latest && /^[a-z0-9-]+$/i.test(latest.id)) {
      linkTo(summary, `Open latest run ${latest.id} (${latest.outcome})`, `/runs/${latest.id}`, host);
    } else append(summary, "p", "No completed public run is available yet.");

    const engines = section(`Operational engines (${Math.min(feed.engines.length, 14)}/14)`);
    for (const engine of feed.engines.slice(0, 14)) {
      if (!/^[a-z0-9-]+$/.test(engine.id)) continue;
      const card = append(engines, "article", "");
      const heading = append(card, "h3", "");
      const anchor = append(heading, "a", engine.name);
      anchor.href = new URL(`/engines/${engine.id}`, host).href;
      append(card, "p", `${engine.status} · ${engine.metric}`);
      append(card, "p", engine.detail);
      for (const evidence of (Array.isArray(engine.evidence) ? engine.evidence : [])) {
        const row = append(card, "p", evidence.detail || "");
        safeEvidenceLink(row, evidence);
      }
    }

    const history = section("Recent scheduled runs");
    const runs = feed.runs.slice(0, 12);
    if (!runs.length) append(history, "p", "No scheduled runs are available.");
    for (const run of runs) {
      if (!/^[a-z0-9-]+$/i.test(run.id)) continue;
      const item = append(history, "article", "");
      linkTo(item, `${run.kind} · ${run.outcome} · ${run.id}`, `/runs/${run.id}`, host);
      append(item, "p", `Started: ${run.startedAt || "not reported"} · Finished: ${run.finishedAt || "not reported"}`);
    }

    const research = section("Research and evidence", true);
    const researchRuns = feed.runs.slice(0, 12).filter(run => Array.isArray(run.research));
    if (!researchRuns.length) append(research, "p", "No research records are available.");
    for (const run of researchRuns) for (const record of run.research) {
      const card = append(research, "article", "");
      append(card, "h3", record.title || "Research record");
      append(card, "p", `Programme: ${record.programme || "not reported"}`);
      append(card, "p", `Hypothesis: ${record.hypothesis || "not reported"}`);
      append(card, "p", `Method: ${record.method || "not reported"}`);
      append(card, "p", `Result: ${record.result || "not reported"}`);
      append(card, "p", `Limits: ${record.failedApproach || "not reported"}`);
      append(card, "p", `Next: ${record.next || "not reported"}`);
      for (const evidence of (Array.isArray(record.evidence) ? record.evidence : [])) {
        const row = append(card, "p", evidence.detail || "");
        safeEvidenceLink(row, evidence);
      }
    }

    const knowledge = section("Verified reusable knowledge", true);
    const entries = Array.isArray(feed.knowledge) ? feed.knowledge : [];
    if (!entries.length) append(knowledge, "p", "No verified knowledge entries are currently reported.");
    for (const entry of entries) {
      const card = append(knowledge, "article", "");
      append(card, "h3", `${entry.title} · ${entry.version} · ${entry.status}`);
      append(card, "p", entry.method);
      append(card, "p", `Uncertainty: ${entry.uncertainty}`);
      for (const evidence of (Array.isArray(entry.evidence) ? entry.evidence : [])) {
        const row = append(card, "p", evidence.detail || "");
        safeEvidenceLink(row, evidence);
      }
    }

    const metrics = section("Paid AI usage and internal completion");
    if (feed.learning) {
      append(metrics, "p", `Billing month: ${feed.learning.billingPeriod}`);
      append(metrics, "p", `Internally completed missions: ${feed.learning.internalMissionRuns}`);
      append(metrics, "p", `Paid calls avoided: ${feed.learning.paidAiCallsAvoided}`);
      append(metrics, "p", `Paid AI calls accepted: ${feed.learning.monthlyPaidAiRequests}`);
      append(metrics, "p", `Paid AI spend: $${(feed.learning.monthlyPaidAiSpendMicros / 1_000_000).toFixed(2)} USD; reserved: $${(feed.learning.monthlyPaidAiReservedMicros / 1_000_000).toFixed(2)} USD.`);
      append(metrics, "p", `Configured AI-only cap: $${(feed.learning.monthlyPaidAiAllowanceMicros / 1_000_000).toFixed(2)} USD.`);
      append(metrics, "p", "Cloud infrastructure spend is not included in these application metrics.");
    } else append(metrics, "p", "Paid-AI and internal-completion metrics are not available in this deployed feed.");
  };

  const update = async () => {
    const config = await fetch("./command-live.json", {cache:"no-store",signal:AbortSignal.timeout(8000)});
    if (!config.ok) throw new Error("Configuration unavailable");
    const {url} = await config.json();
    const host = new URL(url);
    if (host.href !== approvedServiceUrl) throw new Error("Invalid service URL");
    for (const link of document.querySelectorAll("[data-command-app]")) {
      link.href = host.href;
      link.hidden = false;
    }
    const feedUrl = new URL("/api/command/feed",host);
    const refresh = async () => {
      const response = await fetch(feedUrl,{credentials:"omit",signal:AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error("Feed unavailable");
      showFeed(await response.json(),host);
    };
    await refresh();

    if (form) {
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const button = document.getElementById("suggestion-submit");
        const message = document.getElementById("suggestion-status");
        const data = new FormData(form);
        const body = {
          programme: data.get("programme"),
          text: String(data.get("text") || "").trim(),
          ...(String(data.get("resourceUrl") || "").trim() ? {resourceUrl:String(data.get("resourceUrl")).trim()} : {}),
        };
        if (button) button.disabled = true;
        if (message) message.textContent = "Sending to the private review queue…";
        try {
          const submitted = await fetch(new URL("/api/command/suggestions",host),{
            method:"POST",credentials:"omit",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
            signal:AbortSignal.timeout(8000),
          });
          const receipt = await submitted.json();
          if (!submitted.ok) throw new Error(receipt.error || "Suggestion was not accepted.");
          if (message) message.textContent = `Stored privately for review. Receipt: ${receipt.id}. It was not published, executed, or fetched.`;
          form.reset();
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : "Could not submit. Try again later.";
        } finally {
          if (button) button.disabled = false;
        }
      }, {once:true});
    }
    window.setInterval(() => {
      refresh().catch(() => {
        if (status) status.textContent = "Feed refresh failed. The displayed results may be stale.";
      });
    },60_000);
  };
  update().catch(() => {
    if (status) status.textContent = "The public production feed is temporarily unavailable. No results are being shown as current.";
  });
})();
