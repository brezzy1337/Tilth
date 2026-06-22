output "wif_provider_resource_name" {
  description = "Full WIF provider resource name — use as GCP_WIF_PROVIDER in GitHub Actions."
  value       = google_iam_workload_identity_pool_provider.github_oidc.name
}

output "deploy_sa_email" {
  description = "Deploy service account email — use as GCP_DEPLOY_SA in GitHub Actions."
  value       = google_service_account.deploy.email
}

output "runtime_sa_email" {
  description = "Runtime service account email — use as GCP_RUNTIME_SA in GitHub Actions."
  value       = google_service_account.runtime.email
}

output "cloudsql_connection_name" {
  description = "Cloud SQL instance connection name (PROJECT:REGION:INSTANCE) — used in --add-cloudsql-instances."
  value       = local.cloudsql_connection_name
}

output "project_number" {
  description = "GCP project number (numeric) — used in WIF principal set URLs."
  value       = data.google_project.project.number
}

output "next_steps" {
  description = "Reminder: what to do after terraform apply."
  value       = <<-EOT
    Terraform apply complete. Remaining steps before arming DEPLOY_ENABLED:

    1. Run infra/scripts/inject-secrets.sh to:
       - Create the Cloud SQL application user + password (out-of-band, never in TF state)
       - Add secret VERSIONS for DATABASE_URL, MIGRATE_DATABASE_URL, JWT_SECRET
       - Prompt for GOOGLE_GEOCODING_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

    2. Enable PostGIS (see inject-secrets.sh output for the exact command):
         gcloud sql connect ${var.cloudsql_instance} --user=postgres --project=${var.project_id}
         -- inside psql: CREATE EXTENSION IF NOT EXISTS postgis;
         --              CREATE EXTENSION IF NOT EXISTS postgis_topology;

    3. Pin the Cloud SQL Auth Proxy SHA-256 in .github/workflows/deploy.yml (infra/README.md §G).

    4. Register the Stripe webhook after first deploy, then:
         read -rs WHSEC && printf '%s' "$WHSEC" | gcloud secrets versions add STRIPE_WEBHOOK_SECRET --data-file=- && unset WHSEC

    5. Add required reviewers to the 'production' GitHub environment:
         Settings → Environments → production → Protection rules → Required reviewers
       (or set var.production_reviewer_ids and re-apply)

    6. Arm the pipeline (only after all above are complete):
         gh variable set DEPLOY_ENABLED --body true --repo ${var.github_repo}

    NOTE: TF does NOT manage the Cloud Run service — the GitHub Actions pipeline
    owns building and deploying revisions via `gcloud run deploy`. If TF also
    managed the service they would conflict on every deploy.
  EOT
}

# Data source required for project_number output
data "google_project" "project" {
  project_id = var.project_id
}
