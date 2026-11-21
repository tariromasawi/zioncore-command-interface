#!/usr/bin/env bash
set -euo pipefail

PROJECT=gen-lang-client-0266144152
REGION=europe-west2
REPOSITORY=command-public-images
JOB=zioncore-command-research
RUNTIME_SA="command-runner@$PROJECT.iam.gserviceaccount.com"
SEED_BUCKET=zioncore-command-genesis-seed-740460863819
SEED_OBJECT=approved/1.1.0/genesis-seed.ts
SEED_PATH=/mnt/genesis/approved/1.1.0/genesis-seed.ts
SEED_VERSION=1.1.0
SEED_BYTES=463037
SEED_SHA256=8199eb2b080c6ac56f71443c1506173f8227dc9df58a145801b56e9e2fd538c6
AI_SECRET=zioncore-command-ai-provider-key
MODEL=gemini-3.5-flash-lite
MODEL_CONTEXT=1048576
MODEL_INPUT_MICROS=300000
MODEL_OUTPUT_MICROS=2500000
MODEL_OUTPUT_LIMIT=256
MONTHLY_AI_CAP=30000000
EXECUTION_AI_CAP=9000000
AI_BUDGET_THROUGH_MONTH=2027-01

die() {
  echo "Research release stopped: $*" >&2
  exit 1
}

g() {
  gcloud "$@" --project="$PROJECT" --quiet
}

[[ "${BRANCH_NAME:-}" == "release/command-public-rebuild" ]] ||
  die "Cloud Build must run from release/command-public-rebuild."

image_tag="${1:-}"
[[ "$image_tag" =~ ^${REGION}-docker\.pkg\.dev/${PROJECT}/${REPOSITORY}/command:[a-f0-9]{40}$ ]] ||
  die "Expected an immutable full-commit tag in the ZionCore Command Artifact Registry repository."

digest="$(g artifacts docker images describe "$image_tag" --format='value(image_summary.digest)')"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die "The pushed image digest could not be verified."
image="${image_tag%:*}@$digest"
printf 'Published image digest: %s\n' "$image"

bucket_location="$(g storage buckets describe "gs://$SEED_BUCKET" --format='value(location)')"
bucket_pap="$(g storage buckets describe "gs://$SEED_BUCKET" --format='value(iamConfiguration.publicAccessPrevention)')"
bucket_ubla="$(g storage buckets describe "gs://$SEED_BUCKET" --format='value(iamConfiguration.uniformBucketLevelAccess.enabled)')"
[[ "${bucket_location,,}" == "$REGION" ]] || die "The approved Seed bucket is not in $REGION."
[[ "${bucket_pap,,}" == enforced && "${bucket_ubla,,}" == true ]] ||
  die "The approved Seed bucket must keep Public Access Prevention and uniform bucket-level access enabled."

seed_uri="gs://$SEED_BUCKET/$SEED_OBJECT"
seed_size="$(g storage objects describe "$seed_uri" --format='value(size)')"
seed_version="$(g storage objects describe "$seed_uri" --format='value(metadata.version)')"
seed_sha="$(g storage objects describe "$seed_uri" --format='value(metadata.sha256)')"
[[ "$seed_size" == "$SEED_BYTES" && "$seed_version" == "$SEED_VERSION" && "$seed_sha" == "$SEED_SHA256" ]] ||
  die "The private Seed object metadata does not match the approved version, byte count, and checksum."

# Confirm the secret resource exists without reading its value.
g secrets describe "$AI_SECRET" --format='value(name)' >/dev/null
secret_version="$(g secrets versions list "$AI_SECRET" --filter='state=ENABLED' --limit=1 --format='value(name)')"
[[ -n "$secret_version" ]] || die "The provider-key secret has no enabled version."

job_json="$(mktemp)"
trap 'rm -f "$job_json"' EXIT
g run jobs describe "$JOB" --region="$REGION" --format=json > "$job_json"

# Require the least-privilege runtime bindings before changing the live job.
bucket_policy="$(mktemp)"
secret_policy="$(mktemp)"
trap 'rm -f "$job_json" "$bucket_policy" "$secret_policy"' EXIT
g storage buckets get-iam-policy "gs://$SEED_BUCKET" --format=json > "$bucket_policy"
g secrets get-iam-policy "$AI_SECRET" --format=json > "$secret_policy"
if ! python3 - "$bucket_policy" "$secret_policy" "$RUNTIME_SA" <<'PY'
import json, sys

member = "serviceAccount:" + sys.argv[3]
for path, role in ((sys.argv[1], "roles/storage.objectViewer"),
                   (sys.argv[2], "roles/secretmanager.secretAccessor")):
    policy = json.load(open(path, encoding="utf-8"))
    if not any(binding.get("role") == role and member in (binding.get("members") or [])
               and not binding.get("condition")
               for binding in policy.get("bindings") or []):
        print(f"Missing unconditioned {role} binding for {member}.", file=sys.stderr)
        raise SystemExit(1)
PY
then
  die "Runtime identity is missing the required Seed-bucket or provider-secret access."
fi

