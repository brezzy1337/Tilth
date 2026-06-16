#!/usr/bin/env bash
# =============================================================================
# HomeGrown — one-time GCP bootstrap script
# =============================================================================
#
# SECRET HYGIENE — READ BEFORE MODIFYING:
#   - No secret value is ever echoed, written to a file, or passed as a
#     command-line argument (which would be visible in /proc or ps output).
#   - Operator-supplied secrets (STRIPE keys, geocoding key) are collected via
#     `read -rs` (silent, no echo) and piped directly into Secret Manager via
#     `--data-file=-` on stdin.
#   - Auto-generated secrets (JWT_SECRET, DB_PASS, root password) are held
#     only in shell variables for the lifetime of this process and fed to
#     gcloud via process substitution (--root-password-file=<(...)) or
#     --password-file=<(...)) — never passed as CLI words, never written to disk,
#     never printed.
#   - The only values printed to stdout are non-secret identifiers (project
#     number, resource names, SA emails, instance connection name).
#
# IDEMPOTENCY:
#   Every create operation is guarded with a `describe … >/dev/null 2>&1 ||`
#   pattern so re-running the script on an already-provisioned project is safe.
#   Secrets that already exist will NOT have a new version added — the script
#   skips creation and notes the secret exists; re-running prompts only for
#   secrets that are still absent.
#
# USAGE:
#   PROJECT_ID=my-gcp-project bash infra/scripts/gcp-bootstrap.sh
#
#   All variables in the CONFIG BLOCK below can be overridden via the
#   environment, e.g.:
#     PROJECT_ID=my-project REGION=us-east1 bash infra/scripts/gcp-bootstrap.sh
#
# =============================================================================

set -euo pipefail

# =============================================================================
# CONFIG BLOCK — override via environment variables
# =============================================================================

# REQUIRED — die if unset
PROJECT_ID="${PROJECT_ID:-}"

# Defaults — override as needed
REGION="${REGION:-us-central1}"
GITHUB_REPO="${GITHUB_REPO:-brezzy1337/HomeGrown}"
AR_REPO="${AR_REPO:-homegrown}"
CLOUDSQL_INSTANCE="${CLOUDSQL_INSTANCE:-homegrown-db}"
CLOUDSQL_TIER="${CLOUDSQL_TIER:-db-g1-small}"
DB_NAME="${DB_NAME:-homegrown}"
DB_USER="${DB_USER:-homegrown}"
DEPLOY_SA_NAME="${DEPLOY_SA_NAME:-homegrown-deploy}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-homegrown-server}"
WIF_POOL="${WIF_POOL:-github-actions}"
WIF_PROVIDER="${WIF_PROVIDER:-github}"
PROXY_VERSION="${PROXY_VERSION:-v2.15.2}"

# =============================================================================
# HELPERS
# =============================================================================

# ANSI color codes — degrade gracefully if terminal doesn't support them
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log() {
    printf "${CYAN}[bootstrap]${RESET} %s\n" "$*"
}

log_ok() {
    printf "${GREEN}[bootstrap]${RESET} %s\n" "$*"
}

log_warn() {
    printf "${YELLOW}[bootstrap] WARNING:${RESET} %s\n" "$*" >&2
}

die() {
    printf "${RED}[bootstrap] FATAL:${RESET} %s\n" "$*" >&2
    exit 1
}

# Print a prominent banner for reminders that must not be missed
banner() {
    printf "\n${BOLD}${YELLOW}======================================================================${RESET}\n"
    printf "${BOLD}${YELLOW}  %s${RESET}\n" "$*"
    printf "${BOLD}${YELLOW}======================================================================${RESET}\n\n"
}

# secret_exists <SECRET_NAME>
# Returns 0 if the secret already exists in Secret Manager, 1 otherwise.
secret_exists() {
    gcloud secrets describe "$1" --project="${PROJECT_ID}" >/dev/null 2>&1
}

# create_secret_from_stdin <SECRET_NAME>
# Reads the secret value from stdin and creates a new Secret Manager secret.
# The value is NEVER stored in a variable or file — it flows from stdin directly
# to the gcloud pipe, so it never appears in the process list.
create_secret_from_stdin() {
    local name="$1"
    gcloud secrets create "${name}" \
        --project="${PROJECT_ID}" \
        --replication-policy=automatic \
        --data-file=-
    log_ok "Secret '${name}' created."
}

