#!/usr/bin/env bash
set -euo pipefail
PROJECT_ID="${PROJECT_ID:-gen-lang-client-0266144152}"
REGION="${REGION:-europe-west2}"
SERVICE="${SERVICE:-zioncore-command-api}"
JOB="${JOB:-zioncore-command-runner}"
SCHEDULER="${SCHEDULER:-zioncore-command-archive-cycle}"
gcloud config set project "$PROJECT_ID"
echo "=== INVENTORY ==="
gcloud billing projects describe "$PROJECT_ID" 2>/dev/null || true
gcloud services list --enabled --project="$PROJECT_ID" --format="value(config.name)" | head -40
gcloud run services list --project="$PROJECT_ID" --region="$REGION" 2>/dev/null || true
gcloud run jobs list --project="$PROJECT_ID" --region="$REGION" 2>/dev/null || true
gcloud firestore databases list --project="$PROJECT_ID" 2>/dev/null || true
gcloud scheduler jobs list --project="$PROJECT_ID" --location="$REGION" 2>/dev/null || true
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com firestore.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project="$PROJECT_ID"
for SA in zioncore-command-api zioncore-command-runner zioncore-command-scheduler; do
  gcloud iam service-accounts describe "${SA}@${PROJECT_ID}.iam.gserviceaccount.com" --project="$PROJECT_ID" 2>/dev/null || \
  gcloud iam service-accounts create "$SA" --project="$PROJECT_ID" --display-name="$SA"
done
gcloud secrets describe zioncore-command-ai-provider-key --project="$PROJECT_ID" 2>/dev/null || \
  gcloud secrets create zioncore-command-ai-provider-key --project="$PROJECT_ID" --replication-policy=automatic
SA_API="zioncore-command-api@${PROJECT_ID}.iam.gserviceaccount.com"
SA_RUNNER="zioncore-command-runner@${PROJECT_ID}.iam.gserviceaccount.com"
SA_SCHEDULER="zioncore-command-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud run deploy "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --source=. --allow-unauthenticated --min-instances=0 --max-instances=3 --memory=512Mi --cpu=1 --timeout=300 --service-account="$SA_API" --set-env-vars="NODE_ENV=production,GCP_PROJECT=${PROJECT_ID}"
gcloud run jobs deploy "$JOB" --project="$PROJECT_ID" --region="$REGION" --source=. --command=node --args="server/jobMain.js,archive-incident" --max-retries=1 --task-timeout=600 --memory=512Mi --service-account="$SA_RUNNER" --set-env-vars="NODE_ENV=production,GCP_PROJECT=${PROJECT_ID}"
API_URL=$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')
echo "PRIVATE_URL=${API_URL}"
echo "Command UI: ${API_URL}/command.html"
gcloud run jobs add-iam-policy-binding "$JOB" --project="$PROJECT_ID" --region="$REGION" --member="serviceAccount:${SA_SCHEDULER}" --role="roles/run.invoker"
gcloud scheduler jobs delete "$SCHEDULER" --project="$PROJECT_ID" --location="$REGION" --quiet 2>/dev/null || true
gcloud scheduler jobs create http "$SCHEDULER" --project="$PROJECT_ID" --location="$REGION" --schedule="33 * * * *" --time-zone="Europe/London" --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB}:run" --http-method=POST --oauth-service-account-email="${SA_SCHEDULER}" --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
echo "Sign-in: commander / MKEY-MNM-001-TAC-2024"