# Only add the named Seed volume/mount when missing; fail closed if an existing
# resource with that name points elsewhere or is writable.
volume_plan="$(python3 - "$job_json" "$SEED_BUCKET" <<'PY'
import json, sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
expected_bucket = sys.argv[2]
job_template = data.get("template") or {}
task_template = job_template.get("template") or {}
if not task_template:
    task_template = (data.get("spec") or {}).get("template", {}).get("spec") or {}
volumes = task_template.get("volumes") or []
matches = [item for item in volumes if item.get("name") == "genesis-seed"]
if len(matches) > 1:
    raise SystemExit("Multiple genesis-seed volumes exist; refusing to change the research job.")
add_volume = 1
if matches:
    volume = matches[0]
    source = volume.get("gcs") or volume.get("cloudStorage") or volume.get("cloud_storage") or {}
    bucket = source.get("bucket") or source.get("bucketName")
    read_only = source.get("readOnly", source.get("read_only", source.get("readonly")))
    if bucket != expected_bucket or read_only is not True:
        raise SystemExit("Existing genesis-seed volume is not the approved read-only bucket.")
    add_volume = 0

containers = task_template.get("containers") or []
if not containers:
    raise SystemExit("The research job has no container to mount the approved Seed.")
mounts = []
for container in containers:
    mounts.extend(container.get("volumeMounts") or container.get("volume_mounts") or [])
target_mounts = [item for item in mounts
                 if item.get("mountPath", item.get("mount_path")) == "/mnt/genesis"]
if len(target_mounts) > 1:
    raise SystemExit("Multiple containers mount /mnt/genesis; refusing to change the research job.")
add_mount = 1
if target_mounts:
    mount = target_mounts[0]
    if mount.get("name", mount.get("volume")) != "genesis-seed":
        raise SystemExit("/mnt/genesis is already mounted from a different volume.")
    add_mount = 0
print(add_volume, add_mount)
PY
)" || die "The existing research-job Seed volume could not be verified safely."
read -r add_volume add_mount <<< "$volume_plan"

update_args=(
  "--image=$image"
  "--service-account=$RUNTIME_SA"
  "--command=node"
  "--args=dist/jobMain.mjs,daily-review"
  "--task-timeout=180s"
  "--max-retries=1"
  "--tasks=1"
  "--parallelism=1"
  "--cpu=1"
  "--memory=512Mi"
  "--update-env-vars=GOOGLE_CLOUD_PROJECT=$PROJECT,COMMAND_STORE=firestore,FIRESTORE_DATABASE=zioncore-command,COMMAND_GENESIS_PATH=$SEED_PATH,COMMAND_GENESIS_VERSION=$SEED_VERSION,COMMAND_GENESIS_SHA256=$SEED_SHA256,COMMAND_ENABLE_GENESIS_AI=1,COMMAND_ENABLE_DAILY_GENESIS=1,COMMAND_ENABLE_PAID_AI=1,COMMAND_PAID_AI_MONTHLY_CAP_MICROS=$MONTHLY_AI_CAP,COMMAND_PAID_AI_EXECUTION_CAP_MICROS=$EXECUTION_AI_CAP,COMMAND_PAID_AI_BUDGET_THROUGH_MONTH=$AI_BUDGET_THROUGH_MONTH,COMMAND_PAID_MODEL_NAME=$MODEL,COMMAND_PAID_MODEL_CONTEXT=$MODEL_CONTEXT,COMMAND_PAID_MODEL_INPUT_MICROS_PER_MILLION=$MODEL_INPUT_MICROS,COMMAND_PAID_MODEL_OUTPUT_MICROS_PER_MILLION=$MODEL_OUTPUT_MICROS,COMMAND_PAID_MODEL_BILLABLE_OUTPUT_LIMIT=$MODEL_OUTPUT_LIMIT"
  "--update-secrets=COMMAND_PAID_PROVIDER_KEY=$AI_SECRET:latest"
)
if [[ "$add_volume" == 1 ]]; then
  update_args+=("--add-volume=name=genesis-seed,type=cloud-storage,bucket=$SEED_BUCKET,readonly=true")
fi
if [[ "$add_mount" == 1 ]]; then
  update_args+=("--add-volume-mount=volume=genesis-seed,mount-path=/mnt/genesis")
fi

g run jobs update "$JOB" --region="$REGION" "${update_args[@]}"
printf 'Updated only Cloud Run job %s in %s.\n' "$JOB" "$REGION"
printf 'Paid model: %s, context %s, rates %s/%s micros per million input/output tokens.\n' \
  "$MODEL" "$MODEL_CONTEXT" "$MODEL_INPUT_MICROS" "$MODEL_OUTPUT_MICROS"
printf 'Monthly paid-AI cap: %s micros; per-execution cap: %s micros; active through %s.\n' \
  "$MONTHLY_AI_CAP" "$EXECUTION_AI_CAP" "$AI_BUDGET_THROUGH_MONTH"

# This test mode verifies the mounted bytes but never sends a model request.
g run jobs execute "$JOB" --region="$REGION" \
  --args=dist/jobMain.mjs,seed-check --wait
