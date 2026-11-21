#!/usr/bin/env bash
# Configure split, forward-only Cloud Build identities for ZionCore Command.
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT=gen-lang-client-0266144152
PROJECT_NUMBER=740460863819
REGION=europe-west2
JOB=zioncore-command-research
DATABASE=zioncore-command
INBOX_DATABASE=zioncore-command-inbox
SEED_BUCKET="zioncore-command-genesis-seed-$PROJECT_NUMBER"
KNOWLEDGE_BUCKET="zioncore-command-knowledge-$PROJECT_NUMBER"
AI_SECRET=zioncore-command-ai-provider-key
AR_REPOSITORY=command-public-images
BUILDER_ID=command-candidate-builder
DEPLOYER_ID=command-release
RUNTIME_ID=command-runner
WEB_ID=command-web
LEGACY_BUILDER_ID=command-builder
DEPLOY_ROLE=ZionCoreCommandResearchJobDeployer
FIRESTORE_ROLE=ZionCoreCommandFirestoreWriter
BUILD_TRIGGER_NAME=command-research-deploy

BUILDER="$BUILDER_ID@$PROJECT.iam.gserviceaccount.com"
DEPLOYER="$DEPLOYER_ID@$PROJECT.iam.gserviceaccount.com"
RUNTIME="$RUNTIME_ID@$PROJECT.iam.gserviceaccount.com"
WEB="$WEB_ID@$PROJECT.iam.gserviceaccount.com"
LEGACY_BUILDER="$LEGACY_BUILDER_ID@$PROJECT.iam.gserviceaccount.com"
BUILD_AGENT="service-$PROJECT_NUMBER@gcp-sa-cloudbuild.iam.gserviceaccount.com"
DEPLOY_ROLE_NAME="projects/$PROJECT/roles/$DEPLOY_ROLE"
FIRESTORE_ROLE_NAME="projects/$PROJECT/roles/$FIRESTORE_ROLE"

