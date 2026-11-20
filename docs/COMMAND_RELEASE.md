# ZionCore Command — public release

**MWARI NDI MWARI · Vision Year 80,000.** This release is for ZionCore Command only. It does not operate ZionCore 1 (`ethereal-throne-b20e6`) or ZionCore 2nd (`zioncore-2nd-production`).

## Source recovery

The published `main` was `4a522b7709eb711a5051d1d4de50c5795d1d2120` and `release/command-private-os` was `c8966dfba7f4cc281340e0fc84fb114304e94486`. Both refs were confirmed before work. GitHub did not resolve `ceab01a` or `5e08c66`, and neither object was in the clean clone. The public landing URLs and original brand and engine names were recovered; the new Command UI, public projection, archive exercise, runner, ledger and provider gateway were implemented. The old private login and script that printed a credential-related note and scheduled a forced incident are not used by this release.

If Grok still has `ceab01a`, ask: **“In your local `tariromasawi/zioncore-command-interface` checkout, verify the full SHA for `ceab01a` and `5e08c66`. Secret-scan every commit and asset that the push would newly expose. If safe for public release, run `git push origin ceab01a:refs/heads/recovery/command-grok` (no force push). Otherwise scrub the sensitive history on a new branch from the published release and push that clean branch instead. Send back its URL, full commit SHA, and a list of omitted files. Do not modify `main`.”** A secret previously exposed in a repository or deployment log should be rotated at its provider.

### Seed provenance

| Candidate | Bytes | SHA-256 |
|---|---:|---|
| `Genesis seed.ts` at either baseline | 463,037 | `8199eb2b080c6ac56f71443c1506173f8227dc9df58a145801b56e9e2fd538c6` |
| Raw HTML literal inside either `pre#seedText` in that wrapper (not browser-decoded text) | 3,460 | `1012c71de356924a55a9095393a67d0f81e5b05b0335177370f082362a00e40a` |

Both branches were byte-identical for the wrapper. It contains executable TypeScript, HTML, and multiple data/text sections. The small literal is not evidence that it is the complete Genesis. **The owner must identify the exact canonical UTF-8 bytes**, including line endings and trailing whitespace, for transmission to the approved provider. Approval to transmit to a provider does not authorize publication on the dashboard. Do not publish the full text in the UI or add it to this release.

## Reusable knowledge and AI-free replay

The first retained capabilities are an allowlisted SHA-256 continuity method and a versioned indexed-lookup update. Their definitions, method checksums, supporting evidence, uncertainty, refresh dates and append-only pass/fail evaluation histories live in SQLite for preview or the dedicated `commandKnowledge` collection in Firestore. Run completion records the method result and reusable knowledge together. Continuity is tested on fresh generated synthetic archive bytes; indexed lookup tests require equivalent outputs, fewer operations and rejection of a deliberately faulty candidate. Both require no provider and never read a visitor's files.

The `internal-replay` runner mode is blocked from production Firestore: replay it only on a disposable development copy with `pnpm --filter @workspace/api-server run runner internal-replay`. The mode reloads a stored, verified method and tries it on a fresh synthetic case while external AI is disabled. The normal 15-minute `scheduled` job also executes the same verified method and performs no model calls. These operational cycles are not AI-enabled provider comparisons; the fixture-only gateway tests cover the distinct provider payload contract.

