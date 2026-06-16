# GitHub wiring — Actions variables and the production environment.
#
# The GitHub provider reads the repository owner from var.github_repo and
# authenticates via GITHUB_TOKEN in the environment (set by the operator before
# running `terraform apply`).

locals {
  github_owner = split("/", var.github_repo)[0]
  github_repo  = split("/", var.github_repo)[1]
}

provider "github" {
  owner = local.github_owner
}

# ── Actions variables (non-sensitive configuration) ───────────────────────────
# These are repository-level Actions variables (not secrets).
# DEPLOY_ENABLED is hardcoded to "false" — arming the pipeline is a deliberate
# manual step (`gh variable set DEPLOY_ENABLED --body true --repo <repo>`)
# performed only after all pre-arming checks pass (PostGIS, Stripe webhook,
# required reviewers, proxy SHA pin). Keeping this in TF as "false" means
# TF never arms the pipeline autonomously.

resource "github_actions_variable" "gcp_project_id" {
  repository    = local.github_repo
  variable_name = "GCP_PROJECT_ID"
  value         = var.project_id
}

resource "github_actions_variable" "gcp_region" {
  repository    = local.github_repo
  variable_name = "GCP_REGION"
  value         = var.region
}

resource "github_actions_variable" "gcp_ar_repo" {
  repository    = local.github_repo
  variable_name = "GCP_AR_REPO"
  value         = var.ar_repo
}

resource "github_actions_variable" "gcp_cloudsql_instance" {
  repository    = local.github_repo
  variable_name = "GCP_CLOUDSQL_INSTANCE"
  value         = var.cloudsql_instance
}

resource "github_actions_variable" "gcp_wif_provider" {
  repository    = local.github_repo
  variable_name = "GCP_WIF_PROVIDER"
  value         = google_iam_workload_identity_pool_provider.github_oidc.name
}

resource "github_actions_variable" "gcp_deploy_sa" {
  repository    = local.github_repo
  variable_name = "GCP_DEPLOY_SA"
  value         = google_service_account.deploy.email
}

resource "github_actions_variable" "gcp_runtime_sa" {
  repository    = local.github_repo
  variable_name = "GCP_RUNTIME_SA"
  value         = google_service_account.runtime.email
}

# DEPLOY_ENABLED is explicitly "false". Never arm via Terraform.
# To arm: gh variable set DEPLOY_ENABLED --body true --repo <var.github_repo>
resource "github_actions_variable" "deploy_enabled" {
  repository    = local.github_repo
  variable_name = "DEPLOY_ENABLED"
  value         = "false"
}

# ── Production environment ────────────────────────────────────────────────────
# The 'production' environment gates the deploy job (environment: production in
# deploy.yml). Required reviewers are set here if var.production_reviewer_ids
# is non-empty; otherwise the environment is created without reviewers and they
# must be added in the GitHub UI:
#   Settings → Environments → production → Protection rules → Required reviewers
#
# IMPORTANT: do NOT enable ACTIONS_STEP_DEBUG on this environment.
# Runner debug logging (set -x) expands every command before execution and
# bypasses log masking (::add-mask::) for secrets fetched in that step.

resource "github_repository_environment" "production" {
  repository  = local.github_repo
  environment = "production"

  dynamic "reviewers" {
    for_each = length(var.production_reviewer_ids) > 0 ? [1] : []
    content {
      users = var.production_reviewer_ids
    }
  }
}
