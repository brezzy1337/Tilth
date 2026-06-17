variable "project_id" {
  description = "GCP project ID. Required — no default."
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run, Artifact Registry, and Cloud SQL."
  type        = string
  default     = "us-central1"
}

variable "github_repo" {
  description = "GitHub repository in 'owner/name' form. Used to scope WIF trust and GitHub provider."
  type        = string
  default     = "brezzy1337/HomeGrown"
}

variable "ar_repo" {
  description = "Artifact Registry repository name (Docker format)."
  type        = string
  default     = "homegrown"
}

variable "cloudsql_instance" {
  description = "Cloud SQL instance name."
  type        = string
  default     = "homegrown-db"
}

variable "cloudsql_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-g1-small"
}

variable "db_name" {
  description = "Postgres database name created inside the Cloud SQL instance."
  type        = string
  default     = "homegrown"
}

variable "deploy_sa_name" {
  description = "Service account name (not email) for the GitHub Actions deploy SA."
  type        = string
  default     = "homegrown-deploy"
}

variable "runtime_sa_name" {
  description = "Service account name (not email) for the Cloud Run runtime SA."
  type        = string
  default     = "homegrown-server"
}

variable "wif_pool_id" {
  description = "Workload Identity pool ID."
  type        = string
  default     = "github-actions"
}

variable "wif_provider_id" {
  description = "Workload Identity OIDC provider ID within the pool."
  type        = string
  default     = "github"
}

# NOTE: GitHub Actions variables and the `production` environment are NOT managed
# by Terraform (the available CI tokens lack repo-admin scope). Configure them
# manually per infra/README.md §7.
