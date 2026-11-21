#!/usr/bin/env bash
set -euo pipefail

image="${1:-}"
expected_commit="${2:-${EXPECTED_COMMIT:-}}"
if [[ -z "$image" && -n "${RELEASE_IMAGE_FILE:-}" ]]; then
  [[ -f "$RELEASE_IMAGE_FILE" ]] ||
    { echo "The verified image digest file is missing." >&2; exit 1; }
  image="$(cat "$RELEASE_IMAGE_FILE")"
fi

[[ "$image" =~ ^europe-west2-docker\.pkg\.dev/gen-lang-client-0266144152/command-public-images/command@sha256:[a-f0-9]{64}$ ]] ||
  { echo "Deployment requires the approved repository and an immutable SHA-256 image digest." >&2; exit 1; }
[[ "$expected_commit" =~ ^[a-f0-9]{40}$ ]] ||
  { echo "Deployment requires the exact full source commit." >&2; exit 1; }

docker pull "$image"
actual_commit="$(docker image inspect --format='{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
[[ "$actual_commit" == "$expected_commit" ]] ||
  { echo "Image source label does not match the release commit." >&2; exit 1; }
echo "Verified image digest and source commit: $actual_commit"
