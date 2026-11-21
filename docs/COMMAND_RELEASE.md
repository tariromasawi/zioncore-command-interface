# ZionCore Command — public release

**MWARI NDI MWARI · Vision Year 80,000.** This release is for ZionCore Command only. It does not operate ZionCore 1 (`ethereal-throne-b20e6`) or ZionCore 2nd (`zioncore-2nd-production`).

## Source recovery

The published `main` was `4a522b7709eb711a5051d1d4de50c5795d1d2120` and `release/command-private-os` was `c8966dfba7f4cc281340e0fc84fb114304e94486`. Both refs were confirmed before work. GitHub did not resolve `ceab01a` or `5e08c66`, and neither object was in the clean clone. The public landing URLs and original brand and engine names were recovered; the new Command UI, public projection, archive exercise, runner, ledger and provider gateway were implemented. The old private login and script that printed a credential-related note and scheduled a forced incident are not used by this release.

If Grok still has `ceab01a`, ask: **“In your local `tariromasawi/zioncore-command-interface` checkout, verify the full SHA for `ceab01a` and `5e08c66`. Secret-scan every commit and asset that the push would newly expose. If safe for public release, run `git push origin ceab01a:refs/heads/recovery/command-grok` (no force push). Otherwise scrub the sensitive history on a new branch from the published release and push that clean branch instead. Send back its URL, full commit SHA, and a list of omitted files. Do not modify `main`.”** A secret previously exposed in a repository or deployment log should be rotated at its provider.

### Seed provenance

| Approved canonical file | Version | Bytes | SHA-256 | Source |
|---|---:|---:|---|---|
| Entire `Genesis seed.ts`, including the TypeScript wrapper | 1.1.0 | 463,037 | `8199eb2b080c6ac56f71443c1506173f8227dc9df58a145801b56e9e2fd538c6` | `main` at `f1ae17ac70e77e81378eb8d52eb6efcfb244eb00` |

The owner approved the complete file, including its wrapper, as the model input. Its pinned source, exact byte count and SHA-256 are checked before use. Keep the Seed out of application logs, dashboard responses and container build context. It is mounted as a private, read-only Cloud Storage volume only on `zioncore-command-research`.

`ops/prepare-genesis-seed.sh` retrieves the pinned object from GitHub, verifies its bytes, creates or validates the dedicated private bucket, uploads without overwriting a different object, and grants `roles/storage.objectViewer` to `command-runner`. It grants the release identity bucket/object viewer access only on this bucket so it can preflight metadata; it has no write access to the Seed object. Initial bootstrap keeps all AI flags off and does not change Cloud Scheduler. Production research releases use `ops/cloudbuild-research.yaml`; that trigger preflights the Seed object and runtime permissions, then updates only `zioncore-command-research`. It does not change the existing 00:05 UTC schedule. Its final `seed-check` execution verifies the read-only mount and exits without calling a provider.

## Reusable knowledge and AI-free replay

The first retained capabilities are an allowlisted SHA-256 continuity method and a versioned indexed-lookup update. Their definitions, method checksums, supporting evidence, uncertainty, refresh dates and append-only pass/fail evaluation histories live in SQLite for preview or the dedicated `commandKnowledge` collection in Firestore. Run completion records the method result and reusable knowledge together. Continuity is tested on fresh generated synthetic archive bytes; indexed lookup tests require equivalent outputs, fewer operations and rejection of a deliberately faulty candidate. Both require no provider and never read a visitor's files.

The `internal-replay` runner mode is blocked from production Firestore: replay it only on a disposable development copy with `pnpm --filter @workspace/api-server run runner internal-replay`. The mode reloads a stored, verified method and tries it on a fresh synthetic case while external AI is disabled. The normal 15-minute `scheduled` job also executes the same verified method and performs no model calls. If an accepted daily AI selection is stored and its Seed checksum matches `COMMAND_GENESIS_SHA256` on the scheduled job, that job additionally checks the versioned selection on fresh synthetic inventories without sending a model request. The scheduled job needs only the checksum, not the Seed or provider key. The selection chooses an already reviewed comparison implementation; it is not model-generated executable code or proof about a real archive.

