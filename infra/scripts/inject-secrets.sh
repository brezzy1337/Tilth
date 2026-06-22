#!/usr/bin/env bash
# =============================================================================
# HomeGrown — out-of-band secret injection
# =============================================================================
#
# This script performs the steps that Terraform intentionally does NOT do,
# to guarantee no secret value ever enters TF state:
#
#   1. Create the Cloud SQL application user with a generated password.
#      gcloud has NO file/stdin password option for Cloud SQL users, so the
#      generated (URL-safe hex) password is passed via --password on a single
#      `users create`. It is briefly visible in /proc/<pid>/cmdline to same-user
#      processes during that one call — acceptable on a trusted operator machine.
#
#   2. Add secret VERSIONS (not just empty secrets — TF already created the
#      secret shells) for:
#        DATABASE_URL      — postgres socket form (runtime)
#        MIGRATE_DATABASE_URL — postgres TCP form (CI migrations)
#        JWT_SECRET        — auto-generated with openssl rand
#
#   3. Prompt (read -rs) for operator-supplied values:
#        GOOGLE_GEOCODING_API_KEY
#        STRIPE_SECRET_KEY
#        STRIPE_WEBHOOK_SECRET         (may be a placeholder — see note below)
#        STRIPE_WEBHOOK_SECRET_CONNECT (may be a placeholder — see note below)
#
#   All secret values flow via --data-file=- (stdin pipe) or process
#   substitution — never echoed, never written to a file, never passed as a
#   CLI argument visible in ps/proc output.
#
# PREREQUISITES:
#   - Terraform has already been applied (secret shells + IAM exist)
#   - gcloud CLI installed and authenticated with an account that has:
#       roles/cloudsql.admin (to create the SQL user)
#       roles/secretmanager.admin (to add secret versions)
#
# USAGE:
#   PROJECT_ID=my-gcp-project bash infra/scripts/inject-secrets.sh
#
# OPTIONAL OVERRIDES:
#   REGION           (default: us-central1)
#   CLOUDSQL_INSTANCE (default: homegrown-db)
#   DB_NAME          (default: homegrown)
#   DB_USER          (default: homegrown)
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
CLOUDSQL_INSTANCE="${CLOUDSQL_INSTANCE:-homegrown-db}"
DB_NAME="${DB_NAME:-homegrown}"
DB_USER="${DB_USER:-homegrown}"

# ── Colors ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log()      { printf "${CYAN}[inject]${RESET} %s\n" "$*"; }
log_ok()   { printf "${GREEN}[inject]${RESET} %s\n" "$*"; }
log_warn() { printf "${YELLOW}[inject] WARNING:${RESET} %s\n" "$*" >&2; }
die()      { printf "${RED}[inject] FATAL:${RESET} %s\n" "$*" >&2; exit 1; }

banner() {
    printf "\n${BOLD}${YELLOW}======================================================================${RESET}\n"
    printf "${BOLD}${YELLOW}  %s${RESET}\n" "$*"
    printf "${BOLD}${YELLOW}======================================================================${RESET}\n\n"
}

# secret_has_version <SECRET_NAME>
# Returns 0 if at least one version exists for the secret, 1 otherwise.
secret_has_version() {
    local count
    count=$(gcloud secrets versions list "$1" \
        --project="${PROJECT_ID}" \
        --filter="state=ENABLED" \
        --format="value(name)" 2>/dev/null | wc -l)
    [[ "${count}" -gt 0 ]]
}

# add_secret_version_from_fd <SECRET_NAME>
# Reads value from stdin and adds a new version to an existing secret.
# The value is piped directly — never stored in a variable or file.
add_secret_version_from_fd() {
    local name="$1"
    gcloud secrets versions add "${name}" \
        --project="${PROJECT_ID}" \
        --data-file=-
    log_ok "Secret version added: '${name}'"
}

# ── Preflight ─────────────────────────────────────────────────────────────────

log "Running preflight checks..."

if ! command -v gcloud >/dev/null 2>&1; then
    die "gcloud CLI not found on PATH."
fi

if ! gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | grep -q '@'; then
    die "No active gcloud account. Run: gcloud auth login"
fi

if ! command -v openssl >/dev/null 2>&1; then
    die "openssl not found on PATH. Install it before running this script."
fi

if [[ -z "${PROJECT_ID}" ]]; then
    die "PROJECT_ID is not set. Export it:\n  PROJECT_ID=my-gcp-project bash infra/scripts/inject-secrets.sh"
