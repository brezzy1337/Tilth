# Enable the GCP APIs required by the HomeGrown deployment.
# disable_on_destroy = false prevents accidental API disablement when TF
# resources are removed — API state is not managed by this module.

locals {
  gcp_apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.gcp_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
