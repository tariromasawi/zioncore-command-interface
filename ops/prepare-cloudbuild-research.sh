#!/usr/bin/env bash
# Run once from an owner-authorized Cloud Shell after the Seed bucket and key secret exist.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT=gen-lang-client-0266144152
PROJECT_NUMBER=740460863819
REGION=europe-west2
BUILDER="command-builder@$PROJECT.iam.gserviceaccount.com"
RUNTIME="command-runner@$PROJECT.iam.gserviceaccount.com"
JOB=zioncore-command-research
SEED_BUCKET="zioncore-command-genesis-seed-$PROJECT_NUMBER"
AI_SECRET=zioncore-command-ai-provider-key
g() { gcloud "$@" --project="$PROJECT" --quiet; }
die() { printf '%s\n' "$*" >&2; exit 1; }

[[ "$(g projects describe "$PROJECT" --format='value(projectId)')" == "$PROJECT" &&
   "$(g projects describe "$PROJECT" --format='value(projectNumber)')" == "$PROJECT_NUMBER" ]] ||
  die "Active Cloud Shell project does not match the approved Command project."
g iam service-accounts describe "$BUILDER" --format='value(email)' >/dev/null
g iam service-accounts describe "$RUNTIME" --format='value(email)' >/dev/null
g run jobs describe "$JOB" --region="$REGION" --format='value(name)' >/dev/null
g storage buckets describe "gs://$SEED_BUCKET" --format='value(name)' >/dev/null
g secrets describe "$AI_SECRET" --format='value(name)' >/dev/null

cat <<PLAN
Project: $PROJECT ($PROJECT_NUMBER)
Build identity: $BUILDER
Runtime identity: $RUNTIME
Scope: only job $JOB, Seed bucket $SEED_BUCKET, and secret $AI_SECRET
Bindings to add or preserve:
  - command-builder: Cloud Run Developer and Invoker on $JOB
  - command-builder: Service Account User on $RUNTIME
  - command-builder: bucket metadata and object-view access on $SEED_BUCKET
  - command-builder: Secret Manager Viewer on $AI_SECRET (never secret access)
No job configuration, provider key value, Firestore database, schedule, or other project resource will be changed.
PLAN
read -r -p "Type CONFIGURE RESEARCH BUILDER to continue: " confirmation
[[ "$confirmation" == "CONFIGURE RESEARCH BUILDER" ]] || die "Stopped before changing IAM."

member="serviceAccount:$BUILDER"
g run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="$member" --role=roles/run.developer
g run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="$member" --role=roles/run.invoker
g iam service-accounts add-iam-policy-binding "$RUNTIME" \
  --member="$member" --role=roles/iam.serviceAccountUser
g storage buckets add-iam-policy-binding "gs://$SEED_BUCKET" \
  --member="$member" --role=roles/storage.bucketViewer
g storage buckets add-iam-policy-binding "gs://$SEED_BUCKET" \
  --member="$member" --role=roles/storage.objectViewer
g secrets add-iam-policy-binding "$AI_SECRET" \
  --member="$member" --role=roles/secretmanager.viewer

printf 'Configured only the scoped Cloud Build permissions for %s.\n' "$JOB"
