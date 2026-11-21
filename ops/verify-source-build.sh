#!/usr/bin/env bash
set -euo pipefail

PROJECT=gen-lang-client-0266144152
BUILDER="command-candidate-builder@$PROJECT.iam.gserviceaccount.com"
IMAGE_NAME="europe-west2-docker.pkg.dev/$PROJECT/command-public-images/command"
REPOSITORY="tariromasawi/zioncore-command-interface"
RELEASE_BRANCH="release/command-public-rebuild"
VERIFIED_IMAGE_FILE="${VERIFIED_IMAGE_FILE:-/workspace/verified-image.txt}"

[[ "${DEPLOY_COMMIT:-}" =~ ^[a-f0-9]{40}$ ]] ||
  { echo "The deploy trigger must name a full source commit." >&2; exit 1; }
[[ "${DEPLOY_BRANCH:-}" == "$RELEASE_BRANCH" ]] ||
  { echo "Only the approved release branch can be deployed." >&2; exit 1; }
[[ -n "${BUILDER_TRIGGER_ID:-}" ]] ||
  { echo "The trusted deploy trigger must name the candidate-builder trigger ID." >&2; exit 1; }

current_head="$(python3 - "$RELEASE_BRANCH" "$REPOSITORY" <<'PY'
import json, sys, urllib.parse, urllib.request

branch = urllib.parse.quote(sys.argv[1], safe="")
url = f"https://api.github.com/repos/{sys.argv[2]}/branches/{branch}"
request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
with urllib.request.urlopen(request, timeout=20) as response:
    print(json.loads(response.read().decode("utf-8"))["commit"]["sha"])
PY
)"
[[ "$current_head" == "$DEPLOY_COMMIT" ]] ||
  { echo "The release branch advanced; refusing a stale or rollback deployment." >&2; exit 1; }

builds_json="$(mktemp)"
trap 'rm -f "$builds_json"' EXIT
for attempt in $(seq 1 60); do
  gcloud builds list \
    --project="$PROJECT" \
    --region=global \
    --limit=1000 \
    --filter="status=SUCCESS" \
    --format=json > "$builds_json"
  if metadata="$(python3 - "$builds_json" "$BUILDER" "$BUILDER_TRIGGER_ID" "$DEPLOY_COMMIT" "$RELEASE_BRANCH" "$IMAGE_NAME" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as stream:
    builds = json.load(stream)
builder, trigger_id, commit, branch, image_name = sys.argv[2:]
matches = []
for build in builds:
    substitutions = build.get("substitutions") or {}
    service_account = build.get("serviceAccount", "")
    if (
        build.get("status") != "SUCCESS"
        or not service_account.endswith(builder)
        or build.get("buildTriggerId") != trigger_id
        or substitutions.get("COMMIT_SHA") != commit
        or substitutions.get("BRANCH_NAME") != branch
    ):
        continue
    for image in (build.get("results") or {}).get("images") or []:
        name = image.get("name", "")
        digest = image.get("digest", "")
        if (
            name == f"{image_name}:{commit}"
            and digest.startswith("sha256:")
            and len(digest) == 71
        ):
            matches.append((build.get("createTime", ""), build.get("id", ""), digest))
if not matches:
    sys.exit(3)
matches.sort(reverse=True)
_, build_id, digest = matches[0]
print(f"{image_name}@{digest}")
print(build_id)
PY
  )"; then
    image_ref="${metadata%%$'\n'*}"
    build_id="${metadata#*$'\n'}"
    printf '%s\n' "$image_ref" > "$VERIFIED_IMAGE_FILE"
    printf 'Verified builder build %s for %s; published digest %s.\n' \
      "$build_id" "$DEPLOY_COMMIT" "${image_ref##*@}"
    exit 0
  fi
  sleep 10
done

echo "No successful candidate-builder image for the current release commit was found." >&2
exit 1
