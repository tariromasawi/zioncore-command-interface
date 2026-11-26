#!/usr/bin/env bash
# Owner bootstrap for this project only. No credential values are read or emitted.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT=gen-lang-client-0266144152
NUMBER=740460863819
REGION=europe-west2
REPO=tariromasawi/zioncore-command-interface
BRANCH=release/command-public-rebuild
REPOSITORY=command-public-images
BUCKET="command-build-source-$NUMBER"
DB=zioncore-command
INBOX=zioncore-command-inbox
WEB=zioncore-command-public-web
RUNNER=zioncore-command-ops
DAILY=zioncore-command-research
POOL=command-github
PROVIDER=command-release
SA_SUFFIX="@$PROJECT.iam.gserviceaccount.com"
APIS=(run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com)
g() { gcloud "$@" --project="$PROJECT" --quiet; }
die() { printf '%s\n' "$*" >&2; exit 1; }
mode=${1:-inventory}
commit=${2:-}

verify_project() {
  [[ "$(g projects describe "$PROJECT" --format='value(projectId)')" == "$PROJECT" &&
     "$(g projects describe "$PROJECT" --format='value(projectNumber)')" == "$NUMBER" ]] ||
    die "Project identity could not be verified; nothing changed."
}

inventory() {
  echo "--- Billing ---"
  g billing projects describe "$PROJECT" --format='table(projectId,billingEnabled)' || true
  echo "--- Enabled services (Firebase status is visible here; no Firebase project changes) ---"
  g services list --enabled --format='value(config.name)'
  echo "--- Firestore databases ---"
  g firestore databases list --format='table(name,locationId,type,deleteProtectionState)' || true
  echo "--- Cloud Run services and jobs in London ---"
  g run services list --region="$REGION" --format='table(metadata.name,status.url)' || true
  g run jobs list --region="$REGION" --format='table(metadata.name)' || true
  echo "--- Cloud Scheduler in London, bucket names, service identities and secret names ---"
  g scheduler jobs list --location="$REGION" --format='table(name,state,schedule,timeZone)' || true
  g storage buckets list --format='value(name)' || true
  g iam service-accounts list --format='table(email,displayName)' || true
  g secrets list --format='value(name)' || true
}

managed_run_resource() {
  local kind=$1 name=$2 found
  found="$(g run "$kind" describe "$name" --region="$REGION" --format='value(metadata.name)' 2>/dev/null || true)"
  if [[ "$mode" == deploy && "$found" != "$name" ]]; then
    die "Expected managed resource $kind/$name does not exist or is inaccessible."
  fi
  if [[ "$found" == "$name" ]]; then
    [[ "$(g run "$kind" describe "$name" --region="$REGION" --format='value(metadata.labels.zioncore-command)')" == public-release ]] ||
      die "$kind/$name exists without the Command release label; refusing to overwrite it."
  fi
}

ensure_database() {
  local name=$1 present
  present="$(g firestore databases list --format='value(name)' | grep -Fx "projects/$PROJECT/databases/$name" || true)"
  if [[ -z "$present" ]]; then
    g firestore databases create --database="$name" --location="$REGION" --type=firestore-native --delete-protection
  fi
  [[ "$(g firestore databases describe --database="$name" --format='value(locationId)')" == "$REGION" &&
     "$(g firestore databases describe --database="$name" --format='value(type)')" == FIRESTORE_NATIVE ]] ||
    die "$name exists but is not Firestore Native in $REGION. Existing database left unchanged."
}

ensure_account() {
  local account=$1
  if ! g iam service-accounts describe "$account$SA_SUFFIX" --format='value(email)' >/dev/null 2>&1; then
    g iam service-accounts create "$account" --display-name="ZionCore Command ($account)"
  fi
  [[ "$(g iam service-accounts describe "$account$SA_SUFFIX" --format='value(displayName)')" == "ZionCore Command ($account)" ]] ||
    die "$account exists without the Command release identity marker."
}

database_access() {
  local account=$1 database=$2 role=$3
  g projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$account$SA_SUFFIX" --role="$role" \
    --condition="title=command-$database,expression=resource.name == 'projects/$PROJECT/databases/$database'"
}