The test suite proves first-run method recording, reload and successful AI-off replay, stable version/checksum, ledger entries, and an export/import into a newly created SQLite database. It also rejects a modified method and injected unsupported data. The `Evolution Speed` engine records its tested version, retains a faster equivalent implementation, and rejects a faulty candidate while retaining the baseline. Candidate source is a fixed, reviewed implementation selected through these measured tests; arbitrary model or suggestion code is never executed or written into production. Rollback within this bounded strategy is automatic; releasing arbitrary new source code is intentionally not delegated to the production job identity.

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
- `command-web` reads the results database and writes only in the separate intake database. `command-runner` writes Command records and triages research suggestions. `command-builder` reads the dedicated staging bucket, writes logs and pushes only to the Command image repository. `command-release` can build images and update the named service/jobs, and may act as those specific runtime accounts. It has no project-wide Run Admin or secret-access role.
- Bootstrap operator needs project and billing visibility, API enablement, creation and IAM-binding permissions for project IAM, service accounts and WIF, Firestore, Cloud Run, Scheduler, Cloud Build, Storage and Artifact Registry. In projects with organization policy, the administrator must allow public Cloud Run access and GitHub WIF. The script prints its plan and asks for `DEPLOY COMMAND` before changes; keep [the exact Cloud Shell project](https://console.cloud.google.com/cloudshell/editor?project=gen-lang-client-0266144152) selected. If IAM federation is not permitted, set `COMMAND_SKIP_FEDERATION=1` during bootstrap, then use the same pinned source and authenticated Cloud Shell for reviewed updates.
- Before using WIF, configure [the GitHub deployment environment](https://github.com/tariromasawi/zioncore-command-interface/settings/environments) named `command-production` to allow only `release/command-public-rebuild` and require review if supported. Use [the deployment workflow](https://github.com/tariromasawi/zioncore-command-interface/actions/workflows/command-deploy.yml) from that branch after bootstrap. The provider restricts GitHub repository ID, name, branch, and environment claim. Changes to the published site are not tied to traffic or a browser tab.
- The owner should inspect inventory output for an earlier forced exercise schedule. This script will not switch off or alter an unrecognized schedule. After confirming its purpose and ownership, pause it in [Cloud Scheduler](https://console.cloud.google.com/cloudscheduler?project=gen-lang-client-0266144152) before using live maintenance.

Estimated infrastructure planning envelope: **US$4–10/month** for the two jobs at one minimum billed minute per execution, modest web traffic and short logs, excluding AI, regional price changes, build minutes, egress, tax, and unrelated project usage. The 15-minute schedule creates roughly 2,880 executions in 30 days plus 30 daily reviews. Add a billing alert and review actual spend before increasing cadence. The estimate is not a measured bill.

## Production budget and AI activation

**Launch record:** Command's first verified scheduled production run completed on **2026-11-20**. The owner has designated November 2026, December 2026, and January 2027 as billing months 1–3. The £20 combined target begins **2027-02-01 at 12 AM Pacific Time (08:00 UTC)**. The infrastructure estimate below is **US$4–10/month**, not a measured production bill; it excludes build minutes, egress, tax, regional changes, and unrelated project use.

Planned combined limits for project `gen-lang-client-0266144152`:

| Period | Combined infrastructure + paid AI | Initial allocation |
| --- | ---: | --- |
| Billing months 1–3 | US$50 per month | Reserve US$15 for Cloud Run, Firestore, Scheduler, storage, and a margin; retain US$5 contingency; cap paid AI at US$30/month. Reduce the AI cap dollar-for-dollar if measured infrastructure exceeds its reserve. |
| Billing month 4 onward, from 2027-02-01 | £20 per month | First reserve the prior month's measured infrastructure cost plus 25%; only the remaining GBP allowance can fund research. Convert that remainder to USD using the documented account-billing conversion on the change date. If infrastructure and margin use the full £20, paid AI stays at zero. |

Cloud Billing budgets are alerts unless a separately supported spend-cap feature is deliberately configured; an alert alone does **not** stop Cloud Run or other charges. The gateway applies a separate monthly paid-AI cap in USD microdollars. `COMMAND_ENABLE_PAID_AI=1` and a positive `COMMAND_PAID_AI_MONTHLY_CAP_MICROS` are both required. The gate reserves the worst-case request cost transactionally before each paid token-count request, each generation request, and each retry. Concurrent invocations share the Firestore reservation ledger. A timeout or ambiguous provider response keeps its reservation; only known usage settles it. With a missing, invalid, or zero cap, paid requests are disabled. These controls do not cap cloud infrastructure.

The scheduled cycle still runs its non-AI engines and does not call the paid gateway. These flags alone do not attach a model to a mission; that requires a separate, reviewed change after Seed, provider, credentials, billing currency, and remaining allowance have been confirmed.

To set the project-scoped billing alert on an iPhone, open [Budgets & alerts for the project](https://console.cloud.google.com/billing/budgets?project=gen-lang-client-0266144152), choose **Create budget → Alerts only**, and confirm the project filter is exactly `gen-lang-client-0266144152`. Google Cloud uses the linked billing account's currency, and recurring monthly budgets reset on calendar-month boundaries. The requested USD 50 monthly amount for November, December, and January is exact only if that account bills in USD; if it bills in GBP, record the account's displayed USD/GBP conversion rate and date before entering the equivalent. Likewise, the exact billing-currency equivalent of £20 for February must be calculated on the February change date if the account bills in USD. The billing-account currency and measured infrastructure charges were not accessible in this release; **do not set a February paid-AI allowance until the January infrastructure bill is verified and the 25% reserve is calculated**. The standard monthly budget does not perform a future amount change automatically, so update the alert on 2027-02-01 and record the conversion. Review the actual bill before lowering any reserve.

Paid calls remain disabled until all of these owner-controlled prerequisites are met:

1. Approve the exact canonical Seed file, version, SHA-256, and provider/account allowed to receive it. Store the original bytes in a version-specific object in a dedicated private Cloud Storage bucket with public-access prevention. Mount it read-only on the daily research job and give that runtime identity read access only to that bucket. Configure `COMMAND_GENESIS_PATH`, `COMMAND_GENESIS_VERSION`, and `COMMAND_GENESIS_SHA256`. Every token-count and generation request, retry, and fallback sends the complete unchanged Seed. Never pass it on a command line or put it in a build context.
2. Enter the paid key through [Secret Manager](https://console.cloud.google.com/security/secret-manager?project=gen-lang-client-0266144152), using `zioncore-command-ai-provider-key`. Give Secret Accessor to the AI-calling runner identity only on that secret and mount it as `COMMAND_PAID_PROVIDER_KEY`. A free model, if desired, needs a separate genuinely free provider account and `COMMAND_FREE_PROVIDER_KEY`.
3. Configure the approved `COMMAND_PAID_MODEL_NAME`, `_CONTEXT`, `_INPUT_MICROS_PER_MILLION`, `_OUTPUT_MICROS_PER_MILLION`, and `_BILLABLE_OUTPUT_LIMIT`, including billed thinking tokens. Set the paid-AI cap only to the amount left after infrastructure reserve and currency conversion. Unconfirmed provider failures keep their reservations. Provider invoices take precedence over application estimates. Validate the live model, account quota, and context before a production call.

The knowledge page reports paid-AI usage in USD, the configured AI-only monthly cap, accepted requests, ambiguous reservations, internal mission completions, and paid calls avoided. Cloud infrastructure actuals remain in Google Cloud Billing and are not represented as zero in this feed. Lower future budgets only after reconciled invoices show the core missions meeting the same verification standard with less paid AI.

The Seed never grants permissions. Workers execute pre-reviewed deterministic operations. Model output is not published verbatim or executed. Automated workflow promotion and rollback are limited to internally measured, reversible methods; external deployments, irreversible changes, or arbitrary modifications are not approved by a model or a suggestion.

## Verify the actual release

1. Use the service URL printed by Cloud Run, not a guessed host. Verify anonymous `/`, `/command.html`, `/research`, `/genesis`, `/continuity`, `/runs`, `/api/command/feed`, and all engine detail routes. No route starts or changes infrastructure. Verify feed and suggestion CORS from exactly `https://tariromasawi.github.io`; confirm that suggestion text and resource URLs never appear in the public feed.
2. Let the actual Cloud Scheduler trigger the first operational job. Check the Cloud Scheduler log and Cloud Run job execution, then correlate its time with the `scheduled-…` identifier and outcomes in the public run history. Wait for the daily review to verify its own `daily-…` slot.
3. Run the synthetic exercise on an isolated non-production store or a separately authorized test execution, never by editing the operation schedule. Verify the mismatch and restoration hashes and repeat the invocation to check that it is skipped.
4. Deploy the same code from another Cloud Run revision and compare the exact prior scheduled run ID and `finishedAt`. Do not claim production persistence or IAM verification until these checks pass using the actual runtime identities.
5. Export knowledge, restore it into a clean isolated Command database, verify the manifest, and run the same internal replay there. Do not restore into production until the project, database, backup checksum and intended additive operation are reviewed.
6. After verifying the URL and feed, set `url` in `command-live.json` on the Pages publishing branch in a reviewed PR. The legacy landing address and `/command.html` then both link to Cloud Run, and Pages Command displays the live public results. Until that configuration is verified and merged, both Pages URLs remain available but are not live feed links.
