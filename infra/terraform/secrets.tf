# Secret Manager secrets — empty shells only.
#
# STATE HYGIENE: This file creates google_secret_manager_secret resources ONLY.
# There are NO google_secret_manager_secret_version resources here, which means
# NO secret value ever enters Terraform state. Values are injected out-of-band
# by infra/scripts/inject-secrets.sh using `gcloud secrets versions add`.
#
# The seven secrets:
#   DATABASE_URL                  — runtime Postgres URL (Unix socket form); runtime SA access
#   MIGRATE_DATABASE_URL          — CI Postgres URL (TCP form via Auth Proxy); deploy SA access
#   JWT_SECRET                    — HMAC signing key for JWTs
#   GOOGLE_GEOCODING_API_KEY      — Google Geocoding API key
#   STRIPE_SECRET_KEY             — Stripe platform account secret key
#   STRIPE_WEBHOOK_SECRET         — Stripe webhook signing secret (whsec_…) — platform scope
#   STRIPE_WEBHOOK_SECRET_CONNECT — Stripe webhook signing secret (whsec_…) — Connected-accounts scope
#
# IAM bindings granting access to these secrets are in iam.tf.

locals {
  secret_ids = [
    "DATABASE_URL",
    "MIGRATE_DATABASE_URL",
    "JWT_SECRET",
    "GOOGLE_GEOCODING_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_WEBHOOK_SECRET_CONNECT", # Connected-accounts scoped webhook signing secret
  ]
}

resource "google_secret_manager_secret" "secrets" {
  for_each = toset(local.secret_ids)

  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}
