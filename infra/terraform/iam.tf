# Service accounts and IAM bindings.
#
# Least-privilege design:
#   - deploy SA: project-level roles for AR, Cloud Run, Cloud SQL only.
#     No project-level secretAccessor — only MIGRATE_DATABASE_URL (per-secret).
#   - runtime SA: per-secret secretAccessor on the 5 runtime secrets only.
#     No project-level secretAccessor.
#   - deploy SA can impersonate runtime SA for `gcloud run deploy --service-account`.

# ── Service Accounts ─────────────────────────────────────────────────────────

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = var.deploy_sa_name
  display_name = "HomeGrown CI deploy SA"

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = var.runtime_sa_name
  display_name = "HomeGrown Cloud Run runtime SA"

  depends_on = [google_project_service.apis]
}

# ── Deploy SA — project-level roles ─────────────────────────────────────────

resource "google_project_iam_member" "deploy_ar_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_project_iam_member" "deploy_run_developer" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_project_iam_member" "deploy_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# ── Deploy SA can act-as runtime SA for `gcloud run deploy --service-account` ──

resource "google_service_account_iam_member" "deploy_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

# ── Runtime SA — per-secret secretAccessor (5 runtime secrets) ──────────────
# Each binding is declared individually so that adding or revoking access to a
# single secret requires no other changes and produces a minimal diff.

locals {
  runtime_secrets = [
    "DATABASE_URL",
    "JWT_SECRET",
    "GOOGLE_GEOCODING_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]
}

resource "google_secret_manager_secret_iam_member" "runtime_secret_accessor" {
  for_each = toset(local.runtime_secrets)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"

  depends_on = [google_secret_manager_secret.secrets]
}

# ── Deploy SA — per-secret secretAccessor on MIGRATE_DATABASE_URL only ───────

resource "google_secret_manager_secret_iam_member" "deploy_migrate_db_url" {
  project   = var.project_id
  secret_id = "MIGRATE_DATABASE_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deploy.email}"

  depends_on = [google_secret_manager_secret.secrets]
}