fi

gcloud config set project "${PROJECT_ID}" --quiet

# Derive the Cloud SQL instance connection name
INSTANCE_CONN_NAME="${PROJECT_ID}:${REGION}:${CLOUDSQL_INSTANCE}"
log "Instance connection name: ${INSTANCE_CONN_NAME}"

log_ok "Preflight checks passed."

# =============================================================================
# STEP 1: Cloud SQL application user
# =============================================================================
# Terraform manages the instance + database but NOT the app user, so the DB
# password never enters TF state.
#
# Strategy: a single `gcloud sql users create --password=<hex>`. gcloud has no
# file/stdin password option for Cloud SQL users, so the value is briefly in
# /proc/<pid>/cmdline during this one call (acceptable on a trusted machine).

log "Step 1: Creating Cloud SQL application user '${DB_USER}'..."

# Generate a strong random password. Use hex (URL-safe) — a base64 password can
# contain '/', '+', '=', which break parsing of the postgres://user:pass@… URL.
# Held only in a shell variable; never written to disk, never printed.
DB_PASS="$(openssl rand -hex 32)"

if gcloud sql users describe "${DB_USER}" \
        --instance="${CLOUDSQL_INSTANCE}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log_warn "User '${DB_USER}' already exists."
    log_warn "A new DB_PASS was generated this run but the user's actual password"
    log_warn "in Cloud SQL was NOT changed — the existing DATABASE_URL and"
    log_warn "MIGRATE_DATABASE_URL secrets still hold the original password."
    log_warn ""
    log_warn "If you need to rotate the password:"
    log_warn "  1. Re-generate: gcloud sql users set-password ${DB_USER} \\"
    log_warn "       --instance=${CLOUDSQL_INSTANCE} --prompt-for-password"
    log_warn "  2. Then update both secrets with: gcloud secrets versions add ..."
    log_warn ""
    log_warn "Skipping SQL user creation."
    # We must also skip the DATABASE_URL / MIGRATE_DATABASE_URL secret steps
    # below because we do not know the existing password.
    SKIP_DB_SECRETS=1
else
    # gcloud offers no file/stdin password option for Cloud SQL users — neither
    # `users create` nor `set-password` accepts --password-file, and
    # --prompt-for-password does not read piped stdin. So --password is the only
    # headless method. The hex value is URL-safe; the brief /proc exposure to
    # same-user processes is acceptable on a trusted operator machine.
    gcloud sql users create "${DB_USER}" \
        --instance="${CLOUDSQL_INSTANCE}" \
        --project="${PROJECT_ID}" \
        --password="${DB_PASS}" \
        --quiet
    log_ok "User '${DB_USER}' created."
    SKIP_DB_SECRETS=0
fi

# =============================================================================
# STEP 2: DATABASE_URL and MIGRATE_DATABASE_URL secrets
# =============================================================================
# Only populated when we just created the user (SKIP_DB_SECRETS=0).
# If the user already existed we don't know the current password, so we leave
# the existing secret versions intact.

if [[ "${SKIP_DB_SECRETS}" -eq 0 ]]; then
    log "Step 2: Adding DATABASE_URL secret version (Unix socket form)..."
    # Socket form — valid only inside a Cloud Run container where the Cloud SQL
    # connector sidecar creates the socket at /cloudsql/<INSTANCE_CONN_NAME>.
    if secret_has_version "DATABASE_URL"; then
        log_warn "DATABASE_URL already has an enabled version — skipping."
        log_warn "If you need to update it, run:"
        log_warn "  read -rs V && printf '%s' \"\$V\" | gcloud secrets versions add DATABASE_URL --data-file=- && unset V"
    else
        printf 'postgres://%s:%s@/%s?host=/cloudsql/%s' \
            "${DB_USER}" "${DB_PASS}" "${DB_NAME}" "${INSTANCE_CONN_NAME}" \
            | add_secret_version_from_fd "DATABASE_URL"
    fi

    log "Step 2: Adding MIGRATE_DATABASE_URL secret version (TCP form)..."
    # TCP form — used by the Cloud SQL Auth Proxy in GitHub Actions migrations.
    # 127.0.0.1:5432 is where the proxy listens inside the CI runner.
    if secret_has_version "MIGRATE_DATABASE_URL"; then
        log_warn "MIGRATE_DATABASE_URL already has an enabled version — skipping."
    else
        printf 'postgres://%s:%s@127.0.0.1:5432/%s' \
            "${DB_USER}" "${DB_PASS}" "${DB_NAME}" \
            | add_secret_version_from_fd "MIGRATE_DATABASE_URL"
    fi
