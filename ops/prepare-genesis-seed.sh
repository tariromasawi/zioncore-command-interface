#!/usr/bin/env bash
# Run from an authorized Cloud Shell in a checkout of this repository.
# Publishes only the pinned, owner-approved Seed bytes to a private, read-only runtime bucket.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT=gen-lang-client-0266144152
PROJECT_NUMBER=740460863819
REGION=europe-west2
PINNED_COMMIT=f1ae17ac70e77e81378eb8d52eb6efcfb244eb00
VERSION=1.1.0
SHA256=8199eb2b080c6ac56f71443c1506173f8227dc9df58a145801b56e9e2fd538c6
BYTES=463037
BUCKET="zioncore-command-genesis-seed-$PROJECT_NUMBER"
OBJECT="approved/$VERSION/genesis-seed.ts"
RUNNER="command-runner@$PROJECT.iam.gserviceaccount.com"
RELEASE="command-release@$PROJECT.iam.gserviceaccount.com"
g() { gcloud "$@" --project="$PROJECT" --quiet; }
die() { printf '%s\n' "$*" >&2; exit 1; }

[[ "$(g projects describe "$PROJECT" --format='value(projectId)')" == "$PROJECT" &&
   "$(g projects describe "$PROJECT" --format='value(projectNumber)')" == "$PROJECT_NUMBER" ]] ||
  die "Active Cloud Shell project identity does not match the approved Command project."
git rev-parse --show-toplevel >/dev/null
git fetch origin main
seed="$(mktemp)"
existing="$(mktemp)"
bucket_info="$(mktemp)"
trap 'rm -f "$seed" "$existing" "$bucket_info"' EXIT
git show "$PINNED_COMMIT:Genesis seed.ts" >"$seed"
actual_bytes="$(wc -c <"$seed" | tr -d '[:space:]')"
actual_sha="$(sha256sum "$seed" | awk '{print $1}')"
[[ "$actual_bytes" == "$BYTES" && "$actual_sha" == "$SHA256" ]] ||
  die "Pinned Genesis Seed did not match the approved byte count and SHA-256."
printf 'Approved Genesis Seed: version=%s bytes=%s sha256=%s\n' "$VERSION" "$actual_bytes" "$actual_sha"

if g storage buckets describe "gs://$BUCKET" --format=json >"$bucket_info" 2>/dev/null; then
  jq -e '.location|ascii_downcase=="europe-west2"' "$bucket_info" >/dev/null ||
    die "The existing Seed bucket is not in europe-west2; it was left unchanged."
  jq -e '.labels.zioncore-command=="public-release" and .labels.purpose=="genesis-seed"
    and .iamConfiguration.publicAccessPrevention=="enforced"
    and .iamConfiguration.uniformBucketLevelAccess.enabled==true' \
    "$bucket_info" >/dev/null ||
    die "The bucket exists but is not the private Command Seed bucket; it was left unchanged."
else
  g storage buckets create "gs://$BUCKET" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
  g storage buckets update "gs://$BUCKET" --update-labels=zioncore-command=public-release,purpose=genesis-seed
fi

if g storage objects describe "gs://$BUCKET/$OBJECT" --format=json >/dev/null 2>&1; then
  g storage cp "gs://$BUCKET/$OBJECT" "$existing"
  existing_bytes="$(wc -c <"$existing" | tr -d '[:space:]')"
  existing_sha="$(sha256sum "$existing" | awk '{print $1}')"
  [[ "$existing_bytes" == "$BYTES" && "$existing_sha" == "$SHA256" ]] ||
    die "An existing object differs from the pinned Seed; it was not overwritten."
  g storage objects update "gs://$BUCKET/$OBJECT" \
    --update-custom-metadata="version=$VERSION,sha256=$SHA256"
else
  g storage cp --if-generation-match=0 --content-type=text/plain \
    --custom-metadata="version=$VERSION,sha256=$SHA256" "$seed" "gs://$BUCKET/$OBJECT"
fi

g iam service-accounts describe "$RUNNER" --format='value(email)' >/dev/null
g iam service-accounts describe "$RELEASE" --format='value(email)' >/dev/null
g storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$RUNNER" --role=roles/storage.objectViewer
g storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$RELEASE" --role=roles/storage.bucketViewer
g storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$RELEASE" --role=roles/storage.objectViewer
printf 'Private Seed object ready: gs://%s/%s\n' "$BUCKET" "$OBJECT"
printf 'Read-only runtime identity: %s\n' "$RUNNER"
printf 'Read-only release preflight identity: %s\n' "$RELEASE"
printf 'No Cloud Scheduler settings or paid-AI flags were changed.\n'
