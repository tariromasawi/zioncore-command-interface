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
GENESIS_BUCKET="zioncore-command-genesis-seed-$NUMBER"
KNOWLEDGE_BUCKET="zioncore-command-knowledge-$NUMBER"
GENESIS_OBJECT=approved/1.1.0/genesis-seed.ts
GENESIS_VERSION=1.1.0
GENESIS_SHA256=8199eb2b080c6ac56f71443c1506173f8227dc9df58a145801b56e9e2fd538c6
GENESIS_BYTES=463037
FIRESTORE_ROLE=ZionCoreCommandFirestoreWriter
FIRESTORE_ROLE_NAME="projects/$PROJECT/roles/$FIRESTORE_ROLE"
GENESIS_PATH="/mnt/genesis/$GENESIS_OBJECT"
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
  echo "--- Active Google identity ---"
  g auth list --filter=status:ACTIVE --format='value(account)'
  echo "--- Cloud Run research job in the approved project and region ---"
  g run jobs describe "$DAILY" --region="$REGION" --format=json |
    jq '{name:.metadata.name,labels:.metadata.labels,generation:.metadata.generation}'
}

verify_genesis_asset() {
  local bucket_json object_json
  if ! bucket_json="$(g storage buckets describe "gs://$GENESIS_BUCKET" --format=json)"; then
    die "Genesis Seed bucket gs://$GENESIS_BUCKET is unavailable. No Cloud Run changes were made."
  fi
  jq -e '.location|ascii_downcase=="europe-west2"' <<<"$bucket_json" >/dev/null ||
    die "Genesis Seed bucket must be in europe-west2."
  jq -e '.labels.zioncore-command=="public-release" and .labels.purpose=="genesis-seed"
    and .iamConfiguration.publicAccessPrevention=="enforced"
    and .iamConfiguration.uniformBucketLevelAccess.enabled==true' <<<"$bucket_json" >/dev/null ||
    die "Genesis Seed bucket must be Command-owned, private, and use uniform bucket-level access."
  if ! object_json="$(g storage objects describe "gs://$GENESIS_BUCKET/$GENESIS_OBJECT" --format=json)"; then
    die "Approved Genesis Seed object is missing from gs://$GENESIS_BUCKET/$GENESIS_OBJECT. No Cloud Run changes were made."
  fi
  jq -e --arg size "$GENESIS_BYTES" --arg version "$GENESIS_VERSION" --arg sha "$GENESIS_SHA256" \
    '.size|tostring==$size' <<<"$object_json" >/dev/null ||
    die "Genesis Seed object has the wrong size; no Cloud Run changes were made."
  jq -e --arg version "$GENESIS_VERSION" --arg sha "$GENESIS_SHA256" \
    '.metadata.version==$version and .metadata.sha256==$sha' <<<"$object_json" >/dev/null ||
    die "Genesis Seed object metadata does not match the approved version and checksum; no Cloud Run changes were made."
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
    --update-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,COMMAND_STORE=firestore,FIRESTORE_DATABASE=$DB,COMMAND_KNOWLEDGE_ARCHIVE_BUCKET=$KNOWLEDGE_BUCKET,COMMAND_ENABLE_INTAKE=1"
  g run jobs deploy "$RUNNER" --region="$REGION" --image="$command_image" --service-account="command-runner$SA_SUFFIX" \
    --command=node --args=dist/jobMain.mjs,scheduled --task-timeout=180s --max-retries=1 \
    --tasks=1 --parallelism=1 --cpu=1 --memory=512Mi \
    --labels="zioncore-command=public-release,commit=$commit" \
    --update-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,COMMAND_STORE=firestore,FIRESTORE_DATABASE=$DB,COMMAND_KNOWLEDGE_ARCHIVE_BUCKET=$KNOWLEDGE_BUCKET"
  if [[ "$mode" == bootstrap ]]; then
    g run jobs deploy "$DAILY" --region="$REGION" --image="$command_image" --service-account="command-runner$SA_SUFFIX" \
      --command=node --args=dist/jobMain.mjs,daily-review --task-timeout=180s --max-retries=1 \
      --tasks=1 --parallelism=1 --cpu=1 --memory=512Mi \
      --labels="zioncore-command=public-release,commit=$commit" \
      --update-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,COMMAND_STORE=firestore,FIRESTORE_DATABASE=$DB,COMMAND_KNOWLEDGE_ARCHIVE_BUCKET=$KNOWLEDGE_BUCKET,COMMAND_GENESIS_PATH=$GENESIS_PATH,COMMAND_GENESIS_VERSION=$GENESIS_VERSION,COMMAND_GENESIS_SHA256=$GENESIS_SHA256,COMMAND_ENABLE_GENESIS_AI=0,COMMAND_ENABLE_DAILY_GENESIS=0,COMMAND_ENABLE_PAID_AI=0,COMMAND_PAID_AI_MONTHLY_CAP_MICROS=0" \
      --add-volume="name=genesis-seed,type=cloud-storage,bucket=$GENESIS_BUCKET,readonly=true" \
      --add-volume-mount="volume=genesis-seed,mount-path=/mnt/genesis"
  else
    # Do not reset paid-AI gates, Secret Manager, or the read-only Seed mount on a routine image update.
    g run jobs update "$DAILY" --region="$REGION" --image="$command_image"
  fi
  local url
  url="$(g run services describe "$WEB" --region="$REGION" --format='value(status.url)')"
  [[ "$url" == https://*.run.app ]] || die "Cloud Run did not return its public URL."
  printf 'Cloud Run: %s\nCommit: %s\nImage: %s\n' "$url" "$commit" "$command_image"
  curl --retry 6 --retry-all-errors --retry-delay 3 --fail-with-body --silent --show-error "$url/api/command/feed" |
    jq -e '{state, engines:(.engines|length), cadence, nextExpected} | select(.engines==14)'
}

verify_seed_execution() {
  local output execution
  output="$(g run jobs execute "$DAILY" --region="$REGION" --args=dist/jobMain.mjs,seed-check --wait 2>&1)" ||
    { printf '%s\n' "$output" >&2; die "Read-only Genesis Seed mount check failed."; }
  printf '%s\n' "$output"
  execution="$(sed -n 's/^Execution \[\([^]]*\)\].*/\1/p' <<<"$output" | tail -1)"
  if [[ -z "$execution" ]]; then
    execution="$(g run jobs executions list --job="$DAILY" --region="$REGION" --sort-by='~metadata.createTime' --limit=1 --format='value(metadata.name)')"
  fi
  [[ -n "$execution" ]] || die "Seed mount check completed but its Cloud Run execution ID could not be read."
  printf 'Seed check execution: %s\n' "$execution"
  g run jobs executions describe "$execution" --region="$REGION" \
    --format='yaml(metadata.name,status.completionTime,status.conditions)'
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
  local title="ZionCore Command releases"
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

if [[ "$mode" == deploy ]]; then
  verify_genesis_asset
fi

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
  if g iam roles describe "$FIRESTORE_ROLE" >/dev/null 2>&1; then
    g iam roles update "$FIRESTORE_ROLE" --file=ops/roles/command-firestore-no-delete.json
  else
    g iam roles create "$FIRESTORE_ROLE" --file=ops/roles/command-firestore-no-delete.json
  fi
  database_access command-web "$INBOX" "$FIRESTORE_ROLE_NAME"
  database_access command-runner "$INBOX" "$FIRESTORE_ROLE_NAME"
  database_access command-runner "$DB" "$FIRESTORE_ROLE_NAME"
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
  if ! g storage buckets describe "gs://$KNOWLEDGE_BUCKET" --format='value(name)' >/dev/null 2>&1; then
    g storage buckets create "gs://$KNOWLEDGE_BUCKET" --location="$REGION" \
      --uniform-bucket-level-access --public-access-prevention
  fi
  knowledge_location="$(g storage buckets describe "gs://$KNOWLEDGE_BUCKET" --format='value(location)')"
  knowledge_pap="$(g storage buckets describe "gs://$KNOWLEDGE_BUCKET" --format='value(iamConfiguration.publicAccessPrevention)')"
  knowledge_ubla="$(g storage buckets describe "gs://$KNOWLEDGE_BUCKET" --format='value(iamConfiguration.uniformBucketLevelAccess.enabled)')"
  [[ "${knowledge_location,,}" == "$REGION" && "${knowledge_pap,,}" == enforced && "${knowledge_ubla,,}" == true ]] ||
    die "Knowledge archive bucket must remain private with uniform bucket-level access in $REGION."
  g storage buckets update "gs://$KNOWLEDGE_BUCKET" --update-labels=zioncore-command=public-release,purpose=knowledge-archive
  g storage buckets add-iam-policy-binding "gs://$KNOWLEDGE_BUCKET" --member="serviceAccount:command-runner$SA_SUFFIX" --role=roles/storage.objectCreator
  g storage buckets add-iam-policy-binding "gs://$KNOWLEDGE_BUCKET" --member="serviceAccount:command-runner$SA_SUFFIX" --role=roles/storage.objectViewer
  g storage buckets add-iam-policy-binding "gs://$KNOWLEDGE_BUCKET" --member="serviceAccount:command-web$SA_SUFFIX" --role=roles/storage.objectViewer
  [[ "$(g storage buckets describe "gs://$BUCKET" --format='value(labels.zioncore-command)')" == public-release ]] ||
    die "Existing build bucket is not marked as Command-owned."
  g storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:command-builder$SA_SUFFIX" --role=roles/storage.objectViewer
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:command-builder$SA_SUFFIX" --role=roles/logging.logWriter --condition=None
  g artifacts repositories add-iam-policy-binding "$REPOSITORY" --location="$REGION" --member="serviceAccount:command-builder$SA_SUFFIX" --role=roles/artifactregistry.writer
fi

stage_release
if [[ "$mode" == bootstrap ]]; then
  g run jobs execute "$DAILY" --region="$REGION" \
    --args=dist/jobMain.mjs,knowledge-archive-check --wait
fi

if [[ "$mode" == bootstrap ]]; then
  for job in "$RUNNER" "$DAILY"; do
    g run jobs add-iam-policy-binding "$job" --region="$REGION" --member="serviceAccount:command-scheduler$SA_SUFFIX" --role=roles/run.invoker
  done
  configure_schedule "$RUNNER" "*/15 * * * *"
  configure_schedule "$DAILY" "5 0 * * *"
  if [[ "${COMMAND_SKIP_FEDERATION:-0}" != 1 ]]; then configure_federation; fi
  echo "Wait for the actual scheduler before claiming scheduled-run verification. Do not force a fixture incident into the schedule."
fi

if [[ "$mode" == deploy ]]; then
  verify_genesis_asset
  verify_seed_execution
  echo "Cloud Scheduler was not changed; the existing 00:05 UTC daily schedule is preserved."
fi