fi

# DB_PASS is no longer needed — unset it immediately.
unset DB_PASS

# =============================================================================
# STEP 3: JWT_SECRET (auto-generated)
# =============================================================================

log "Step 3: Adding JWT_SECRET secret version (auto-generated)..."

if secret_has_version "JWT_SECRET"; then
    log_ok "JWT_SECRET already has an enabled version — skipping."
else
    openssl rand -base64 48 | add_secret_version_from_fd "JWT_SECRET"
fi

# =============================================================================
# STEP 4: Operator-supplied secrets (prompted via read -rs)
# =============================================================================
# Values are collected silently and piped directly to gcloud — they never
# appear in shell history, in the process list, or on screen.

log "Step 4: Operator-supplied secrets (you will be prompted)..."

# ── GOOGLE_GEOCODING_API_KEY ──────────────────────────────────────────────────
if secret_has_version "GOOGLE_GEOCODING_API_KEY"; then
    log_ok "GOOGLE_GEOCODING_API_KEY already has an enabled version — skipping."
else
    printf '\nEnter GOOGLE_GEOCODING_API_KEY (input hidden): '
    read -rs _GEOCODING_KEY
    printf '\n'
    if [[ -z "${_GEOCODING_KEY}" ]]; then
        die "GOOGLE_GEOCODING_API_KEY cannot be empty."
    fi
    printf '%s' "${_GEOCODING_KEY}" | add_secret_version_from_fd "GOOGLE_GEOCODING_API_KEY"
    unset _GEOCODING_KEY
fi

# ── STRIPE_SECRET_KEY ─────────────────────────────────────────────────────────
if secret_has_version "STRIPE_SECRET_KEY"; then
    log_ok "STRIPE_SECRET_KEY already has an enabled version — skipping."
else
    printf '\nEnter STRIPE_SECRET_KEY (sk_test_… or sk_live_…, input hidden): '
    read -rs _STRIPE_KEY
    printf '\n'
    if [[ -z "${_STRIPE_KEY}" ]]; then
        die "STRIPE_SECRET_KEY cannot be empty."
    fi
    printf '%s' "${_STRIPE_KEY}" | add_secret_version_from_fd "STRIPE_SECRET_KEY"
    unset _STRIPE_KEY
fi

# ── STRIPE_WEBHOOK_SECRET ─────────────────────────────────────────────────────
# Chicken-and-egg: the real whsec_… only exists after the first Cloud Run
# deploy registers the webhook in the Stripe dashboard. If you don't have it
# yet, press ENTER to store a clearly-marked placeholder. You MUST replace it
# before enabling real payment traffic.
if secret_has_version "STRIPE_WEBHOOK_SECRET"; then
    log_ok "STRIPE_WEBHOOK_SECRET already has an enabled version — skipping."
else
    printf '\nEnter STRIPE_WEBHOOK_SECRET (whsec_…, or press ENTER for placeholder): '
    read -rs _WEBHOOK_SECRET
    printf '\n'

    if [[ -z "${_WEBHOOK_SECRET}" ]]; then
        _PLACEHOLDER="PLACEHOLDER_whsec_REPLACE_AFTER_FIRST_DEPLOY"
        printf '%s' "${_PLACEHOLDER}" | add_secret_version_from_fd "STRIPE_WEBHOOK_SECRET"
        unset _PLACEHOLDER

        banner "STRIPE_WEBHOOK_SECRET: PLACEHOLDER STORED"
        printf "  The secret holds a placeholder. After your first deploy:\n"
        printf "  1. Get the Cloud Run URL:\n"
        printf "       gcloud run services describe homegrown-server \\\\\n"
        printf "         --region=%s --format=\"value(status.url)\"\n" "${REGION}"
        printf "  2. Register https://<url>/webhooks/stripe in the Stripe dashboard.\n"
        printf "     Subscribe to: payment_intent.succeeded, payment_intent.payment_failed, account.updated\n"
        printf "  3. Store the real signing secret (whsec_...):\n"
        printf "       read -rs WHSEC && printf '%%s' \"\$WHSEC\" \\\\\n"
        printf "         | gcloud secrets versions add STRIPE_WEBHOOK_SECRET --data-file=- && unset WHSEC\n\n"
    else
        printf '%s' "${_WEBHOOK_SECRET}" | add_secret_version_from_fd "STRIPE_WEBHOOK_SECRET"
        log_ok "STRIPE_WEBHOOK_SECRET stored."
    fi
    unset _WEBHOOK_SECRET