The test suite proves first-run method recording, reload and successful AI-off replay, stable version/checksum, ledger entries, and an export/import into a newly created SQLite database. It also rejects a modified method and injected unsupported data. The `Evolution Speed` engine records its tested version, retains a faster equivalent implementation, and rejects a faulty candidate while retaining the baseline. Candidate source is a fixed, reviewed implementation selected through these measured tests; arbitrary model or suggestion code is never executed or written into production. Accepted production improvements are forward-only, independently verified changes; releasing arbitrary new source code is intentionally not delegated to the production job identity.

Visitor suggestions are kept in the private, short-lived inbox. Only the programme category is considered for research selection, and a new direction needs at least three suggestions; no submitted text or submitter information is added to the public results or knowledge export. No suggestion starts a job.

### Portable knowledge backups

From an environment already authorized to read the dedicated Command data store:

```bash
pnpm --filter @workspace/api-server run knowledge export ./command-knowledge.json
pnpm --filter @workspace/api-server run knowledge verify ./command-knowledge.json
```

Exports are created without overwriting an existing file and with restrictive local file permissions. The SHA-256 checksum detects accidental changes; it is not a cryptographic signature or proof of source authenticity. Restore **adds** verified, known-method entries to an empty or matching store; it never deletes records or overwrites conflicts. Review the manifest and restore only to a deliberately selected Command database:

```bash
COMMAND_KNOWLEDGE_RESTORE=1 pnpm --filter @workspace/api-server run knowledge restore ./command-knowledge.json
```

The public dashboard also provides a read-only download at `/api/command/knowledge/export`. It cannot import, trigger a job, or change a method. Treat downloaded archives as data; the verifier accepts only the explicit preservation method and its exact version and bytes. Keep backup copies in a private owner-controlled location. This portable archive contains knowledge only, not private suggestions, visitor data, secrets, or the Genesis Seed.

