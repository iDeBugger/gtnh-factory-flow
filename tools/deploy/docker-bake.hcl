# The deploy's build (tools/deploy/deploy.sh, step 3): the site, live and migrate images in one bake, so
# the context is sent once and the stages the site and live share are built once. Run from a directory
# holding `git archive HEAD` (the context), with every variable set:
#
#   TAG=<version>-<sha8> SITE_URL=https://... MOD_AND_COMMUNITY= docker buildx bake -f tools/deploy/docker-bake.hcl
variable "TAG" {}
variable "SITE_URL" {}
variable "MOD_AND_COMMUNITY" {
  default = ""
}

group "default" {
  targets = ["site", "live", "migrate"]
}

target "_release" {
  context    = "."
  dockerfile = "Dockerfile"
  args = {
    NEXT_PUBLIC_SITE_URL          = SITE_URL
    NEXT_PUBLIC_MOD_AND_COMMUNITY = MOD_AND_COMMUNITY
    GTNH_BUILD_ID                 = TAG
  }
}

target "site" {
  inherits = ["_release"]
  target   = "site"
  tags     = ["gtnh-site:${TAG}"]
}

target "live" {
  inherits = ["_release"]
  target   = "live"
  tags     = ["gtnh-live:${TAG}"]
}

target "migrate" {
  inherits = ["_release"]
  target   = "migrate"
  tags     = ["gtnh-migrate:${TAG}"]
}