# grant_secret_accessor <SECRET_NAME> <SA_EMAIL>
grant_secret_accessor() {
    local secret="$1"
    local sa_email="$2"
    gcloud secrets add-iam-policy-binding "${secret}" \
        --project="${PROJECT_ID}" \
        --member="serviceAccount:${sa_email}" \
        --role="roles/secretmanager.secretAccessor" \
        --quiet >/dev/null
}

# =============================================================================
# STEP 0: PREFLIGHT CHECKS
# =============================================================================

log "Running preflight checks..."

# gcloud must be on PATH and authenticated
if ! command -v gcloud >/dev/null 2>&1; then
    die "gcloud CLI not found on PATH. Install it from https://cloud.google.com/sdk/docs/install"
fi

if ! gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | grep -q '@'; then
    die "No active gcloud account found. Run: gcloud auth login"
fi

# gh CLI must be on PATH and authenticated
if ! command -v gh >/dev/null 2>&1; then
    die "gh CLI not found on PATH. Install it from https://cli.github.com/"
fi

if ! gh auth status >/dev/null 2>&1; then
    die "gh CLI is not authenticated. Run: gh auth login"
fi

# PROJECT_ID is required
if [[ -z "${PROJECT_ID}" ]]; then
    die "PROJECT_ID is not set. Export it before running:\n  PROJECT_ID=my-gcp-project bash infra/scripts/gcp-bootstrap.sh"
fi

log "Setting gcloud project to '${PROJECT_ID}'..."
gcloud config set project "${PROJECT_ID}" --quiet

# ── WIF repo scope confirmation ───────────────────────────────────────────────
# GITHUB_REPO is env-overridable; an incorrect value mis-scopes the WIF trust
# binding so that a different repo can impersonate the deploy SA.  Confirm the
# effective value with the operator before proceeding.
#
# Prefer the gh-authenticated repo context when the script is run from inside
# the repo — this gives the operator a concrete cross-check against the env var.
_GH_DETECTED_REPO=""
if _GH_DETECTED_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"; then
    log "gh detected repo (from current directory): ${_GH_DETECTED_REPO}"
else
    log "gh could not detect a repo from the current directory (not inside a git checkout, or no remote)."
fi

printf "\n${BOLD}${YELLOW}WIF TRUST SCOPE CONFIRMATION${RESET}\n"
printf "  The Workload Identity Federation trust will be scoped to:\n"
printf "    GITHUB_REPO = %s\n" "${GITHUB_REPO}"
if [[ -n "${_GH_DETECTED_REPO}" && "${_GH_DETECTED_REPO}" != "${GITHUB_REPO}" ]]; then
    printf "\n${RED}  WARNING: this does NOT match the gh-detected repo (%s).${RESET}\n" "${_GH_DETECTED_REPO}"
    printf "  A mis-scoped WIF binding grants a DIFFERENT repo the ability to\n"
    printf "  impersonate the deploy service account.\n"
fi
printf "\n  Type the repo slug exactly as shown above to confirm, or Ctrl-C to abort:\n"
printf "  > "
read -r _CONFIRM_REPO
if [[ "${_CONFIRM_REPO}" != "${GITHUB_REPO}" ]]; then
    die "Confirmation did not match GITHUB_REPO='${GITHUB_REPO}'. Aborting. Set GITHUB_REPO correctly and re-run."
fi
unset _CONFIRM_REPO _GH_DETECTED_REPO
log_ok "WIF scope confirmed: ${GITHUB_REPO}"
# ─────────────────────────────────────────────────────────────────────────────

log_ok "Preflight checks passed."

# =============================================================================
# STEP 1: ENABLE APIS
# =============================================================================

log "Step 1: Enabling required GCP APIs..."

APIS=(
    run.googleapis.com
    sqladmin.googleapis.com
    artifactregistry.googleapis.com
    secretmanager.googleapis.com
    iamcredentials.googleapis.com
    sts.googleapis.com
    cloudresourcemanager.googleapis.com
)

