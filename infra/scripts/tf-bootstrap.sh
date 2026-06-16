#!/usr/bin/env bash
# =============================================================================
# HomeGrown — Terraform state bootstrap
# =============================================================================
#
# Creates the GCS bucket used for Terraform remote state and enables the
# minimum set of GCP APIs that must exist BEFORE `terraform init` can run.
# Safe to re-run — all operations are idempotent.
#
# USAGE:
#   PROJECT_ID=my-gcp-project bash infra/scripts/tf-bootstrap.sh
#
# OPTIONAL OVERRIDES (environment variables):
#   TF_STATE_BUCKET  — GCS bucket name for TF state
#                      (default: <PROJECT_ID>-tf-state)
#   REGION           — GCS bucket region (default: us-central1)
#
# OUTPUT:
#   Prints the `terraform init -backend-config=...` command to run next.
#
# PREREQUISITES:
#   - gcloud CLI installed and authenticated (`gcloud auth login`)
#   - The GCP project must already exist with billing enabled
#   - The operator account needs roles/storage.admin and roles/serviceusage.admin
#     (or roles/owner) on the project
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
TF_STATE_BUCKET="${TF_STATE_BUCKET:-${PROJECT_ID}-tf-state}"

# ── Colors ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RESET='\033[0m'

log()    { printf "${CYAN}[tf-bootstrap]${RESET} %s\n" "$*"; }
log_ok() { printf "${GREEN}[tf-bootstrap]${RESET} %s\n" "$*"; }
die()    { printf "${RED}[tf-bootstrap] FATAL:${RESET} %s\n" "$*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────

log "Running preflight checks..."

if ! command -v gcloud >/dev/null 2>&1; then
    die "gcloud CLI not found on PATH. Install from https://cloud.google.com/sdk/docs/install"
fi

if ! gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | grep -q '@'; then
    die "No active gcloud account. Run: gcloud auth login"
fi

if [[ -z "${PROJECT_ID}" ]]; then
    die "PROJECT_ID is not set. Export it before running:\n  PROJECT_ID=my-gcp-project bash infra/scripts/tf-bootstrap.sh"
fi

log "Project: ${PROJECT_ID}"
log "TF state bucket: ${TF_STATE_BUCKET}"
log "Region: ${REGION}"

gcloud config set project "${PROJECT_ID}" --quiet

# ── Step 1: Enable bootstrap APIs ────────────────────────────────────────────
# These must exist before Terraform can call GCP APIs. A minimal set — TF's
# apis.tf enables the full list once it can run.

log "Enabling bootstrap APIs (cloudresourcemanager, storage, serviceusage)..."

gcloud services enable \
    cloudresourcemanager.googleapis.com \
    storage.googleapis.com \
    serviceusage.googleapis.com \
    --project="${PROJECT_ID}" \
    --quiet

log_ok "Bootstrap APIs enabled."

# ── Step 2: Create versioned GCS bucket for TF state ─────────────────────────

if gcloud storage buckets describe "gs://${TF_STATE_BUCKET}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log_ok "GCS bucket 'gs://${TF_STATE_BUCKET}' already exists — skipping creation."
else
    log "Creating GCS bucket 'gs://${TF_STATE_BUCKET}' in ${REGION}..."

    gcloud storage buckets create "gs://${TF_STATE_BUCKET}" \
        --project="${PROJECT_ID}" \
        --location="${REGION}" \
        --uniform-bucket-level-access \
        --quiet

    log_ok "Bucket created."
fi

# Enable versioning so that TF state history is recoverable.
log "Ensuring object versioning is enabled on 'gs://${TF_STATE_BUCKET}'..."
gcloud storage buckets update "gs://${TF_STATE_BUCKET}" \
    --versioning \
    --quiet
log_ok "Versioning enabled."

# ── Done — print next steps ───────────────────────────────────────────────────

printf "\n${GREEN}tf-bootstrap complete.${RESET}\n\n"
printf "Next: initialise Terraform with the state bucket:\n\n"
printf "  cd infra/terraform\n"
printf "  terraform init \\\\\n"
printf "    -backend-config=\"bucket=%s\" \\\\\n" "${TF_STATE_BUCKET}"
printf "    -backend-config=\"prefix=homegrown/terraform\"\n\n"
printf "Then:\n"
printf "  terraform plan -var=\"project_id=%s\"\n" "${PROJECT_ID}"
printf "  terraform apply -var=\"project_id=%s\"\n\n" "${PROJECT_ID}"
printf "Or supply a terraform.tfvars file (see infra/terraform/terraform.tfvars.example).\n\n"
printf "After apply, run:\n"
printf "  bash infra/scripts/inject-secrets.sh\n\n"
