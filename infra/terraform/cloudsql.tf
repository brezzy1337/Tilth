# Cloud SQL — Postgres 16 instance + application database.
#
# BOUNDARY — what TF does NOT manage here:
#   - NO google_sql_user resource: the application user and its password are
#     created out-of-band by infra/scripts/inject-secrets.sh so that the
#     DB password never touches Terraform state.
#   - PostGIS extension: must be enabled once manually as the `postgres` user
#     (cloudsqlsuperuser) via `gcloud sql connect`. See inject-secrets.sh for
#     the reminder. Drizzle migrations use CREATE EXTENSION IF NOT EXISTS, which
#     is safe after the first manual enable.

resource "google_sql_database_instance" "main" {
  project          = var.project_id
  name             = var.cloudsql_instance
  region           = var.region
  database_version = "POSTGRES_16"

  settings {
    tier = var.cloudsql_tier

    backup_configuration {
      enabled = true
    }

    ip_configuration {
      # No public IP — Cloud Run connects via the Cloud SQL connector sidecar
      # (Unix socket) or through the Cloud SQL Auth Proxy (TCP, for migrations).
      ipv4_enabled = false
    }
  }

  # Prevent accidental deletion of the database instance.
  deletion_protection = true

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = var.db_name
}
