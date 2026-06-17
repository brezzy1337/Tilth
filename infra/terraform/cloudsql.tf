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
    # Shared-core tiers like db-g1-small are only valid on the ENTERPRISE edition.
    # Some projects default new instances to ENTERPRISE_PLUS, which rejects them —
    # so pin the edition explicitly.
    edition = "ENTERPRISE"
    tier    = var.cloudsql_tier

    backup_configuration {
      enabled = true
    }

    ip_configuration {
      # Cloud SQL requires at least one connectivity method. We enable a public
      # IP (no private VPC needed for the pilot) but add NO authorized networks,
      # so the instance is not directly reachable from the internet — access is
      # only via the Cloud Run connector sidecar (Unix socket) and the Cloud SQL
      # Auth Proxy (used by the migration step), both of which tunnel via IAM.
      # SSL is enforced. A private-IP setup is a later hardening option.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
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