# Enable all APIs in a single call — gcloud handles already-enabled APIs safely
gcloud services enable "${APIS[@]}" \
    --project="${PROJECT_ID}" \
    --quiet

log_ok "Step 1 done: APIs enabled."

# =============================================================================
# STEP 2: ARTIFACT REGISTRY
# =============================================================================

log "Step 2: Setting up Artifact Registry repository '${AR_REPO}'..."

if gcloud artifacts repositories describe "${AR_REPO}" \
        --location="${REGION}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log_ok "Artifact Registry repository '${AR_REPO}' already exists — skipping."
else
    gcloud artifacts repositories create "${AR_REPO}" \
        --repository-format=docker \
        --location="${REGION}" \
        --project="${PROJECT_ID}" \
        --description="HomeGrown server images" \
        --quiet
    log_ok "Artifact Registry repository '${AR_REPO}' created."
fi

# =============================================================================
# STEP 3: CLOUD SQL
# =============================================================================

log "Step 3: Provisioning Cloud SQL instance '${CLOUDSQL_INSTANCE}'..."

# Generate a random root password held only in memory — never written to disk.
# We do NOT use this password after instance creation; the app user password
# (DB_PASS, below) is what ends up in secrets.
ROOT_PASS="$(openssl rand -base64 32)"

if gcloud sql instances describe "${CLOUDSQL_INSTANCE}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log_ok "Cloud SQL instance '${CLOUDSQL_INSTANCE}' already exists — skipping creation."
else
    log "Creating Cloud SQL Postgres 16 instance (this can take 5–10 minutes)..."
    # --root-password-file reads from a file descriptor, keeping ROOT_PASS out
    # of /proc/<pid>/cmdline for the lifetime of the gcloud process.
    # Process substitution (<(...)) is supported in bash 3.2+.
    gcloud sql instances create "${CLOUDSQL_INSTANCE}" \
        --database-version=POSTGRES_16 \
        --tier="${CLOUDSQL_TIER}" \
        --region="${REGION}" \
        --project="${PROJECT_ID}" \
        --root-password-file=<(printf '%s' "${ROOT_PASS}") \
        --quiet
    log_ok "Cloud SQL instance '${CLOUDSQL_INSTANCE}' created."
fi

# Unset the root password variable immediately — no longer needed
unset ROOT_PASS

# Capture the instance connection name: PROJECT:REGION:INSTANCE
INSTANCE_CONN_NAME=$(gcloud sql instances describe "${CLOUDSQL_INSTANCE}" \
    --project="${PROJECT_ID}" \
    --format="value(connectionName)")
log "Instance connection name: ${INSTANCE_CONN_NAME}"

# Create the application database
if gcloud sql databases describe "${DB_NAME}" \
        --instance="${CLOUDSQL_INSTANCE}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log_ok "Database '${DB_NAME}' already exists — skipping."
else
    gcloud sql databases create "${DB_NAME}" \
        --instance="${CLOUDSQL_INSTANCE}" \
        --project="${PROJECT_ID}" \
        --quiet
    log_ok "Database '${DB_NAME}' created."
fi

# Create the application user with a generated password.
# DB_PASS is held in memory and used later to build DATABASE_URL secrets.
# It is NEVER printed.
DB_PASS="$(openssl rand -base64 32)"

if gcloud sql users describe "${DB_USER}" \
        --instance="${CLOUDSQL_INSTANCE}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log_warn "User '${DB_USER}' already exists. The DB_PASS generated in this run"
    log_warn "does NOT match what was used when this user was originally created."
    log_warn "If the DATABASE_URL and MIGRATE_DATABASE_URL secrets have NOT been"
    log_warn "created yet, you must reset the user password first:"
    log_warn "  gcloud sql users set-password ${DB_USER} --instance=${CLOUDSQL_INSTANCE} --prompt-for-password"
    log_warn "Then re-run this script (it will prompt for secrets again if they don't exist)."
    log_warn "If the secrets already exist in Secret Manager, skip this script step."
