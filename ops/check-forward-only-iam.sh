#!/usr/bin/env bash
set -euo pipefail

PROJECT=gen-lang-client-0266144152
REGION=europe-west2
PROJECT_NUMBER=740460863819
JOB=zioncore-command-research
DATABASE=zioncore-command
INBOX_DATABASE=zioncore-command-inbox
BUCKET=zioncore-command-genesis-seed-$PROJECT_NUMBER
KNOWLEDGE_BUCKET=zioncore-command-knowledge-$PROJECT_NUMBER
REPOSITORY=command-public-images
AI_SECRET=zioncore-command-ai-provider-key
RUNTIME="command-runner@$PROJECT.iam.gserviceaccount.com"
WEB="command-web@$PROJECT.iam.gserviceaccount.com"
BUILDER="command-candidate-builder@$PROJECT.iam.gserviceaccount.com"
DEPLOYER="command-release@$PROJECT.iam.gserviceaccount.com"

project_resource="//cloudresourcemanager.googleapis.com/projects/$PROJECT"
job_resource="//run.googleapis.com/projects/$PROJECT/locations/$REGION/jobs/$JOB"
runtime_resource="//iam.googleapis.com/projects/$PROJECT/serviceAccounts/$RUNTIME"
bucket_resource="//storage.googleapis.com/projects/_/buckets/$BUCKET"
knowledge_bucket_resource="//storage.googleapis.com/projects/_/buckets/$KNOWLEDGE_BUCKET"
registry_resource="//artifactregistry.googleapis.com/projects/$PROJECT/locations/$REGION/repositories/$REPOSITORY"
database_resource="//firestore.googleapis.com/projects/$PROJECT/databases/$DATABASE"
inbox_database_resource="//firestore.googleapis.com/projects/$PROJECT/databases/$INBOX_DATABASE"
secret_resource="//secretmanager.googleapis.com/projects/$PROJECT/secrets/$AI_SECRET"

check() {
  local principal="$1" permission="$2" resource="$3" expected="$4" json decision
  json="$(gcloud policy-troubleshoot iam "$resource" \
    --permission="$permission" \
    --principal-email="$principal" \
    --project="$PROJECT" \
    --format=json)"
  decision="$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data.get("access", "UNKNOWN"))' <<<"$json")"
  if [[ "$decision" != "$expected" ]]; then
    printf 'FAIL %-65s %-52s expected %s, got %s\n' \
      "$principal" "$permission" "$expected" "$decision" >&2
    return 1
  fi
  printf 'PASS %-65s %-52s %s\n' "$principal" "$permission" "$decision"
}

gcloud projects describe "$PROJECT" --format='value(projectId)' | grep -Fx "$PROJECT" >/dev/null
printf 'Effective IAM check for project %s (%s), region %s\n' \
  "$PROJECT" "$PROJECT_NUMBER" "$REGION"
printf 'The checks below are read-only. Policy Troubleshooter includes inherited grants.\n\n'

check "$BUILDER" "artifactregistry.repositories.uploadArtifacts" "$registry_resource" GRANTED
check "$BUILDER" "artifactregistry.versions.delete" "$registry_resource" NOT_GRANTED
check "$BUILDER" "artifactregistry.tags.delete" "$registry_resource" NOT_GRANTED
check "$BUILDER" "artifactregistry.repositories.delete" "$registry_resource" NOT_GRANTED
check "$BUILDER" "run.jobs.update" "$job_resource" NOT_GRANTED
check "$BUILDER" "run.jobs.delete" "$job_resource" NOT_GRANTED
check "$BUILDER" "run.jobs.run" "$job_resource" NOT_GRANTED
check "$BUILDER" "iam.serviceAccounts.actAs" "$runtime_resource" NOT_GRANTED
check "$BUILDER" "cloudbuild.triggers.delete" "$project_resource" NOT_GRANTED
check "$BUILDER" "datastore.entities.delete" "$database_resource" NOT_GRANTED
check "$BUILDER" "datastore.databases.delete" "$database_resource" NOT_GRANTED
check "$BUILDER" "secretmanager.versions.access" "$secret_resource" NOT_GRANTED
check "$BUILDER" "storage.objects.get" "$knowledge_bucket_resource" NOT_GRANTED
check "$BUILDER" "storage.objects.create" "$knowledge_bucket_resource" NOT_GRANTED