stage_release() {
  local image="$REGION-docker.pkg.dev/$PROJECT/$REPOSITORY/command:$commit" digest command_image
  digest="$(g artifacts docker images describe "$image" --format='value(image_summary.digest)' 2>/dev/null || true)"
  if [[ -z "$digest" ]]; then
    g builds submit . --region="$REGION" --config=ops/cloudbuild.yaml \
      --service-account="projects/$PROJECT/serviceAccounts/command-builder$SA_SUFFIX" \
      --gcs-source-staging-dir="gs://$BUCKET/source" --substitutions="_IMAGE=$image"
    digest="$(g artifacts docker images describe "$image" --format='value(image_summary.digest)')"
  fi
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die "No verified image digest."
  command_image="${image%:*}@$digest"
  local public=()
  # On the first deployment the owner makes only the web service public.
  if [[ "$mode" == bootstrap ]]; then public=(--no-invoker-iam-check); fi
  g run deploy "$WEB" --region="$REGION" --image="$command_image" --service-account="command-web$SA_SUFFIX" \
    --min=0 --max=3 --concurrency=40 --timeout=20s --memory=512Mi --cpu=1 --port=8080 \
    --labels="zioncore-command=public-release,commit=$commit" "${public[@]}" \
    --update-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,COMMAND_STORE=firestore,FIRESTORE_DATABASE=$DB,COMMAND_ENABLE_INTAKE=1"
  local name command
  for name in "$RUNNER" "$DAILY"; do
    command=scheduled; [[ "$name" == "$DAILY" ]] && command=daily-review
    g run jobs deploy "$name" --region="$REGION" --image="$command_image" --service-account="command-runner$SA_SUFFIX" \
      --command=node --args="dist/jobMain.mjs,$command" --task-timeout=180s --max-retries=1 \
      --tasks=1 --parallelism=1 --cpu=1 --memory=512Mi \
      --labels="zioncore-command=public-release,commit=$commit" \
      --update-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,COMMAND_STORE=firestore,FIRESTORE_DATABASE=$DB"
  done
  local url
  url="$(g run services describe "$WEB" --region="$REGION" --format='value(status.url)')"
  [[ "$url" == https://*.run.app ]] || die "Cloud Run did not return its public URL."
  printf 'Cloud Run: %s\nCommit: %s\nImage: %s\n' "$url" "$commit" "$command_image"
  curl --retry 6 --retry-all-errors --retry-delay 3 --fail-with-body --silent --show-error "$url/api/command/feed" |
    jq -e '{state, engines:(.engines|length), cadence, nextExpected} | select(.engines==14)'
}

configure_schedule() {
  local name=$1 cron=$2 endpoint="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$1:run"
  local marker="Managed ZionCore Command public release"
  local args=(--location="$REGION" --description="$marker" --schedule="$cron" --time-zone=Etc/UTC
    --uri="$endpoint" --http-method=POST --oauth-service-account-email="command-scheduler$SA_SUFFIX"
    --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform --attempt-deadline=30s --max-retry-attempts=0)
  local found
  found="$(g scheduler jobs list --location="$REGION" --filter="name:/$name" --format='value(name)' )"
  if [[ "$found" == */"$name" ]]; then
    [[ "$(g scheduler jobs describe "$name" --location="$REGION" --format='value(description)')" == "$marker" ]] ||
      die "Scheduler job $name exists without the Command release marker."
    g scheduler jobs update http "$name" "${args[@]}"
  else
    g scheduler jobs create http "$name" "${args[@]}"
  fi
}

configure_federation() {
  local issuer=https://token.actions.githubusercontent.com
  local name="projects/$NUMBER/locations/global/workloadIdentityPools/$POOL"
  local title="ZionCore Command reviewed releases"
  local cond="assertion.repository_id == '1379724220' && assertion.repository == '$REPO' && assertion.ref == 'refs/heads/$BRANCH' && assertion.environment == 'command-production'"
  local mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id"
  if ! g iam workload-identity-pools describe "$POOL" --location=global --format='value(name)' >/dev/null 2>&1; then
    g iam workload-identity-pools create "$POOL" --location=global --display-name="$title"
  fi
  [[ "$(g iam workload-identity-pools describe "$POOL" --location=global --format='value(displayName)')" == "$title" ]] ||
    die "Existing WIF pool does not belong to this release."
  if ! g iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool="$POOL" --location=global --format='value(name)' >/dev/null 2>&1; then
    g iam workload-identity-pools providers create-oidc "$PROVIDER" --workload-identity-pool="$POOL" --location=global \
      --issuer-uri="$issuer" --attribute-mapping="$mapping" --attribute-condition="$cond"
  fi
  [[ "$(g iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool="$POOL" --location=global --format='value(attributeCondition)')" == "$cond" &&
     "$(g iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool="$POOL" --location=global --format='value(oidc.issuerUri)')" == "$issuer" ]] ||
    die "Existing WIF provider has unexpected trust; leaving it intact."
  g iam service-accounts add-iam-policy-binding "command-release$SA_SUFFIX" --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/$name/attribute.repository_id/1379724220"
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:command-release$SA_SUFFIX" --role=roles/cloudbuild.builds.editor --condition=None
  g storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:command-release$SA_SUFFIX" --role=roles/storage.objectUser
  g artifacts repositories add-iam-policy-binding "$REPOSITORY" --location="$REGION" --member="serviceAccount:command-release$SA_SUFFIX" --role=roles/artifactregistry.reader
  for account in command-builder command-web command-runner; do
    g iam service-accounts add-iam-policy-binding "$account$SA_SUFFIX" --member="serviceAccount:command-release$SA_SUFFIX" --role=roles/iam.serviceAccountUser
  done
  g run services add-iam-policy-binding "$WEB" --region="$REGION" --member="serviceAccount:command-release$SA_SUFFIX" --role=roles/run.developer
  for job in "$RUNNER" "$DAILY"; do
    g run jobs add-iam-policy-binding "$job" --region="$REGION" --member="serviceAccount:command-release$SA_SUFFIX" --role=roles/run.developer
  done
}

case "$mode" in
  inventory)
    verify_project; inventory; exit ;;
  bootstrap|deploy) ;;
  *) die "Usage: bash ops/cloud.sh inventory | bootstrap COMMIT | deploy COMMIT" ;;