else
    # `gcloud sql users create` does not support --password-file, so we create
    # the user without a password and immediately set it via `set-password`,
    # which DOES support --password-file.  This keeps DB_PASS out of
    # /proc/<pid>/cmdline entirely.
    gcloud sql users create "${DB_USER}" \
        --instance="${CLOUDSQL_INSTANCE}" \
        --project="${PROJECT_ID}" \
        --quiet
    gcloud sql users set-password "${DB_USER}" \
        --instance="${CLOUDSQL_INSTANCE}" \
        --project="${PROJECT_ID}" \
        --password-file=<(printf '%s' "${DB_PASS}") \
        --quiet
    log_ok "Database user '${DB_USER}' created and password set."
fi

# Note for PostGIS — this must be done manually as cloudsqlsuperuser (postgres):
POSTGIS_CMD="gcloud sql connect ${CLOUDSQL_INSTANCE} --user=postgres --project=${PROJECT_ID}"
log_warn "MANUAL STEP REQUIRED after instance is up: enable the PostGIS extension."
log_warn "Connect with: ${POSTGIS_CMD}"
log_warn "Then run inside psql:  CREATE EXTENSION IF NOT EXISTS postgis;"
log_warn "                       CREATE EXTENSION IF NOT EXISTS postgis_topology;"

log_ok "Step 3 done: Cloud SQL provisioned."

# =============================================================================
# STEP 4: SERVICE ACCOUNTS
# =============================================================================

log "Step 4: Creating service accounts..."

DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Runtime SA
if gcloud iam service-accounts describe "${RUNTIME_SA}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log_ok "Runtime SA '${RUNTIME_SA}' already exists — skipping."
else
    gcloud iam service-accounts create "${RUNTIME_SA_NAME}" \
        --project="${PROJECT_ID}" \
        --display-name="HomeGrown Cloud Run runtime SA" \
        --quiet
    log_ok "Runtime SA '${RUNTIME_SA}' created."
fi

# Deploy SA
if gcloud iam service-accounts describe "${DEPLOY_SA}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log_ok "Deploy SA '${DEPLOY_SA}' already exists — skipping."
else
    gcloud iam service-accounts create "${DEPLOY_SA_NAME}" \
        --project="${PROJECT_ID}" \
        --display-name="HomeGrown CI deploy SA" \
        --quiet
    log_ok "Deploy SA '${DEPLOY_SA}' created."
fi

# Least-privilege project-level IAM bindings for the deploy SA.
# gcloud add-iam-policy-binding is idempotent — adding an existing binding
# is a no-op (it results in a no-change policy update).
log "Binding deploy SA roles (artifactregistry.writer, run.developer, cloudsql.client)..."

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="roles/artifactregistry.writer" \
    --quiet >/dev/null

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="roles/run.developer" \
    --quiet >/dev/null

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="roles/cloudsql.client" \
    --quiet >/dev/null

# Allow deploy SA to deploy Cloud Run services *as* the runtime SA.
# This is a resource-level binding on the runtime SA, NOT a project-level one.
log "Binding iam.serviceAccountUser on runtime SA for deploy SA..."
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
    --project="${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="roles/iam.serviceAccountUser" \
    --quiet >/dev/null

# NOTE: deploy SA does NOT receive roles/secretmanager.secretAccessor at the
# project level. Secret access is granted per-secret (MIGRATE_DATABASE_URL only)
# in Step 6 below.

log_ok "Step 4 done: service accounts configured."

# =============================================================================
# STEP 5: WORKLOAD IDENTITY FEDERATION
# =============================================================================

log "Step 5: Configuring Workload Identity Federation..."

# Retrieve the project number (required for the WIF principal set URL)
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" \
    --format="value(projectNumber)")
log "Project number: ${PROJECT_NUMBER}"

WIF_POOL_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}"

# Create the identity pool
if gcloud iam workload-identity-pools describe "${WIF_POOL}" \
        --project="${PROJECT_ID}" \
        --location=global >/dev/null 2>&1; then
    log_ok "WIF pool '${WIF_POOL}' already exists — skipping."
else
    gcloud iam workload-identity-pools create "${WIF_POOL}" \
        --project="${PROJECT_ID}" \
        --location=global \
        --display-name="GitHub Actions" \
        --quiet
    log_ok "WIF pool '${WIF_POOL}' created."
fi

# Create the OIDC provider
if gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" \
        --project="${PROJECT_ID}" \
        --location=global \
        --workload-identity-pool="${WIF_POOL}" >/dev/null 2>&1; then
    log_ok "WIF provider '${WIF_PROVIDER}' already exists — skipping."