check "$RUNTIME" "storage.objects.get" "$bucket_resource" GRANTED
check "$RUNTIME" "storage.objects.create" "$bucket_resource" NOT_GRANTED
check "$RUNTIME" "storage.objects.update" "$bucket_resource" NOT_GRANTED
check "$RUNTIME" "storage.objects.delete" "$bucket_resource" NOT_GRANTED
check "$RUNTIME" "storage.buckets.delete" "$bucket_resource" NOT_GRANTED
check "$RUNTIME" "storage.buckets.setIamPolicy" "$bucket_resource" NOT_GRANTED
check "$RUNTIME" "storage.objects.get" "$knowledge_bucket_resource" GRANTED
check "$RUNTIME" "storage.objects.create" "$knowledge_bucket_resource" GRANTED
check "$RUNTIME" "storage.objects.update" "$knowledge_bucket_resource" NOT_GRANTED
check "$RUNTIME" "storage.objects.delete" "$knowledge_bucket_resource" NOT_GRANTED
check "$RUNTIME" "storage.buckets.delete" "$knowledge_bucket_resource" NOT_GRANTED
check "$RUNTIME" "storage.buckets.setIamPolicy" "$knowledge_bucket_resource" NOT_GRANTED
check "$WEB" "storage.objects.get" "$knowledge_bucket_resource" GRANTED
check "$WEB" "storage.objects.create" "$knowledge_bucket_resource" NOT_GRANTED
check "$WEB" "storage.objects.update" "$knowledge_bucket_resource" NOT_GRANTED
check "$WEB" "storage.objects.delete" "$knowledge_bucket_resource" NOT_GRANTED
check "$RUNTIME" "run.jobs.update" "$job_resource" NOT_GRANTED
check "$RUNTIME" "run.jobs.delete" "$job_resource" NOT_GRANTED
check "$RUNTIME" "datastore.entities.create" "$database_resource" GRANTED
check "$RUNTIME" "datastore.entities.update" "$database_resource" GRANTED
check "$RUNTIME" "datastore.entities.delete" "$database_resource" NOT_GRANTED
check "$RUNTIME" "datastore.entities.delete" "$inbox_database_resource" NOT_GRANTED
check "$RUNTIME" "datastore.databases.delete" "$database_resource" NOT_GRANTED
check "$RUNTIME" "datastore.databases.bulkDelete" "$database_resource" NOT_GRANTED
check "$WEB" "datastore.entities.delete" "$inbox_database_resource" NOT_GRANTED

check "$DEPLOYER" "run.jobs.update" "$job_resource" GRANTED
check "$DEPLOYER" "run.jobs.run" "$job_resource" GRANTED
check "$DEPLOYER" "run.jobs.delete" "$job_resource" NOT_GRANTED
check "$DEPLOYER" "run.executions.delete" "$job_resource" NOT_GRANTED
check "$DEPLOYER" "cloudbuild.triggers.delete" "$project_resource" NOT_GRANTED
check "$DEPLOYER" "datastore.entities.delete" "$database_resource" NOT_GRANTED
check "$DEPLOYER" "datastore.databases.delete" "$database_resource" NOT_GRANTED
check "$DEPLOYER" "secretmanager.versions.access" "$secret_resource" NOT_GRANTED
check "$DEPLOYER" "storage.objects.get" "$knowledge_bucket_resource" NOT_GRANTED
check "$DEPLOYER" "storage.objects.create" "$knowledge_bucket_resource" NOT_GRANTED

printf '\nAll checked permissions match the forward-only policy.\n'