esac
[[ "$commit" =~ ^[a-f0-9]{40}$ && "$(git rev-parse HEAD)" == "$commit" && -z "$(git status --porcelain)" ]] ||
  die "Use a clean checkout at the exact reviewed 40-character commit."
verify_project

if [[ "$mode" == bootstrap ]]; then
  inventory
  billing="$(g billing projects describe "$PROJECT" --format='value(billingEnabled)')"
  [[ "${billing,,}" == true ]] ||
    die "Active billing could not be verified."
  cat <<PLAN
Plan: use only $PROJECT ($NUMBER), $REGION. Enable required APIs; create or reuse dedicated
Command Firestore databases, service accounts, build bucket and registry; build $commit;
deploy $WEB and two private scheduled jobs; configure job-scoped invokers and reviewed GitHub federation.
No credentials will be read; no existing non-Command databases, schedulers or applications will be changed.
PLAN
  read -r -p "Type DEPLOY COMMAND to confirm: " confirmation
  [[ "$confirmation" == "DEPLOY COMMAND" ]] || die "Stopped before making changes."
  g services enable "${APIS[@]}"
fi

managed_run_resource services "$WEB"
managed_run_resource jobs "$RUNNER"
managed_run_resource jobs "$DAILY"

if [[ "$mode" == bootstrap ]]; then
  ensure_database "$DB"
  ensure_database "$INBOX"
  g firestore fields ttls update expiresAt --collection-group=commandInbox --database="$INBOX" --enable-ttl --async
  for sa in command-web command-runner command-builder command-scheduler command-release; do ensure_account "$sa"; done
  database_access command-web "$DB" roles/datastore.viewer
  database_access command-web "$INBOX" roles/datastore.user
  database_access command-runner "$INBOX" roles/datastore.user
  database_access command-runner "$DB" roles/datastore.user
  if ! g artifacts repositories describe "$REPOSITORY" --location="$REGION" --format='value(name)' >/dev/null 2>&1; then
    g artifacts repositories create "$REPOSITORY" --repository-format=docker --location="$REGION" \
      --description="ZionCore Command public release" --immutable-tags
  fi
  [[ "$(g artifacts repositories describe "$REPOSITORY" --location="$REGION" --format='value(description)')" == "ZionCore Command public release" ]] ||
    die "Existing image repository is not marked as Command-owned."
  if ! g storage buckets describe "gs://$BUCKET" --format='value(name)' >/dev/null 2>&1; then
    g storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
    g storage buckets update "gs://$BUCKET" --update-labels=zioncore-command=public-release
  fi
  [[ "$(g storage buckets describe "gs://$BUCKET" --format='value(labels.zioncore-command)')" == public-release ]] ||
    die "Existing build bucket is not marked as Command-owned."
  g storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:command-builder$SA_SUFFIX" --role=roles/storage.objectViewer
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:command-builder$SA_SUFFIX" --role=roles/logging.logWriter --condition=None
  g artifacts repositories add-iam-policy-binding "$REPOSITORY" --location="$REGION" --member="serviceAccount:command-builder$SA_SUFFIX" --role=roles/artifactregistry.writer
fi

stage_release
if [[ "$mode" == bootstrap ]]; then
  for job in "$RUNNER" "$DAILY"; do
    g run jobs add-iam-policy-binding "$job" --region="$REGION" --member="serviceAccount:command-scheduler$SA_SUFFIX" --role=roles/run.invoker
  done
  configure_schedule "$RUNNER" "*/15 * * * *"
  configure_schedule "$DAILY" "5 0 * * *"
  if [[ "${COMMAND_SKIP_FEDERATION:-0}" != 1 ]]; then configure_federation; fi
  echo "Wait for the actual scheduler before claiming scheduled-run verification. Do not force a fixture incident into the schedule."
fi