else
    gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
        --project="${PROJECT_ID}" \
        --location=global \
        --workload-identity-pool="${WIF_POOL}" \
        --display-name="GitHub OIDC" \
        --issuer-uri="https://token.actions.githubusercontent.com" \
        --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
        --attribute-condition="attribute.repository=='${GITHUB_REPO}'" \
        --quiet
    log_ok "WIF provider '${WIF_PROVIDER}' created."
fi

# Retrieve the full provider resource name for use in GitHub Actions variables
WIF_PROVIDER_RESOURCE=$(gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" \
    --project="${PROJECT_ID}" \
    --location=global \
    --workload-identity-pool="${WIF_POOL}" \
    --format="value(name)")
log "WIF provider resource name: ${WIF_PROVIDER_RESOURCE}"

# Bind the deploy SA to the GitHub Actions OIDC principal set.
# The principalSet scopes trust to pushes from this repo only.
# add-iam-policy-binding is idempotent — safe to re-run.
log "Binding deploy SA with workloadIdentityUser for repo '${GITHUB_REPO}'..."
gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SA}" \
    --project="${PROJECT_ID}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/${WIF_POOL_RESOURCE}/attribute.repository/${GITHUB_REPO}" \
    --quiet >/dev/null

log_ok "Step 5 done: WIF configured."

# =============================================================================
# STEP 6: SECRETS
# =============================================================================
#
# Secret hygiene:
#  - Auto-generated values (DB_PASS, JWT_SECRET) flow from shell variable
#    through a process substitution pipe — never echoed, never written to a file.
#  - Operator-supplied values (Stripe keys, geocoding key) are collected with
#    `read -rs` (silent) and piped from the shell variable through `printf` into
#    gcloud — NEVER via `echo -n` on the command line (which leaks in ps output).
#    The pattern is:  printf '%s' "${VAR}" | gcloud secrets create … --data-file=-
#  - After piping, operator-supplied variables are unset immediately.
#
# =============================================================================

log "Step 6: Creating secrets in Secret Manager..."

# ── DATABASE_URL (runtime, Unix socket form) ──────────────────────────────────
# Built from the generated DB_PASS; no operator prompt needed.
SECRET_DATABASE_URL="DATABASE_URL"

if secret_exists "${SECRET_DATABASE_URL}"; then
    log_ok "Secret '${SECRET_DATABASE_URL}' already exists — skipping creation."
else
    log "Creating secret '${SECRET_DATABASE_URL}'..."
    printf 'postgres://%s:%s@/%s?host=/cloudsql/%s' \
        "${DB_USER}" "${DB_PASS}" "${DB_NAME}" "${INSTANCE_CONN_NAME}" \
        | gcloud secrets create "${SECRET_DATABASE_URL}" \
            --project="${PROJECT_ID}" \
            --replication-policy=automatic \
            --data-file=- \
            --quiet
    log_ok "Secret '${SECRET_DATABASE_URL}' created."
fi

# ── MIGRATE_DATABASE_URL (CI, TCP form via Cloud SQL Auth Proxy) ──────────────
SECRET_MIGRATE_URL="MIGRATE_DATABASE_URL"

if secret_exists "${SECRET_MIGRATE_URL}"; then
    log_ok "Secret '${SECRET_MIGRATE_URL}' already exists — skipping creation."
else
    log "Creating secret '${SECRET_MIGRATE_URL}'..."
    printf 'postgres://%s:%s@127.0.0.1:5432/%s' \
        "${DB_USER}" "${DB_PASS}" "${DB_NAME}" \
        | gcloud secrets create "${SECRET_MIGRATE_URL}" \
            --project="${PROJECT_ID}" \
            --replication-policy=automatic \
            --data-file=- \
            --quiet
    log_ok "Secret '${SECRET_MIGRATE_URL}' created."
fi

# DB_PASS is no longer needed — unset it now
unset DB_PASS

# ── JWT_SECRET (auto-generated) ───────────────────────────────────────────────
SECRET_JWT="JWT_SECRET"

if secret_exists "${SECRET_JWT}"; then
    log_ok "Secret '${SECRET_JWT}' already exists — skipping creation."
