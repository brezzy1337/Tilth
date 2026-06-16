# GCS remote backend for Terraform state.
#
# The bucket name cannot be a variable (backends are evaluated before the
# variable-expansion phase), so it is supplied at init time via -backend-config:
#
#   terraform init \
#     -backend-config="bucket=<YOUR_TF_STATE_BUCKET>" \
#     -backend-config="prefix=homegrown/terraform"
#
# The bucket itself is created by infra/scripts/tf-bootstrap.sh, which also
# enables object versioning so that state history is recoverable.

terraform {
  backend "gcs" {
    # bucket and prefix are injected at `terraform init` time via -backend-config.
    # Do NOT hardcode the bucket name here — it varies per environment and
    # must never be committed for public repos.
    prefix = "homegrown/terraform"
  }
}
