# Provider configuration.
# The github provider is configured in github.tf (owner derived from var.github_repo).

provider "google" {
  project = var.project_id
  region  = var.region
}