else
    log "Creating secret '${SECRET_JWT}' (auto-generated)..."
    openssl rand -base64 48 \
        | gcloud secrets create "${SECRET_JWT}" \
            --project="${PROJECT_ID}" \
            --replication-policy=automatic \
            --data-file=- \
            --quiet
    log_ok "Secret '${SECRET_JWT}' created."
fi

# ── GOOGLE_GEOCODING_API_KEY (operator-supplied) ──────────────────────────────
SECRET_GEOCODING="GOOGLE_GEOCODING_API_KEY"

if secret_exists "${SECRET_GEOCODING}"; then
    log_ok "Secret '${SECRET_GEOCODING}' already exists — skipping creation."
else
    printf '\nEnter GOOGLE_GEOCODING_API_KEY (input hidden): '
    read -rs _GEOCODING_KEY
    printf '\n'
    if [[ -z "${_GEOCODING_KEY}" ]]; then
        die "GOOGLE_GEOCODING_API_KEY cannot be empty."
    fi
    printf '%s' "${_GEOCODING_KEY}" \
        | gcloud secrets create "${SECRET_GEOCODING}" \
            --project="${PROJECT_ID}" \
            --replication-policy=automatic \
            --data-file=- \
            --quiet
    unset _GEOCODING_KEY
    log_ok "Secret '${SECRET_GEOCODING}' created."
fi

# ── STRIPE_SECRET_KEY (operator-supplied) ─────────────────────────────────────
SECRET_STRIPE_KEY="STRIPE_SECRET_KEY"

if secret_exists "${SECRET_STRIPE_KEY}"; then
    log_ok "Secret '${SECRET_STRIPE_KEY}' already exists — skipping creation."
else
    printf '\nEnter STRIPE_SECRET_KEY (sk_test_… or sk_live_…, input hidden): '
    read -rs _STRIPE_KEY
    printf '\n'
    if [[ -z "${_STRIPE_KEY}" ]]; then
        die "STRIPE_SECRET_KEY cannot be empty."
    fi
    printf '%s' "${_STRIPE_KEY}" \
        | gcloud secrets create "${SECRET_STRIPE_KEY}" \
            --project="${PROJECT_ID}" \
            --replication-policy=automatic \
            --data-file=- \
            --quiet
    unset _STRIPE_KEY
    log_ok "Secret '${SECRET_STRIPE_KEY}' created."
fi

# ── STRIPE_WEBHOOK_SECRET (operator-supplied, may be empty on first run) ──────
# Chicken-and-egg: the real whsec_… only exists after the first deploy.
# If empty, a clearly-marked placeholder is stored so the server can boot.
# The operator MUST replace it with `gcloud secrets versions add` after
# registering the webhook in the Stripe dashboard.
SECRET_WEBHOOK="STRIPE_WEBHOOK_SECRET"

if secret_exists "${SECRET_WEBHOOK}"; then
    log_ok "Secret '${SECRET_WEBHOOK}' already exists — skipping creation."
else
    printf '\nEnter STRIPE_WEBHOOK_SECRET (whsec_…, or press ENTER to use a placeholder — see note below): '
    read -rs _WEBHOOK_SECRET
    printf '\n'

    if [[ -z "${_WEBHOOK_SECRET}" ]]; then
        _PLACEHOLDER="PLACEHOLDER_whsec_REPLACE_AFTER_FIRST_DEPLOY"
        printf '%s' "${_PLACEHOLDER}" \
            | gcloud secrets create "${SECRET_WEBHOOK}" \
                --project="${PROJECT_ID}" \
                --replication-policy=automatic \
                --data-file=- \
                --quiet
        unset _PLACEHOLDER
        banner "STRIPE_WEBHOOK_SECRET: PLACEHOLDER STORED"
        printf "  The secret was created with a placeholder value.\n"
        printf "  After your FIRST deploy, register the webhook endpoint:\n"
        printf "    URL: https://<cloud-run-url>/webhooks/stripe\n"
        printf "  Then add the real signing secret (read -rs avoids shell history leakage):\n"
        printf "    read -rs WHSEC && printf '%%s' \"\$WHSEC\" | gcloud secrets versions add STRIPE_WEBHOOK_SECRET --data-file=- && unset WHSEC\n\n"
    else
        printf '%s' "${_WEBHOOK_SECRET}" \
            | gcloud secrets create "${SECRET_WEBHOOK}" \
                --project="${PROJECT_ID}" \
                --replication-policy=automatic \
                --data-file=- \
                --quiet
        log_ok "Secret '${SECRET_WEBHOOK}' created with the provided value."
    fi
    unset _WEBHOOK_SECRET
