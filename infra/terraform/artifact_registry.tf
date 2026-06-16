resource "google_artifact_registry_repository" "server_images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.ar_repo
  format        = "DOCKER"
  description   = "HomeGrown server images"

  depends_on = [google_project_service.apis]
}