fi

# ── STRIPE_WEBHOOK_SECRET_CONNECT ─────────────────────────────────────────────
# Signing secret for the Connected-accounts scoped webhook destination
# (account.updated, capability.updated, etc.). Registered as a separate webhook
# destination in the Stripe dashboard with "Connected accounts" scope.
# Chicken-and-egg: the real whsec_… only exists after the Connect webhook
# endpoint is registered in the Stripe dashboard. If you don't have it yet,
# press ENTER to store a clearly-marked placeholder. You MUST replace it before
# enabling real Connect payment traffic.
if secret_has_version "STRIPE_WEBHOOK_SECRET_CONNECT"; then
    log_ok "STRIPE_WEBHOOK_SECRET_CONNECT already has an enabled version — skipping."
else
    printf '\nEnter STRIPE_WEBHOOK_SECRET_CONNECT (whsec_…, or press ENTER for placeholder): '
    read -rs _WEBHOOK_SECRET_CONNECT
    printf '\n'

    if [[ -z "${_WEBHOOK_SECRET_CONNECT}" ]]; then
        _PLACEHOLDER="PLACEHOLDER_whsec_CONNECT_REPLACE_AFTER_FIRST_DEPLOY"
        printf '%s' "${_PLACEHOLDER}" | add_secret_version_from_fd "STRIPE_WEBHOOK_SECRET_CONNECT"
        unset _PLACEHOLDER

        banner "STRIPE_WEBHOOK_SECRET_CONNECT: PLACEHOLDER STORED"
        printf "  The secret holds a placeholder. After your first deploy:\n"
        printf "  1. Register a second webhook destination in the Stripe dashboard\n"
        printf "     with scope 'Connected accounts'. Subscribe to:\n"
        printf "     account.updated, capability.updated, account.application.deauthorized\n"
        printf "  2. Store the real signing secret (whsec_...):\n"
        printf "       read -rs WHSEC && printf '%%s' \"\$WHSEC\" \\\\\n"
        printf "         | gcloud secrets versions add STRIPE_WEBHOOK_SECRET_CONNECT --data-file=- && unset WHSEC\n\n"
    else
        printf '%s' "${_WEBHOOK_SECRET_CONNECT}" | add_secret_version_from_fd "STRIPE_WEBHOOK_SECRET_CONNECT"
        log_ok "STRIPE_WEBHOOK_SECRET_CONNECT stored."
    fi
    unset _WEBHOOK_SECRET_CONNECT
fi

# =============================================================================
# STEP 5: PostGIS reminder
# =============================================================================
# PostGIS must be enabled once as the `postgres` user (cloudsqlsuperuser).
# This cannot be scripted via gcloud non-interactively without a workaround;
# run it manually before the first migration.

banner "MANUAL STEP REQUIRED: Enable PostGIS extension"
printf "  Connect to the instance as the postgres superuser:\n\n"
printf "    gcloud sql connect %s --user=postgres --project=%s\n\n" \
    "${CLOUDSQL_INSTANCE}" "${PROJECT_ID}"
printf "  Inside psql, run:\n\n"
printf "    CREATE EXTENSION IF NOT EXISTS postgis;\n"
printf "    CREATE EXTENSION IF NOT EXISTS postgis_topology;\n\n"
printf "  (Required once — Drizzle migrations use IF NOT EXISTS so subsequent\n"
printf "  runs are safe under any role after the first manual enable.)\n\n"

# =============================================================================
# Done
# =============================================================================

log_ok "inject-secrets.sh complete."
printf "\n${BOLD}Remaining steps before arming DEPLOY_ENABLED:${RESET}\n"
printf "  (a) Enable PostGIS as shown above.\n"
printf "  (b) Pin the Cloud SQL Auth Proxy SHA-256 in .github/workflows/deploy.yml (infra/README.md §G).\n"
printf "  (c) Add required reviewers in the GitHub 'production' environment:\n"
printf "        Settings → Environments → production → Protection rules\n"
printf "  (d) Register the Stripe webhook after first deploy and replace the placeholder secret.\n"
printf "  (e) Arm the pipeline:\n"
printf "        gh variable set DEPLOY_ENABLED --body true --repo <GITHUB_REPO>\n\n"