fi

# ── IAM bindings: runtime SA gets secretAccessor on all five runtime secrets ──
log "Granting runtime SA secretAccessor on runtime secrets..."

RUNTIME_SECRETS=(
    "DATABASE_URL"
    "JWT_SECRET"
    "GOOGLE_GEOCODING_API_KEY"
    "STRIPE_SECRET_KEY"
    "STRIPE_WEBHOOK_SECRET"
)

for _SECRET in "${RUNTIME_SECRETS[@]}"; do
    grant_secret_accessor "${_SECRET}" "${RUNTIME_SA}"
    log_ok "  ${RUNTIME_SA} → secretAccessor on '${_SECRET}'"
done

# Deploy SA gets secretAccessor ONLY on MIGRATE_DATABASE_URL
log "Granting deploy SA secretAccessor on MIGRATE_DATABASE_URL only..."
grant_secret_accessor "MIGRATE_DATABASE_URL" "${DEPLOY_SA}"
log_ok "  ${DEPLOY_SA} → secretAccessor on 'MIGRATE_DATABASE_URL'"

log_ok "Step 6 done: secrets created and IAM bindings applied."

# =============================================================================
# STEP 7: GITHUB WIRING
# =============================================================================

log "Step 7: Wiring GitHub Actions variables and environment..."

# Set the 7 non-sensitive Actions variables.
# DEPLOY_ENABLED is intentionally NOT set here — arming the pipeline is the
# deliberate last manual step after all pre-arming hardening is complete
# (PostGIS extension, real Stripe webhook secret, required reviewers, proxy SHA).
#
# Uses explicit parallel arrays (bash 3.2 compatible) rather than declare -A
# (which requires bash 4+) so the script works on macOS with the system bash.
_GH_VAR_NAMES=(
    GCP_PROJECT_ID
    GCP_REGION
    GCP_AR_REPO
    GCP_CLOUDSQL_INSTANCE
    GCP_WIF_PROVIDER
    GCP_DEPLOY_SA
    GCP_RUNTIME_SA
)
_GH_VAR_VALUES=(
    "${PROJECT_ID}"
    "${REGION}"
    "${AR_REPO}"
    "${CLOUDSQL_INSTANCE}"
    "${WIF_PROVIDER_RESOURCE}"
    "${DEPLOY_SA}"
    "${RUNTIME_SA}"
)

_GH_VAR_COUNT="${#_GH_VAR_NAMES[@]}"
for (( _i = 0; _i < _GH_VAR_COUNT; _i++ )); do
    _VAR_NAME="${_GH_VAR_NAMES[${_i}]}"
    _VAR_VALUE="${_GH_VAR_VALUES[${_i}]}"
    gh variable set "${_VAR_NAME}" \
        --body "${_VAR_VALUE}" \
        --repo "${GITHUB_REPO}"
    log_ok "  GitHub variable set: ${_VAR_NAME}=${_VAR_VALUE}"
done

# Create the production environment (idempotent — PUT is safe to re-run)
log "Creating GitHub 'production' environment..."
gh api \
    --method PUT \
    "repos/${GITHUB_REPO}/environments/production" \
    --silent
log_ok "GitHub 'production' environment created/confirmed."

log_warn "DEPLOY_ENABLED was intentionally NOT set."
log_warn "Arming the pipeline is the final manual step after all pre-arming"
log_warn "hardening is complete (see REMAINING MANUAL STEPS below)."
log_warn "When ready: gh variable set DEPLOY_ENABLED --body true --repo ${GITHUB_REPO}"