## Run the development build

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run runner preview
pnpm --filter @workspace/api-server run runner archive-exercise
```

Run the web and API previews with the project's existing run configuration. The runner and API share a local SQLite file in `.local/command`, not the production database. Run IDs distinguish preview, scheduled, daily review, and the isolated exercise. The archive exercise records a mismatch, checks an independent fixture mirror, stages and verifies a replacement, then verifies the final SHA-256. It never touches a real personal or cloud archive.

## Production plan and owner permissions

- Exact target: `gen-lang-client-0266144152` / `740460863819`, London `europe-west2`. `ops/cloud.sh inventory` is read-only and verifies both identifiers. No Firebase Authentication, Firebase Hosting, or Firebase project migration is needed.
- Firestore Native databases: `zioncore-command` for public projections, runner control, and budget records; `zioncore-command-inbox` for expiring submissions and the global intake limit. No default database is used or changed.
- Cloud Run web: `zioncore-command-public-web`, zero minimum, maximum three instances; only its website and allowlisted feed are public. Suggestions are inert private inbox entries, never job instructions. Cloud Run Jobs: `zioncore-command-ops` (every 15 minutes) and `zioncore-command-research` (00:05 UTC daily). Cloud Scheduler has invoke permission scoped to just those jobs. The one-off archive exercise is not any job's scheduled command.
- `command-web` reads the results database and writes only in the separate intake database. `command-runner` writes Command records and triages research suggestions. The Cloud Build trigger uses `command-builder`, which needs Artifact Registry write access, access to inspect the dedicated Seed bucket and provider-key secret IAM policy, permission to update and run only the research job, and `iam.serviceAccounts.actAs` on `command-runner`. `command-runner` needs `roles/storage.objectViewer` on the Seed bucket and `roles/secretmanager.secretAccessor` on the provider-key secret. The GitHub `command-release` workflow is read-only and does not deploy.
- Bootstrap operator needs project and billing visibility, API enablement, creation and IAM-binding permissions for project IAM, service accounts and WIF, Firestore, Cloud Run, Scheduler, Cloud Build, Storage and Artifact Registry. In projects with organization policy, the administrator must allow public Cloud Run access and GitHub WIF. The script prints its plan and asks for `DEPLOY COMMAND` before changes; keep [the exact Cloud Shell project](https://console.cloud.google.com/cloudshell/editor?project=gen-lang-client-0266144152) selected. If IAM federation is not permitted, set `COMMAND_SKIP_FEDERATION=1` during bootstrap, then use the same pinned source and authenticated Cloud Shell for reviewed updates.
- After the Seed bucket and provider-key secret exist, run `bash ops/prepare-cloudbuild-research.sh` from an owner-authorized Cloud Shell. It grants only the build identity's scoped permissions on the research job, runtime identity, Seed bucket, and secret metadata. Then create the production Cloud Build trigger from `tariromasawi/zioncore-command-interface`, branch filter `^release/command-public-rebuild$`, config path **`ops/cloudbuild-research.yaml`**, and service account `command-builder@gen-lang-client-0266144152.iam.gserviceaccount.com`. The trigger tags and pushes the commit image, resolves its published digest, and updates only the research job. The GitHub [read-only diagnostic](https://github.com/tariromasawi/zioncore-command-interface/actions/workflows/command-deploy.yml) is not a deployment path. Changes to the published site are not tied to traffic or a browser tab.
- The owner should inspect inventory output for an earlier forced exercise schedule. This script will not switch off or alter an unrecognized schedule. After confirming its purpose and ownership, pause it in [Cloud Scheduler](https://console.cloud.google.com/cloudscheduler?project=gen-lang-client-0266144152) before using live maintenance.

Estimated infrastructure planning envelope: **US$4–10/month** for the two jobs at one minimum billed minute per execution, modest web traffic and short logs, excluding AI, regional price changes, build minutes, egress, tax, and unrelated project usage. The 15-minute schedule creates roughly 2,880 executions in 30 days plus 30 daily reviews. Add a billing alert and review actual spend before increasing cadence. The estimate is not a measured bill.

## Production budget and AI activation

**Launch record:** Command's first verified scheduled production run completed on **2026-11-20**. The owner has designated November 2026, December 2026, and January 2027 as billing months 1–3. The £20 combined target begins **2027-02-01 at 12 AM Pacific Time (08:00 UTC)**. The infrastructure estimate below is **US$4–10/month**, not a measured production bill; it excludes build minutes, egress, tax, regional changes, and unrelated project use.

Planned combined limits for project `gen-lang-client-0266144152`:

| Period | Combined infrastructure + paid AI | Initial allocation |
| --- | ---: | --- |
| Billing months 1–3 | US$50 per month | Reserve US$15 for Cloud Run, Firestore, Scheduler, storage, and a margin; retain US$5 contingency; cap paid AI at US$30/month. Reduce the AI cap dollar-for-dollar if measured infrastructure exceeds its reserve. |
| Billing month 4 onward, from 2027-02-01 | £20 per month | First reserve the prior month's measured infrastructure cost plus 25%; only the remaining GBP allowance can fund research. Convert that remainder to USD using the documented account-billing conversion on the change date. If infrastructure and margin use the full £20, paid AI stays at zero. |

Cloud Billing budgets are alerts unless a separately supported spend-cap feature is deliberately configured; an alert alone does **not** stop Cloud Run or other charges. The ledger has separate monthly and per-daily-slot reservation limits, including count requests and retries; timeouts and ambiguous replies retain their reservations. Settled usage is an estimate, not an invoice, and these controls do not cap cloud infrastructure. The ledger now uses Pacific time including daylight saving; historical entries placed in the wrong month by the former fixed UTC−8 calculation are not migrated and require reconciliation.

The Cloud Build research release sets `COMMAND_ENABLE_GENESIS_AI=1`, `COMMAND_ENABLE_DAILY_GENESIS=1`, and `COMMAND_ENABLE_PAID_AI=1`, but only after the approved read-only Seed object, secret version, and runtime IAM bindings pass preflight. It uses `gemini-3.5-flash-lite`, a 1,048,576-token context, a 256-token billed-output ceiling, and rates of US$0.30 per million input tokens and US$2.50 per million output tokens (including thinking tokens), as listed in the [official pricing table](https://ai.google.dev/gemini-api/docs/pricing) and [model specification](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), reviewed 2026-11-21. The monthly paid-AI cap is US$30 (30,000,000 micros); the per-run cap is US$9 (9,000,000 micros). At full context the conservative reservation is 2,936,013 micros per request; US$9 covers the count request and two generation attempts. The code rejects a cap above the approved US$30 monthly allowance and stops paid requests after January 2027. From 2027-02-01, paid AI stays off until the prior month's measured infrastructure cost, 25% reserve, and billing-currency conversion are verified and a new allowance is configured. The non-AI scheduled work remains independent of this AI gate.

The application reserves budget before token counting and every generation retry, checks the persistent monthly and per-run limits under concurrency, and retains uncertain charges. Settled model usage is an estimate, not a provider invoice. Cloud Build does not read or log the provider-key value and does not perform a paid request during deployment.

To set the project-scoped billing alert on an iPhone, open [Budgets & alerts for the project](https://console.cloud.google.com/billing/budgets?project=gen-lang-client-0266144152), choose **Create budget → Alerts only**, and confirm the project filter is exactly `gen-lang-client-0266144152`. Google Cloud uses the linked billing account's currency, and recurring monthly budgets reset on calendar-month boundaries. The requested USD 50 monthly amount for November, December, and January is exact only if that account bills in USD; if it bills in GBP, record the account's displayed USD/GBP conversion rate and date before entering the equivalent. Likewise, the exact billing-currency equivalent of £20 for February must be calculated on the February change date if the account bills in USD. The billing-account currency and measured infrastructure charges were not accessible in this release; **do not set a February paid-AI allowance until the January infrastructure bill is verified and the 25% reserve is calculated**. The standard monthly budget does not perform a future amount change automatically, so update the alert on 2027-02-01 and record the conversion. Review the actual bill before lowering any reserve.

Owner-controlled prerequisites for a bounded live test:

1. Run `bash ops/prepare-genesis-seed.sh` from an owner-authorized Cloud Shell. It fetches the pinned file itself, verifies its versioned bytes, prepares the private bucket and grants read-only object access to `command-runner`.
2. Create an enabled version of `zioncore-command-ai-provider-key` in [Secret Manager](https://console.cloud.google.com/security/secret-manager?project=gen-lang-client-0266144152), and grant `roles/secretmanager.secretAccessor` on that one secret to `command-runner`. The Cloud Build preflight checks the binding without reading the secret value; its final `seed-check` execution makes no provider calls.
3. Run `bash ops/prepare-cloudbuild-research.sh` from an owner-authorized Cloud Shell, then create the Cloud Build trigger with the exact repo, branch, config path, and service account listed above. If the trigger cannot inspect Artifact Registry, Seed metadata, or the two runtime IAM policies, or cannot update/run the named job as `command-runner`, it fails before changing the job. The selected model, rates, context, and budget are pinned in the release config rather than editable substitutions.

The knowledge page reports paid-AI usage in USD, the configured AI-only monthly cap, accepted requests, ambiguous reservations, internal mission completions, and paid calls avoided. Cloud infrastructure actuals remain in Google Cloud Billing and are not represented as zero in this feed. Lower future budgets only after reconciled invoices show the core missions meeting the same verification standard with less paid AI.

The Seed never grants permissions. Workers execute pre-reviewed deterministic operations. Model output is not published verbatim or executed. ZionCore Command changes are forward-only and must pass independent checks before acceptance. Faulty candidates are rejected before acceptance; accepted changes remain in place, and any later improvement must be another reviewed forward-only change.

## Verify the actual release

1. Use the service URL printed by Cloud Run, not a guessed host. Verify anonymous `/`, `/command.html`, `/research`, `/genesis`, `/continuity`, `/runs`, `/api/command/feed`, and all engine detail routes. No route starts or changes infrastructure. Verify feed and suggestion CORS from exactly `https://tariromasawi.github.io`; confirm that suggestion text and resource URLs never appear in the public feed.
2. Let the actual Cloud Scheduler trigger the first operational job. Check the Cloud Scheduler log and Cloud Run job execution, then correlate its time with the `scheduled-…` identifier and outcomes in the public run history. Wait for the daily review to verify its own `daily-…` slot.
3. Run the synthetic exercise on an isolated non-production store or a separately authorized test execution, never by editing the operation schedule. Verify the mismatch and restoration hashes and repeat the invocation to check that it is skipped.
4. Deploy the same code from another Cloud Run revision and compare the exact prior scheduled run ID and `finishedAt`. Do not claim production persistence or IAM verification until these checks pass using the actual runtime identities.
5. Export knowledge, restore it into a clean isolated Command database, verify the manifest, and run the same internal replay there. Do not restore into production until the project, database, backup checksum and intended additive operation are reviewed.
6. After verifying the URL and feed, set `url` in `command-live.json` on the Pages publishing branch in a reviewed PR. The legacy landing address and `/command.html` then both link to Cloud Run, and Pages Command displays the live public results. Until that configuration is verified and merged, both Pages URLs remain available but are not live feed links.