g() { gcloud "$@" --project="$PROJECT" --quiet; }
die() { printf '%s\n' "$*" >&2; exit 1; }
has_apply=false
if [[ "${1:-}" == "--apply" && $# -eq 1 ]]; then
  has_apply=true
elif [[ $# -gt 0 ]]; then
  die "Usage: bash ops/prepare-cloudbuild-research.sh [--apply]"
fi

project_id="$(g projects describe "$PROJECT" --format='value(projectId)')"
project_number="$(g projects describe "$PROJECT" --format='value(projectNumber)')"
[[ "$project_id" == "$PROJECT" && "$project_number" == "$PROJECT_NUMBER" ]] ||
  die "Active Cloud Shell project does not match the approved ZionCore Command project."

g run jobs describe "$JOB" --region="$REGION" --format='value(name)' >/dev/null
g firestore databases describe --database="$DATABASE" --format='value(name)' >/dev/null
g storage buckets describe "gs://$SEED_BUCKET" --format='value(name)' >/dev/null
knowledge_bucket_exists=false
if knowledge_bucket_metadata="$(g storage buckets describe "gs://$KNOWLEDGE_BUCKET" --format=json 2>/dev/null)"; then
  python3 -c 'import json,sys; b=json.load(sys.stdin); pap=(b.get("iamConfiguration") or {}).get("publicAccessPrevention"); ubla=(b.get("iamConfiguration") or {}).get("uniformBucketLevelAccess",{}).get("enabled"); sys.exit(0 if str(b.get("location","")).lower()==sys.argv[1] and pap=="enforced" and ubla is True else "The existing knowledge archive bucket must be in europe-west2 with Public Access Prevention and uniform bucket-level access enabled.")' \
    "$REGION" <<<"$knowledge_bucket_metadata"
  knowledge_bucket_exists=true
fi
g secrets describe "$AI_SECRET" --format='value(name)' >/dev/null
g artifacts repositories describe "$AR_REPOSITORY" --location="$REGION" --format='value(name)' >/dev/null
g iam service-accounts describe "$DEPLOYER" --format='value(email)' >/dev/null
g iam service-accounts describe "$RUNTIME" --format='value(email)' >/dev/null
g iam service-accounts describe "$WEB" --format='value(email)' >/dev/null
g iam service-accounts describe "$BUILD_AGENT" --format='value(email)' >/dev/null

trigger_file="$(mktemp)"
trap 'rm -f "$trigger_file"' EXIT
g builds triggers list --region=global --format=json > "$trigger_file"
trigger_record="$(python3 - "$trigger_file" <<'PY'
import json, sys

triggers = json.load(open(sys.argv[1], encoding="utf-8"))
matches = []
for trigger in triggers:
    github = trigger.get("github") or {}
    push = github.get("push") or {}
    if (
        trigger.get("filename") == "ops/cloudbuild-research.yaml"
        and github.get("owner", "").lower() == "tariromasawi"
        and github.get("name", "").lower() == "zioncore-command-interface"
        and push.get("branch") in ("release/command-public-rebuild", "^release/command-public-rebuild$")
    ):
        matches.append(trigger)
if len(matches) != 1:
    print(
        f"Expected one existing GitHub build trigger for ops/cloudbuild-research.yaml; found {len(matches)}.",
        file=sys.stderr,
    )
    print("Current global triggers:", file=sys.stderr)
    for item in triggers:
        print(
            f"  {item.get('name')} id={item.get('id')} file={item.get('filename')} "
            f"serviceAccount={item.get('serviceAccount')}",
            file=sys.stderr,
        )
    raise SystemExit(2)
trigger = matches[0]
print("|".join((trigger.get("id", ""), trigger["github"]["owner"], trigger["github"]["name"])))
PY
)" || die "Could not safely identify the existing release build trigger."
IFS='|' read -r BUILD_TRIGGER_ID REPO_OWNER REPO_NAME <<< "$trigger_record"
[[ -n "$BUILD_TRIGGER_ID" && "$REPO_OWNER/$REPO_NAME" == "tariromasawi/zioncore-command-interface" ]] ||
  die "The existing trigger identity did not match the approved GitHub repository."

printf 'Project: %s (%s), region: %s\n' "$PROJECT" "$PROJECT_NUMBER" "$REGION"
printf 'Existing build trigger: %s -> ops/cloudbuild-research.yaml -> %s\n' \
  "$BUILD_TRIGGER_ID" "$BUILDER"
printf 'Deployment trigger: %s -> ops/cloudbuild-research-deploy.yaml -> %s\n' \
  "$BUILD_TRIGGER_NAME" "$DEPLOYER"
printf 'Runtime: %s; job: %s; Firestore: %s; Seed bucket: %s\n' \
  "$RUNTIME" "$JOB" "$DATABASE" "$SEED_BUCKET"
printf 'The public web identity will get archive read-only access; only the runner can create archive objects.\n'
if [[ "$knowledge_bucket_exists" == true ]]; then
  printf 'Append-only knowledge archive bucket already exists with private access settings: %s\n' "$KNOWLEDGE_BUCKET"
else
  printf 'The apply step will create a private, uniform-access knowledge archive bucket: %s\n' "$KNOWLEDGE_BUCKET"
fi
printf 'The candidate builder will receive Artifact Registry Writer only on %s.\n' "$AR_REPOSITORY"
printf 'The deployment identity will use a custom no-delete job role; the runtime will use a custom no-delete Firestore role.\n'
printf 'The existing Cloud Scheduler job and Cloud Run job settings are not changed by this script.\n'
printf 'This does not read or print the paid provider key.\n'

if [[ "$has_apply" != true ]]; then
  printf '\nRead-only preflight passed. Review the plan above, then run with --apply to configure it.\n'
  exit 0
fi

read -r -p "Type CONFIGURE FORWARD-ONLY COMMAND RELEASE to continue: " confirmation
[[ "$confirmation" == "CONFIGURE FORWARD-ONLY COMMAND RELEASE" ]] ||
  die "Stopped before changing IAM or Cloud Build triggers."

if ! g iam service-accounts describe "$BUILDER" --format='value(email)' >/dev/null 2>&1; then
  g iam service-accounts create "$BUILDER_ID" \
    --display-name="ZionCore candidate image builder"
fi

if [[ "$knowledge_bucket_exists" != true ]]; then
  g storage buckets create "gs://$KNOWLEDGE_BUCKET" \
    --location="$REGION" --uniform-bucket-level-access --public-access-prevention
fi

if g iam roles describe "$DEPLOY_ROLE" >/dev/null 2>&1; then
  g iam roles update "$DEPLOY_ROLE" \
    --file=ops/roles/command-research-deployer.json
else
  g iam roles create "$DEPLOY_ROLE" \
    --file=ops/roles/command-research-deployer.json
fi
if g iam roles describe "$FIRESTORE_ROLE" >/dev/null 2>&1; then
  g iam roles update "$FIRESTORE_ROLE" \
    --file=ops/roles/command-firestore-no-delete.json
else
  g iam roles create "$FIRESTORE_ROLE" \
    --file=ops/roles/command-firestore-no-delete.json
fi

member() { printf 'serviceAccount:%s' "$1"; }

g artifacts repositories add-iam-policy-binding "$AR_REPOSITORY" \
  --location="$REGION" --member="$(member "$BUILDER")" --role=roles/artifactregistry.writer
g artifacts repositories add-iam-policy-binding "$AR_REPOSITORY" \
  --location="$REGION" --member="$(member "$DEPLOYER")" --role=roles/artifactregistry.reader
g projects add-iam-policy-binding "$PROJECT" \
  --member="$(member "$BUILDER")" --role=roles/logging.logWriter
g projects add-iam-policy-binding "$PROJECT" \
  --member="$(member "$DEPLOYER")" --role=roles/logging.logWriter
g projects add-iam-policy-binding "$PROJECT" \
  --member="$(member "$DEPLOYER")" --role=roles/cloudbuild.builds.viewer
g projects add-iam-policy-binding "$PROJECT" \
  --member="$(member "$RUNTIME")" --role="$FIRESTORE_ROLE_NAME" \
  --condition="title=command-primary-database,expression=resource.name == 'projects/$PROJECT/databases/$DATABASE'"
g projects add-iam-policy-binding "$PROJECT" \
  --member="$(member "$RUNTIME")" --role="$FIRESTORE_ROLE_NAME" \
  --condition="title=command-inbox-database,expression=resource.name == 'projects/$PROJECT/databases/$INBOX_DATABASE'"
g projects add-iam-policy-binding "$PROJECT" \
  --member="$(member "$WEB")" --role="$FIRESTORE_ROLE_NAME" \
  --condition="title=command-inbox-database,expression=resource.name == 'projects/$PROJECT/databases/$INBOX_DATABASE'"

g run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="$(member "$DEPLOYER")" --role="$DEPLOY_ROLE_NAME"
g iam service-accounts add-iam-policy-binding "$RUNTIME" \
  --member="$(member "$DEPLOYER")" --role=roles/iam.serviceAccountUser
g iam service-accounts add-iam-policy-binding "$BUILDER" \
  --member="$(member "$BUILD_AGENT")" --role=roles/iam.serviceAccountUser
g iam service-accounts add-iam-policy-binding "$DEPLOYER" \
  --member="$(member "$BUILD_AGENT")" --role=roles/iam.serviceAccountUser

g storage buckets add-iam-policy-binding "gs://$SEED_BUCKET" \
  --member="$(member "$DEPLOYER")" --role=roles/storage.bucketViewer
g storage buckets add-iam-policy-binding "gs://$SEED_BUCKET" \
  --member="$(member "$DEPLOYER")" --role=roles/storage.objectViewer
g storage buckets add-iam-policy-binding "gs://$KNOWLEDGE_BUCKET" \
  --member="$(member "$RUNTIME")" --role=roles/storage.objectCreator
g storage buckets add-iam-policy-binding "gs://$KNOWLEDGE_BUCKET" \
  --member="$(member "$RUNTIME")" --role=roles/storage.objectViewer
g storage buckets add-iam-policy-binding "gs://$KNOWLEDGE_BUCKET" \
  --member="$(member "$WEB")" --role=roles/storage.objectViewer
g secrets add-iam-policy-binding "$AI_SECRET" \
  --member="$(member "$DEPLOYER")" --role=roles/secretmanager.viewer

g builds triggers update github "$BUILD_TRIGGER_ID" --region=global \
  --service-account="projects/$PROJECT/serviceAccounts/$BUILDER" \
  --build-config=ops/cloudbuild-research.yaml \
  --branch-pattern='^release/command-public-rebuild$' \
  --no-require-approval

deploy_trigger_json="$(mktemp)"
if g builds triggers describe "$BUILD_TRIGGER_NAME" --region=global --format=json > "$deploy_trigger_json" 2>/dev/null; then
  g builds triggers update github "$BUILD_TRIGGER_NAME" --region=global \
    --service-account="projects/$PROJECT/serviceAccounts/$DEPLOYER" \
    --build-config=ops/cloudbuild-research-deploy.yaml \
    --branch-pattern='^release/command-public-rebuild$' \
    --update-substitutions="_BUILDER_TRIGGER_ID=$BUILD_TRIGGER_ID" \
    --no-require-approval
else
  g builds triggers create github \
    --name="$BUILD_TRIGGER_NAME" \
    --repo-owner="$REPO_OWNER" \
    --repo-name="$REPO_NAME" \
    --region=global \
    --service-account="projects/$PROJECT/serviceAccounts/$DEPLOYER" \
    --branch-pattern='^release/command-public-rebuild$' \
    --build-config=ops/cloudbuild-research-deploy.yaml \
    --substitutions="_BUILDER_TRIGGER_ID=$BUILD_TRIGGER_ID" \
    --description="Deploy only the verified current ZionCore Command research image digest." \
    --no-require-approval
fi
rm -f "$deploy_trigger_json"

remove_project_binding_if_present() {
  local principal="$1" role="$2" policy
  policy="$(g projects get-iam-policy "$PROJECT" --format=json)"
  if python3 - "$policy" "$principal" "$role" <<'PY'
import json, sys
policy = json.loads(sys.argv[1])
member, role = "serviceAccount:" + sys.argv[2], sys.argv[3]
raise SystemExit(0 if any(b.get("role") == role and member in (b.get("members") or [])
                          and not b.get("condition") for b in policy.get("bindings") or []) else 1)
PY
  then
    g projects remove-iam-policy-binding "$PROJECT" \
      --member="$(member "$principal")" --role="$role"
  fi
}

remove_project_database_binding_if_present() {
  local principal="$1" role="$2" database="$3"
  local title="command-$database" expression="resource.name == 'projects/$PROJECT/databases/$database'" policy
  policy="$(g projects get-iam-policy "$PROJECT" --format=json)"
  if python3 - "$policy" "$principal" "$role" "$title" "$expression" <<'PY'
import json,sys
policy=json.loads(sys.argv[1])
member,role,title,expression="serviceAccount:"+sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5]
raise SystemExit(0 if any(b.get("role")==role and member in (b.get("members") or [])
                          and (b.get("condition") or {}).get("title")==title
                          and (b.get("condition") or {}).get("expression")==expression
                          for b in policy.get("bindings") or []) else 1)
PY
  then
    g projects remove-iam-policy-binding "$PROJECT" \
      --member="$(member "$principal")" --role="$role" \
      --condition="title=$title,expression=$expression"
  fi
}

remove_job_binding_if_present() {
  local principal="$1" role="$2" policy
  policy="$(g run jobs get-iam-policy "$JOB" --region="$REGION" --format=json)"
  if python3 - "$policy" "$principal" "$role" <<'PY'
import json, sys
policy = json.loads(sys.argv[1])
member, role = "serviceAccount:" + sys.argv[2], sys.argv[3]
raise SystemExit(0 if any(b.get("role") == role and member in (b.get("members") or [])
                          and not b.get("condition") for b in policy.get("bindings") or []) else 1)
PY
  then
    g run jobs remove-iam-policy-binding "$JOB" --region="$REGION" \
      --member="$(member "$principal")" --role="$role"
  fi
}

remove_sa_binding_if_present() {
  local sa="$1" principal="$2" role="$3" policy
  policy="$(g iam service-accounts get-iam-policy "$sa" --format=json)"
  if python3 - "$policy" "$principal" "$role" <<'PY'
import json, sys
policy = json.loads(sys.argv[1])
member, role = "serviceAccount:" + sys.argv[2], sys.argv[3]
raise SystemExit(0 if any(b.get("role") == role and member in (b.get("members") or [])
                          and not b.get("condition") for b in policy.get("bindings") or []) else 1)
PY
  then
    g iam service-accounts remove-iam-policy-binding "$sa" \
      --member="$(member "$principal")" --role="$role"
  fi
}

remove_bucket_binding_if_present() {
  local principal="$1" role="$2" policy
  policy="$(g storage buckets get-iam-policy "gs://$SEED_BUCKET" --format=json)"
  if python3 - "$policy" "$principal" "$role" <<'PY'
import json, sys
policy = json.loads(sys.argv[1])
member, role = "serviceAccount:" + sys.argv[2], sys.argv[3]
raise SystemExit(0 if any(b.get("role") == role and member in (b.get("members") or [])
                          and not b.get("condition") for b in policy.get("bindings") or []) else 1)
PY
  then
    g storage buckets remove-iam-policy-binding "gs://$SEED_BUCKET" \
      --member="$(member "$principal")" --role="$role"
  fi
}

remove_secret_binding_if_present() {
  local principal="$1" role="$2" policy
  policy="$(g secrets get-iam-policy "$AI_SECRET" --format=json)"
  if python3 - "$policy" "$principal" "$role" <<'PY'
import json, sys
policy = json.loads(sys.argv[1])
member, role = "serviceAccount:" + sys.argv[2], sys.argv[3]
raise SystemExit(0 if any(b.get("role") == role and member in (b.get("members") or [])
                          and not b.get("condition") for b in policy.get("bindings") or []) else 1)
PY
  then
    g secrets remove-iam-policy-binding "$AI_SECRET" \
      --member="$(member "$principal")" --role="$role"
  fi
}

remove_project_binding_if_present "$DEPLOYER" roles/run.developer
remove_project_binding_if_present "$DEPLOYER" roles/iam.serviceAccountUser
remove_project_binding_if_present "$LEGACY_BUILDER" roles/run.developer
remove_project_binding_if_present "$LEGACY_BUILDER" roles/run.invoker
remove_project_binding_if_present "$LEGACY_BUILDER" roles/iam.serviceAccountUser
remove_project_binding_if_present "$RUNTIME" roles/datastore.user
remove_project_binding_if_present "$WEB" roles/datastore.user
remove_project_database_binding_if_present "$RUNTIME" roles/datastore.user "$DATABASE"
remove_project_database_binding_if_present "$RUNTIME" roles/datastore.user "$INBOX_DATABASE"
remove_project_database_binding_if_present "$WEB" roles/datastore.user "$INBOX_DATABASE"
remove_job_binding_if_present "$DEPLOYER" roles/run.developer
remove_job_binding_if_present "$DEPLOYER" roles/run.invoker
remove_job_binding_if_present "$LEGACY_BUILDER" roles/run.developer
remove_job_binding_if_present "$LEGACY_BUILDER" roles/run.invoker
remove_sa_binding_if_present "$RUNTIME" "$LEGACY_BUILDER" roles/iam.serviceAccountUser
remove_bucket_binding_if_present "$LEGACY_BUILDER" roles/storage.bucketViewer
remove_bucket_binding_if_present "$LEGACY_BUILDER" roles/storage.objectViewer
remove_secret_binding_if_present "$LEGACY_BUILDER" roles/secretmanager.viewer

rm -f "$deploy_trigger_json"
bash ops/check-forward-only-iam.sh
printf '\nForward-only IAM and both branch triggers are configured. The production job and Scheduler were not edited.\n'