log_warn "Required reviewers for the 'production' environment must be added"
log_warn "in the GitHub UI: Settings → Environments → production → Protection rules"
log_warn "or via: gh api --method PUT repos/${GITHUB_REPO}/environments/production"
log_warn "  with a reviewers payload (requires reviewer GitHub user IDs)."
log_warn "IMPORTANT: do NOT enable ACTIONS_STEP_DEBUG on the production environment."
log_warn "Runner debug logging bypasses log masking (::add-mask::) for secret values."

log_ok "Step 7 done: GitHub wiring complete."

# =============================================================================
# FINAL SUMMARY
# =============================================================================

banner "BOOTSTRAP COMPLETE — REVIEW COMPUTED VALUES AND REMAINING STEPS"

printf "${BOLD}Computed values:${RESET}\n"
printf "  GCP Project ID:             %s\n" "${PROJECT_ID}"
printf "  GCP Project Number:         %s\n" "${PROJECT_NUMBER}"
printf "  Region:                     %s\n" "${REGION}"
printf "  Artifact Registry repo:     %s\n" "${AR_REPO}"
printf "  Cloud SQL instance:         %s\n" "${CLOUDSQL_INSTANCE}"
printf "  Instance connection name:   %s\n" "${INSTANCE_CONN_NAME}"
printf "  Runtime SA:                 %s\n" "${RUNTIME_SA}"
printf "  Deploy SA:                  %s\n" "${DEPLOY_SA}"
printf "  WIF pool:                   %s\n" "${WIF_POOL_RESOURCE}"
printf "  WIF provider resource name: %s\n" "${WIF_PROVIDER_RESOURCE}"
printf "  GitHub repo:                %s\n" "${GITHUB_REPO}"
printf "\n"

printf "${BOLD}${YELLOW}REMAINING MANUAL STEPS (complete all before arming DEPLOY_ENABLED):${RESET}\n\n"

printf "${BOLD}(a) Enable PostGIS extension${RESET}\n"
printf "    Connect to the instance as postgres:\n"
printf "      %s\n" "${POSTGIS_CMD}"
printf "    Inside psql, run:\n"
printf "      CREATE EXTENSION IF NOT EXISTS postgis;\n"
printf "      CREATE EXTENSION IF NOT EXISTS postgis_topology;\n"
printf "    (Required once; IF NOT EXISTS makes subsequent migrations safe.)\n\n"

printf "${BOLD}(b) Register the Stripe webhook and store the real signing secret${RESET}\n"
printf "    After your first deploy, get the Cloud Run URL:\n"
printf "      gcloud run services describe homegrown-server --region=%s --format=\"value(status.url)\"\n" "${REGION}"
printf "    Register the endpoint https://<url>/webhooks/stripe in the Stripe dashboard\n"
printf "    (Developers → Webhooks → Add endpoint), subscribing to:\n"
printf "      payment_intent.succeeded, payment_intent.payment_failed, account.updated\n"
printf "    Then store the signing secret (whsec_...).\n"
printf "    Use read -rs to avoid the value landing in shell history:\n"
printf "      read -rs WHSEC && printf '%%s' \"\$WHSEC\" | gcloud secrets versions add STRIPE_WEBHOOK_SECRET --data-file=- && unset WHSEC\n\n"

printf "${BOLD}(c) Add required reviewers to the 'production' GitHub Environment${RESET}\n"
printf "    Settings → Environments → production → Protection rules → Required reviewers\n"
printf "    Do NOT enable ACTIONS_STEP_DEBUG on this environment.\n\n"

printf "${BOLD}(d) Pin the Cloud SQL Auth Proxy SHA-256 in deploy.yml (infra/README.md §G)${RESET}\n"
printf "    Download %s out-of-band and verify against\n" "${PROXY_VERSION}"
printf "    the GitHub release page: https://github.com/GoogleCloudPlatform/cloud-sql-proxy/releases/tag/%s\n" "${PROXY_VERSION}"
printf "    Replace <VERIFIED_SHA256_HEX> in .github/workflows/deploy.yml with the verified hash.\n\n"

printf "${BOLD}(e) Arm the pipeline${RESET}\n"
printf "    Only after steps (a)–(d) are complete:\n"
printf "      gh variable set DEPLOY_ENABLED --body true --repo %s\n\n" "${GITHUB_REPO}"

printf "${GREEN}Bootstrap script finished.${RESET}\n"
