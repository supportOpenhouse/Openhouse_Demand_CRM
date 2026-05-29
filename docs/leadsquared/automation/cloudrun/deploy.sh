#!/usr/bin/env bash
# One-time provisioning of the Cloud Run automation. Run from the PROJECT ROOT
# (the leadsquared/ dir) with gcloud authed to the project. Re-runnable.
# Re-run after code changes: just the "BUILD" + "DEPLOY JOB" sections.
set -euo pipefail

# ---- CONFIG (confirm/edit) ----
PROJECT="polished-logic-434606-g3"
REGION="asia-south1"                       # Mumbai; change if you prefer
SA="sqlanalytics@polished-logic-434606-g3.iam.gserviceaccount.com"
BUCKET="oh-lsq-dashboard-data"             # NEW private bucket (globally-unique; edit if taken)
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/lsq/dashboard-pipeline:latest"
JOB="lsq-dashboard-pipeline"

gcloud config set project "$PROJECT"

# ---- 1. Enable APIs ----
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com sheets.googleapis.com

# ---- 2. Private GCS bucket ----
gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access || true
gcloud storage buckets update "gs://${BUCKET}" --public-access-prevention || true  # keep PRIVATE

# ---- 3. LSQ keys: read from local ./.env -> passed as Cloud Run env vars ----
# (Secret Manager IAM is not grantable with the available project permissions, so the
#  job carries the keys as env vars. Visible to anyone with run.jobs.get on the project.)
ENVF=".env"
[ -f "$ENVF" ] && echo "Reading LSQ keys from $ENVF" || echo "No $ENVF found — will prompt"
getval(){ grep -E "^$1=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r'; }
LAK="$(getval LSQ_ACCESS_KEY)"; LSK="$(getval LSQ_SECRET_KEY)"; LAH="$(getval LSQ_API_HOST)"
[ -z "$LAK" ] && { echo "LSQ_ACCESS_KEY:"; read -rs LAK; echo; }
[ -z "$LSK" ] && { echo "LSQ_SECRET_KEY:"; read -rs LSK; echo; }
[ -z "$LAH" ] && { echo "LSQ_API_HOST:"; read -r  LAH; }

# ---- 4. IAM (resource-level only; bucket + actAs — both work with current perms) ----
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${SA}" --role="roles/storage.objectAdmin" --condition=None || true
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="user:$(gcloud config get-value account 2>/dev/null)" \
  --role="roles/iam.serviceAccountUser" --condition=None || true

# ---- 5. Artifact Registry + BUILD image (via cloudbuild.yaml; -f not valid on submit) ----
gcloud artifacts repositories describe lsq --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create lsq --repository-format=docker --location="$REGION"
gcloud builds submit --config automation/cloudrun/cloudbuild.yaml --substitutions=_IMAGE="$IMAGE" .

# ---- 6. DEPLOY JOB (timeout 60m for daily task scan; 2Gi mem; keys as env vars) ----
gcloud run jobs deploy "$JOB" --image="$IMAGE" --region="$REGION" \
  --service-account="$SA" --tasks=1 --max-retries=1 --task-timeout=3600 --memory=2Gi --cpu=2 \
  --set-env-vars="^##^GCS_BUCKET=${BUCKET}##MODE=hourly##LSQ_ACCESS_KEY=${LAK}##LSQ_SECRET_KEY=${LSK}##LSQ_API_HOST=${LAH}"

# ---- 7. Seed once (daily = full; creates bundle + caches objects) ----
gcloud run jobs execute "$JOB" --region="$REGION" --update-env-vars="MODE=daily" --wait

# ---- 8. Cloud Scheduler (hourly light + daily full). ----
# The runtime SA (sqlanalytics) has NO run.* role, and job-level setIamPolicy is NOT
# grantable with the available perms (no run.jobs.setIamPolicy; no project setIamPolicy).
# So the SCHEDULER authenticates as the default *compute* SA, which already holds
# roles/run.admin + roles/run.invoker by default. The deploying user only needs
# iam.serviceAccountUser on it (project-level serviceAccountUser covers this).
# NOTE: the job's RUNTIME identity is still $SA (set on the job in step 6) — unchanged.
INVOKER_SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"
# create-or-update so a re-run repairs the OAuth SA on pre-existing scheduler jobs
gcloud scheduler jobs create http lsq-hourly --location="$REGION" --schedule="0 * * * *" \
  --uri="$URI" --http-method=POST --oauth-service-account-email="$INVOKER_SA" \
  --message-body='{"overrides":{"containerOverrides":[{"env":[{"name":"MODE","value":"hourly"}]}]}}' || \
  gcloud scheduler jobs update http lsq-hourly --location="$REGION" --oauth-service-account-email="$INVOKER_SA"
gcloud scheduler jobs create http lsq-daily --location="$REGION" --schedule="30 21 * * *" \
  --uri="$URI" --http-method=POST --oauth-service-account-email="$INVOKER_SA" \
  --message-body='{"overrides":{"containerOverrides":[{"env":[{"name":"MODE","value":"daily"}]}]}}' || \
  gcloud scheduler jobs update http lsq-daily --location="$REGION" --oauth-service-account-email="$INVOKER_SA"

echo "Done. Bucket gs://${BUCKET}. Next: set Netlify env GCS_BUCKET + swap data.gcs.mjs (see README)."
