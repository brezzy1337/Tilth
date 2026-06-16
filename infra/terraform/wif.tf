# Workload Identity Federation — keyless GitHub Actions → GCP authentication.
#
# Trust is scoped exclusively to var.github_repo via attribute_condition and
# the principalSet binding below. No other repository in the GitHub org can
# impersonate the deploy SA.

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.wif_pool_id
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github_oidc" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = var.wif_provider_id
  display_name                       = "GitHub OIDC"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # Restrict trust to this repository only. An OIDC token from any other
  # GitHub repository will be rejected at token exchange time.
  attribute_condition = "attribute.repository == '${var.github_repo}'"
}

# Bind the deploy SA so that GitHub Actions workflows in var.github_repo can
# impersonate it. The principalSet scopes the binding to the repository attribute
# rather than to a specific workflow or branch.
resource "google_service_account_iam_member" "wif_deploy_sa_binding" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
