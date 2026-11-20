# ZionCore Command

ZionCore Command is the standalone, public evidence dashboard for mission outcomes, operational engines and research programmes. It is not the ZionCore 1 or ZionCore 2nd project.

- Web: `artifacts/zioncore-command` (React and Vite).
- Public API and independent runner: `artifacts/api-server`; Command code is in `src/command`.
- Contract: `lib/api-spec/openapi.yaml`; regenerate with `pnpm --filter @workspace/api-spec run codegen`.
- Preview uses SQLite, never production records. Start the existing API and web workflows. Build the runner with `pnpm --filter @workspace/api-server run build`, then run `pnpm --filter @workspace/api-server run runner preview` to record a real local cycle.
- Checks: `pnpm run typecheck`; `pnpm --filter @workspace/api-server run test`.
- Production is Google Cloud project `gen-lang-client-0266144152` (project number `740460863819`) in `europe-west2`. The production deployment and pinned owner bootstrap are documented in `docs/COMMAND_RELEASE.md`; do not substitute a Replit Publish for the requested Cloud Run deployment.
- The public feed permits approved report fields, not unrestricted storage access. Suggestions are private, neither commands nor job triggers. Keep synthetic runs, receipts, forecasts, published research and verified production events distinguishable.
- Do not publish the full Genesis Seed without the owner's explicit release designation. Do not send a wrapper or excerpt in place of the approved original. Do not log the text or credentials.
