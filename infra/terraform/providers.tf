# Provider configuration.
# Terraform manages only GCP. The GitHub Actions variables + `production`
# environment are configured manually (see infra/README.md §7) because the
# tokens available in CI lack repo-admin scope.

provider "google" {
  project = var.project_id
  region  = var.region
}
