/* Signed-out public dashboard. Feed values are rendered as text; the private Seed is never requested. */
(() => {
  const status = document.getElementById("command-status");
  const results = document.getElementById("command-results");
  const form = document.getElementById("command-suggestion-form");
  const approvedServiceUrl = "https://zioncore-command-public-web-pffsyl4lbq-nw.a.run.app/";
  let host = null;
  let feed = null;

  if (!status || !results) return;

  const text = (value, empty = "Not reported") =>
    value == null || value === "" ? empty : String(value);
  const append = (parent, tag, value = "", className = "") => {
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
    } catch {
      // Invalid evidence links remain plain text.
    }
  };
  const internalLink = (parent, label, route) => {
    const anchor = append(parent, "a", label);
    anchor.href = "#/" + route.replace(/^\/+/, "");
    return anchor;
  };
  const go = (route) => {
    location.hash = "#/" + route.replace(/^\/+/, "");
  };
  const money = (micros, currency) => {
    if (micros == null || !currency) return "Not verified";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: 4,
      }).format(Number(micros) / 1_000_000);
    } catch {
      return `${micros} micros ${currency}`;
    }
  };
  const usd = (micros) => money(micros, "USD");
  const route = () => {
    const raw = (location.hash || "#/").replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
    return { view: parts[0] || "home", id: parts[1] || "" };
  };
  const renderNav = () => {
    let nav = document.getElementById("command-nav");
    if (!nav) {
      nav = document.createElement("nav");
      nav.id = "command-nav";
      nav.setAttribute("aria-label", "Command sections");
      results.parentElement.insertBefore(nav, results);
    }
    nav.replaceChildren();
    for (const [label, path] of [
      ["Overview", ""],
      ["Engines", "engines"],
      ["Warnings", "warnings"],
      ["Advice", "advice"],
      ["Runs", "runs"],
      ["Research", "research"],
      ["Knowledge & costs", "knowledge"],
      ["Continuity", "continuity"],
      ["Genesis", "genesis"],
    ]) {
      const link = append(nav, "a", label, "nav-link");
      link.href = path ? `#/${path}` : "#/";
      link.setAttribute("data-testid", `link-nav-${path || "overview"}`);
    }
  };
  const allWarnings = () =>
    (feed?.runs || []).flatMap((run) =>
      (Array.isArray(run.warnings) ? run.warnings : []).map((warning) => ({ ...warning, runId: run.id })),
    );
  const allAdvice = () =>
    (feed?.runs || []).flatMap((run) =>
      (Array.isArray(run.advice) ? run.advice : []).map((advice) => ({ ...advice, runId: run.id })),
    );
  const addEvidence = (parent, evidence) => {
    const list = Array.isArray(evidence) ? evidence : [];
    if (!list.length) {
      append(parent, "p", "No public evidence records are reported.", "hint");
      return;
    }
    for (const item of list) {
      const row = append(parent, "p", item.detail || item.label || "Evidence record");
      safeEvidenceLink(row, item);
    }
  };
  const addWarning = (parent, item) => {
    const card = append(parent, "article", "");
    append(card, "h3", text(item.signal, "Warning"));
    append(card, "p", text(item.outcome), "metric");
    append(card, "p", `Source: ${text(item.source)} · Horizon: ${text(item.horizon)} · Confidence: ${text(item.confidence)}`);
    append(card, "p", `Action: ${text(item.action)}`);
    append(card, "p", `Status: ${text(item.status)}`);
    internalLink(card, `Evidence from run ${item.runId}`, `runs/${item.runId}`);
  };
  const addAdvice = (parent, item) => {
    const card = append(parent, "article", "");
    append(card, "h3", text(item.title, "Advice"));
    append(card, "p", text(item.why));
    append(card, "p", `Action: ${text(item.action)}`, "metric");
    append(card, "p", `Uncertainty: ${text(item.uncertainty)}`, "hint");
    internalLink(card, `Source run ${item.runId}`, `runs/${item.runId}`);
  };
  const showLearningSummary = (parent) => {
    const learning = feed?.learning;
    if (!learning) {
      append(parent, "p", "Learning and AI usage metrics are unavailable in this production feed; unavailable does not mean zero.", "hint");
      return;
    }
    append(parent, "p", `Internally completed missions: ${text(learning.internalMissionRuns, "Not reported")}`);
    append(parent, "p", `Paid AI calls avoided: ${text(learning.paidAiCallsAvoided, "Not reported")}`);
    append(parent, "p", `Paid AI calls recorded: ${text(learning.paidAiCalls, "Not reported")}`);
    append(parent, "p", `Billing period: ${text(learning.billingPeriod)}`);
    append(parent, "p", `Gateway estimate: ${usd(learning.monthlyPaidAiSpendMicros)} · reserved uncertain spend: ${usd(learning.monthlyPaidAiReservedMicros)}.`);
    append(parent, "p", `Paid requests accepted by the application gate: ${text(learning.monthlyPaidAiRequests, "Not reported")} · configured allowance: ${usd(learning.monthlyPaidAiAllowanceMicros)}.`);
    append(parent, "p", "Gateway usage is an estimate, not a provider invoice. Cloud infrastructure is reported separately.", "hint");
  };
  const showOverview = () => {
    const latest = feed.runs?.[0];
    const summary = section("Live operations", true);
    append(summary, "p", `State: ${text(feed.state)} · Scheduled cadence: ${text(feed.cadence)}.`);
    append(summary, "p", `Next scheduled run: ${text(feed.nextExpected)}.`);
    append(summary, "p", `Public feed reports ${feed.engines.length} engines and ${feed.runs.length} retained runs in this response.`);
    if (latest && /^[a-z0-9-]+$/i.test(latest.id)) {
      internalLink(summary, `Open latest run ${latest.id} (${text(latest.outcome)})`, `runs/${latest.id}`);
    } else append(summary, "p", "No completed public run is available.");
    const genesis = feed.genesis || {};
    append(summary, "p", `Genesis AI status: ${text(genesis.status)}. The Seed payload and provider credentials are never displayed here.`);
    if (genesis.note) append(summary, "p", genesis.note, "hint");

    const warnings = allWarnings().slice(0, 8);
    const warningSection = section(`Warnings (${warnings.length} recent)`);
    if (!warnings.length) append(warningSection, "p", "No warnings are recorded in the runs returned by the feed. This is not a forecast of safety.");
    else warnings.forEach((item) => addWarning(warningSection, item));

    const advice = allAdvice().slice(0, 6);
    const adviceSection = section("Recent advice");
    if (!advice.length) append(adviceSection, "p", "No advice is recorded in the available runs.");
    else advice.forEach((item) => addAdvice(adviceSection, item));

    const learning = section("Monthly learning and paid-AI usage");
    showLearningSummary(learning);

    const engineSection = section(`Operational engines (${feed.engines.length}/14)`, true);
    if (!feed.engines.length) append(engineSection, "p", "No engines are reported.");
    for (const engine of feed.engines) {
      if (!/^[a-z0-9-]+$/.test(engine.id)) continue;
      const card = append(engineSection, "article", "");
      internalLink(card, `${text(engine.name, engine.id)} · ${engine.id}`, `engines/${engine.id}`);
      append(card, "p", `${text(engine.status)} · ${text(engine.metric)}`, "metric");
      append(card, "p", text(engine.detail));
    }
    const history = section("Recent run history");
    if (!feed.runs.length) append(history, "p", "No runs are recorded.");
    for (const run of feed.runs) {
      if (!/^[a-z0-9-]+$/i.test(run.id)) continue;
      const card = append(history, "article", "");
      internalLink(card, `${text(run.kind, "Run")} · ${text(run.outcome)} · ${run.id}`, `runs/${run.id}`);
      append(card, "p", `Started: ${text(run.startedAt)} · Finished: ${text(run.finishedAt)}`, "hint");
    }
  };
  const showEngines = (id = "") => {
    const engines = Array.isArray(feed.engines) ? feed.engines : [];
    if (!id) {
      const list = section(`All operational engines (${engines.length}/14)`, true);
      if (!engines.length) append(list, "p", "No engines are reported.");
      for (const engine of engines) {
        if (!/^[a-z0-9-]+$/.test(engine.id)) continue;
        const card = append(list, "article", "");
        internalLink(card, `${text(engine.name, engine.id)} · ${engine.id}`, `engines/${engine.id}`);
        append(card, "p", `${text(engine.programme)} · ${text(engine.status)} · ${text(engine.metric)}`, "metric");
        append(card, "p", text(engine.detail));
      }
      return;
    }
    const engine = engines.find((item) => item.id === id);
    const panel = section(engine ? text(engine.name, id) : "Engine not found", true);
    if (!engine) {
      append(panel, "p", "No engine with this ID is present in the public feed.");
      return;
    }
    append(panel, "p", `Programme: ${text(engine.programme)} · Status: ${text(engine.status)}`, "metric");
    append(panel, "p", `Metric: ${text(engine.metric)}`);
    append(panel, "p", text(engine.detail));
    append(panel, "h3", "Evidence");
    addEvidence(panel, engine.evidence);
    const history = section("Engine run history", true);
    let count = 0;
    for (const run of feed.runs || []) {
      const result = (run.engines || []).find((item) => item.id === engine.id);
      if (!result) continue;
      count++;
      const card = append(history, "article", "");
      internalLink(card, `${text(run.startedAt)} · ${text(result.status)} · ${text(result.metric)}`, `runs/${run.id}`);
      append(card, "p", text(result.detail));
      addEvidence(card, result.evidence);
    }
    if (!count) append(history, "p", "No per-run engine history is included in the current feed window.");
  };
  const showProgramme = (programme) => {
    const engines = (feed.engines || []).filter((engine) => engine.programme === programme);
    const panel = section(`${programme} programme · ${engines.length} engines`, true);
    if (!engines.length) append(panel, "p", "No engines for this programme are present in the public feed.");
    for (const engine of engines) {
      const card = append(panel, "article", "");
      internalLink(card, `${text(engine.name, engine.id)} · ${text(engine.status)} · ${text(engine.metric)}`, `engines/${engine.id}`);
      append(card, "p", text(engine.detail));
      addEvidence(card, engine.evidence);
    }
  };
  const showWarnings = () => {
    const items = allWarnings();
    const panel = section(`Warning history (${items.length})`, true);
    if (!items.length) append(panel, "p", "No warnings are recorded in the available runs.");
    items.forEach((item) => addWarning(panel, item));
  };
  const showAdvice = () => {
    const items = allAdvice();
    const panel = section(`Advice history (${items.length})`, true);
    if (!items.length) append(panel, "p", "No advice is recorded in the available runs.");
    items.forEach((item) => addAdvice(panel, item));
  };
  const showRuns = (id = "") => {
    if (!id) {
      const panel = section(`Run history (${feed.runs.length})`, true);
      if (!feed.runs.length) append(panel, "p", "No runs are recorded.");
      for (const run of feed.runs) {
        if (!/^[a-z0-9-]+$/i.test(run.id)) continue;
        const card = append(panel, "article", "");
        internalLink(card, `${run.id} · ${text(run.kind)} · ${text(run.outcome)}`, `runs/${run.id}`);
        append(card, "p", `Started: ${text(run.startedAt)} · Finished: ${text(run.finishedAt)} · Engines: ${(run.engines || []).length} · Research: ${(run.research || []).length}`, "hint");
      }
      return;
    }
    const run = (feed.runs || []).find((item) => item.id === id);
    const panel = section(run ? `Run ${run.id}` : "Run not found", true);
    if (!run) {
      append(panel, "p", "This run is outside the public feed window or was not found.");
      return;
    }
    append(panel, "p", `Kind: ${text(run.kind)} · Outcome: ${text(run.outcome)}`);
    append(panel, "p", `Started: ${text(run.startedAt)} · Finished: ${text(run.finishedAt)}`, "hint");
    const engines = section(`Engine results (${(run.engines || []).length})`, true);
    for (const result of run.engines || []) {
      const card = append(engines, "article", "");
      internalLink(card, `${text(result.name, result.id)} · ${text(result.status)} · ${text(result.metric)}`, `engines/${result.id}`);
      append(card, "p", text(result.detail));
      addEvidence(card, result.evidence);
    }
    const warnings = section("Warnings", true);
    if (!(run.warnings || []).length) append(warnings, "p", "No warnings were recorded for this run.");
    (run.warnings || []).forEach((item) => addWarning(warnings, { ...item, runId: run.id }));
    const advice = section("Advice", true);
    if (!(run.advice || []).length) append(advice, "p", "No advice was recorded for this run.");
    (run.advice || []).forEach((item) => addAdvice(advice, { ...item, runId: run.id }));
    const research = section("Research", true);
    if (!(run.research || []).length) append(research, "p", "No research entries were recorded for this run.");
    for (const record of run.research || []) {
      const card = append(research, "article", "");
      append(card, "h3", text(record.title, "Research record"));
      append(card, "p", `Programme: ${text(record.programme)} · Hypothesis: ${text(record.hypothesis)}`);
      append(card, "p", `Method: ${text(record.method)}`);
      append(card, "p", `Result: ${text(record.result)}`);
      append(card, "p", `Failed approach: ${text(record.failedApproach)}`);
      append(card, "p", `Next: ${text(record.next)}`);
      addEvidence(card, record.evidence);
    }
    if (run.learning?.tracking === "legacy") {
      const learning = section("Learning trace", true);
      append(learning, "p", "This historical run predates structured learning telemetry. External-AI use and paid cost are unknown; this run is not counted in measured totals.", "hint");
    } else if (run.learning) {
      const learning = section("Learning trace", true);
      append(learning, "p", `Method: ${text(run.learning.methodId)} · version ${text(run.learning.methodVersion)}`);
      append(learning, "p", `Reused: ${Boolean(run.learning.knowledgeReused)} · verification: ${text(run.learning.verification)} · external AI: ${text(run.learning.externalAiMode)}`);
      append(learning, "p", `External calls: ${text(run.learning.externalAiCalls)} · paid calls: ${text(run.learning.paidAiCalls)} · paid-cost estimate: ${usd(run.learning.paidCostMicros)}`);
      if (run.learning.knowledgeId) internalLink(learning, "Open retained knowledge record", "knowledge");
    } else append(section("Learning trace", true), "p", "No learning telemetry is recorded for this run.");
  };
  const showResearch = () => {
    const panel = section("Research, methods, and evidence", true);
    let count = 0;
    for (const run of feed.runs || []) {
      for (const record of run.research || []) {
        count++;
        const card = append(panel, "article", "");
        append(card, "h3", text(record.title, "Research record"));
        internalLink(card, `Run ${run.id} · ${text(record.programme)}`, `runs/${run.id}`);
        append(card, "p", `Hypothesis: ${text(record.hypothesis)}`);
        append(card, "p", `Method: ${text(record.method)}`);
        append(card, "p", `Result: ${text(record.result)}`);
        append(card, "p", `Failed approach: ${text(record.failedApproach)}`);
        append(card, "p", `Next: ${text(record.next)}`);
        addEvidence(card, record.evidence);
      }
    }
    if (!count) append(panel, "p", "No research records are available in the public feed.");
  };
  const showCosts = (parent) => {
    const learning = feed.learning;
    const report = learning?.monthlyCostReport;
    const panel = parent || section("Monthly costs", true);
    if (!report) {
      append(panel, "p", "Verified cost data is unavailable in this production feed. Unavailable is not zero.", "hint");
      return;
    }
    const currency = report.billingCurrency;
    append(panel, "h3", `Project ${text(report.projectId)} · billing period ${text(report.billingPeriod)}`);
    append(panel, "p", `Billing export: ${text(report.billingExportStatus)} · freshness: ${text(report.billingFreshnessStatus)} · observed: ${text(report.billingObservedAt)}`);
    if (report.billingFreshnessStatus !== "fresh") {
      append(panel, "p", `Actuals are hidden or stale: ${text(report.incompleteReason)}`, "hint");
    }
    for (const [label, value] of [
      ["Cloud Run", report.cloudRunMicros],
      ["Firestore", report.firestoreMicros],
      ["Cloud Scheduler", report.schedulerMicros],
      ["Cloud Storage", report.storageMicros],
      ["Other project services", report.otherProjectServicesMicros],
      ["Infrastructure total", report.infrastructureTotalMicros],
    ]) append(panel, "p", `${label}: ${money(value, currency)}`);
    append(panel, "p", `Provider-billed AI actual: ${money(report.paidAiActualMicros, report.paidAiActualCurrency)}`);
    append(panel, "p", `Application gateway estimate (not a receipt): ${usd(report.aiLedgerEstimateUsdMicros)}`);
    append(panel, "p", `AI reconciliation: ${text(report.reconciliationStatus)} · variance: ${money(report.aiVarianceMicros, currency)}`);
    append(panel, "p", `Combined actual: ${money(report.combinedTotalMicros, report.combinedCurrency)} · status: ${text(report.combinedStatus)}`);
    if (report.fxRateToBilling != null) {
      append(panel, "p", `Recorded conversion: 1 USD = ${report.fxRateToBilling} ${text(currency)} · ${text(report.fxDate)} · ${text(report.fxSource)}`);
    }
  };
  const showKnowledge = () => {
    const panel = section("Verified reusable knowledge", true);
    const entries = Array.isArray(feed.knowledge) ? feed.knowledge : [];
    if (!entries.length) append(panel, "p", "No reusable knowledge entries are available in this feed.");
    for (const entry of entries) {
      const card = append(panel, "article", "");
      append(card, "h3", `${text(entry.title, "Method")} · ${text(entry.version)} · ${text(entry.status)}`);
      append(card, "p", `Programme: ${text(entry.programme)} · Method version: ${text(entry.version)}`);
      append(card, "p", text(entry.method));
      append(card, "p", `Uncertainty: ${text(entry.uncertainty)}`);
      append(card, "p", `Checksum: ${text(entry.methodChecksum)} · Source run: ${text(entry.sourceRunId)}`, "hint");
      if (entry.sourceRunId) internalLink(card, "Open the research run that produced this method", `runs/${entry.sourceRunId}`);
      addEvidence(card, entry.evidence);
      for (const evaluation of entry.evaluations || []) {
        append(card, "p", `Reuse test: ${text(evaluation.outcome)} · run ${text(evaluation.runId)} · ${text(evaluation.recordedAt)}`, "hint");
        if (evaluation.runId) internalLink(card, "Open reuse test run", `runs/${evaluation.runId}`);
      }
    }
    showLearningSummary(section("Monthly learning and paid-AI usage", true));
    showCosts(section("Verified infrastructure and AI costs", true));
    const snapshots = Array.isArray(feed.finalizedMonthlyCosts) ? feed.finalizedMonthlyCosts : [];
    const receipts = section("Finalized monthly receipts", true);
    if (!snapshots.length) append(receipts, "p", "No owner-reconciled billing receipt is available. Estimates are not receipts.");
    for (const snapshot of snapshots) {
      const card = append(receipts, "article", "");
      append(card, "h3", `${text(snapshot.billingPeriod)} · ${text(snapshot.projectId)} · ${text(snapshot.billingCurrency)}`);
      append(card, "p", `Infrastructure: ${money(snapshot.infrastructureTotalMicros, snapshot.billingCurrency)} · provider AI billed: ${money(snapshot.paidAiActualMicros, snapshot.paidAiActualCurrency)} · combined: ${money(snapshot.combinedTotalMicros, snapshot.billingCurrency)}`);
      append(card, "p", `Owner-reconciled: ${Boolean(snapshot.ownerReconciled)} · source: ${text(snapshot.source)} · observed: ${text(snapshot.billingObservedAt)}`);
      append(card, "p", `Receipt reference: ${text(snapshot.invoiceReference)} · invoice SHA-256: ${text(snapshot.invoiceSha256)} · snapshot SHA-256: ${text(snapshot.checksum)}`, "hint");
    }
  };
  const showGenesis = () => {
    const panel = section("Genesis AI readiness", true);
    const genesis = feed.genesis || {};
    append(panel, "p", `Status: ${text(genesis.status)} · version: ${text(genesis.version)}`);
    append(panel, "p", `Reported checksum: ${text(genesis.checksum)}`);
    append(panel, "p", text(genesis.note, "Seed payload is not displayed on this public page."));
    append(panel, "p", "The reported checksum is not proof that the configured candidate matches the owner-approved original Seed.", "hint");
    append(panel, "p", "This page never displays the canonical Seed or provider credentials. Paid calls must remain off until the owner-approved canonical Seed, provider, and credentials are configured and verified.");
  };
  const render = () => {
    if (!feed) return;
    results.replaceChildren();
    renderNav();
    const current = route();
    if (current.view === "engines") showEngines(current.id);
    else if (current.view === "warnings") showWarnings();
    else if (current.view === "advice") showAdvice();
    else if (current.view === "runs") showRuns(current.id);
    else if (current.view === "research") showResearch();
    else if (current.view === "knowledge" || current.view === "costs") showKnowledge();
    else if (current.view === "continuity") showProgramme("continuity");
    else if (current.view === "genesis") showGenesis();
    else showOverview();
  };
  const refresh = async () => {
    if (!host) return;
    const response = await fetch(new URL("/api/command/feed", host), {
      credentials: "omit",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
    const next = await response.json();
    if (!Array.isArray(next.engines) || !Array.isArray(next.runs)) throw new Error("Unexpected public-feed shape");
    feed = next;
    status.textContent = `Production feed: ${text(feed.state)} · ${text(feed.cadence)} Next scheduled run: ${text(feed.nextExpected)}.`;
    render();
  };
  const configure = async () => {
    const response = await fetch("./command-live.json", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Public feed configuration unavailable");
    const config = await response.json();
    host = new URL(config.url || config.serviceUrl);
    if (host.href !== approvedServiceUrl) throw new Error("Unexpected production API origin");
  };

  window.addEventListener("hashchange", render);
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = document.getElementById("suggestion-submit");
      const message = document.getElementById("suggestion-status");
      if (!button || !message) return;
      if (!host) {
        message.textContent = "The private review queue is not reachable yet. Try again when the feed is available.";
        return;
      }
      const data = new FormData(form);
      const resourceUrl = String(data.get("resourceUrl") || "").trim();
      if (resourceUrl) {
        try {
          const parsed = new URL(resourceUrl);
          if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
        } catch {
          message.textContent = "Use a public HTTPS resource link without embedded credentials.";
          return;
        }
      }
      const body = {
        programme: String(data.get("programme") || ""),
        text: String(data.get("text") || "").trim(),
        ...(resourceUrl ? { resourceUrl } : {}),
      };
      button.disabled = true;
      message.textContent = "Sending to the private review queue…";
      try {
        const submitted = await fetch(new URL("/api/command/suggestions", host), {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(12000),
        });
        const receipt = await submitted.json().catch(() => ({}));
        if (!submitted.ok) throw new Error(receipt.error || `HTTP ${submitted.status}`);
        message.textContent = `Stored privately for review. Reference: ${receipt.id}. It was not published, executed, or fetched.`;
        form.reset();
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : "Could not submit. Try again later.";
      } finally {
        button.disabled = false;
      }
    });
  }
  configure()
    .then(refresh)
    .catch((error) => {
      status.textContent = `The public production feed is unavailable; no results are shown as current. ${error instanceof Error ? error.message : ""}`;
    });
  window.setInterval(() => {
    refresh().catch(() => {
      status.textContent = "Feed refresh failed. Displayed results may be stale; retry shortly.";
    });
  }, 60_000);
})();
