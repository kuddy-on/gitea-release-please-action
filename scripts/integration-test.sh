#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE="${GITEA_E2E_IMAGE:-gitea/gitea:1.27}"
readonly PORT="${GITEA_E2E_PORT:-33000}"
readonly CONTAINER="gitea-release-please-e2e-${$}"
readonly ROOT_URL="http://127.0.0.1:${PORT}"
readonly TAG_PREFIX="${GITEA_E2E_TAG_PREFIX-v}"
readonly FIRST_VERSION="0.1.0"
readonly SECOND_PATCH_VERSION="0.1.1"
readonly SECOND_MINOR_VERSION="0.2.0"
readonly SECOND_VERSION="1.0.0"
readonly FIRST_TAG="${TAG_PREFIX}${FIRST_VERSION}"
readonly SECOND_TAG="${TAG_PREFIX}${SECOND_VERSION}"
readonly FIRST_TITLE="chore(main): release ${FIRST_VERSION}"
readonly SECOND_PATCH_TITLE="chore(main): release ${SECOND_PATCH_VERSION}"
readonly SECOND_MINOR_TITLE="chore(main): release ${SECOND_MINOR_VERSION}"
readonly SECOND_TITLE="chore(main): release ${SECOND_VERSION}"
readonly EXTRA_FILES='[{"type":"json","path":"package.json","jsonpath":"$.version"},{"type":"toml","path":"pyproject.toml","jsonpath":"$.project.version"},{"type":"json","path":"packages/*.json","jsonpath":"$.version","glob":true}]'
readonly EXCLUDE_PATHS='["docs"]'
WORK_DIR="$(mktemp -d)"

cleanup() {
  truncate -s 0 "${WORK_DIR}/token" 2>/dev/null || true
  docker stop "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

docker run --rm -d \
  --name "${CONTAINER}" \
  -p "127.0.0.1:${PORT}:3000" \
  -e GITEA__database__DB_TYPE=sqlite3 \
  -e GITEA__database__PATH=/data/gitea/gitea.db \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__service__DISABLE_REGISTRATION=false \
  -e "GITEA__server__ROOT_URL=${ROOT_URL}/" \
  "${IMAGE}" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "${ROOT_URL}/api/v1/version" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "${ROOT_URL}/api/v1/version" >/dev/null

docker exec --user git "${CONTAINER}" gitea admin user create \
  --config /data/gitea/conf/app.ini \
  --username e2e \
  --password e2e-password-123 \
  --email e2e@example.com \
  --admin \
  --must-change-password=false >/dev/null
docker exec --user git "${CONTAINER}" gitea admin user generate-access-token \
  --config /data/gitea/conf/app.ini \
  --username e2e \
  --token-name e2e \
  --scopes all \
  --raw >"${WORK_DIR}/token"

TOKEN="$(<"${WORK_DIR}/token")"
readonly TOKEN
readonly AUTH_HEADER="Authorization: token ${TOKEN}"

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","auto_init":true,"default_branch":"main","readme":"Default"}' \
  "${ROOT_URL}/api/v1/user/repos" >"${WORK_DIR}/repository.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"feat: initial feature","content":"ZmVhdHVyZQo="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/feature.txt" >"${WORK_DIR}/commit.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"chore: add package metadata","content":"eyJuYW1lIjoiZGVtbyIsInZlcnNpb24iOiIwLjAuMCJ9Cg=="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/package.json" >"${WORK_DIR}/package-commit.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"chore: add Python metadata","content":"W3Byb2plY3RdCm5hbWUgPSAiZGVtbyIKdmVyc2lvbiA9ICIwLjAuMCIK"}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/pyproject.toml" >"${WORK_DIR}/pyproject-commit.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"chore: add release manifest","content":"e30K"}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/.release-please-manifest.json" >"${WORK_DIR}/manifest-commit.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"chore: add worker metadata","content":"eyJuYW1lIjoid29ya2VyIiwidmVyc2lvbiI6IjAuMC4wIn0K"}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/packages/worker.json" >"${WORK_DIR}/worker-commit.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"feat: docs-only change is excluded","content":"ZG9jdW1lbnRhdGlvbgo="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/docs/guide.md" >"${WORK_DIR}/docs-commit.json"

run_action() {
  local repository="${1:-e2e/demo}"
  local package_path="${2:-.}"
  local fork="${3:-false}"
  local extra_files="${4:-${EXTRA_FILES}}"
  local exclude_paths="${5:-${EXCLUDE_PATHS}}"
  : >"${WORK_DIR}/action-output"
  if ! env \
    INPUT_TOKEN="${TOKEN}" \
    "INPUT_GITEA-URL=${ROOT_URL}" \
    INPUT_REPOSITORY="${repository}" \
    INPUT_PATH="${package_path}" \
    INPUT_FORK="${fork}" \
    "INPUT_TAG-PREFIX=${TAG_PREFIX}" \
    "INPUT_INITIAL-VERSION=${FIRST_VERSION}" \
    "INPUT_EXTRA-FILES=${extra_files}" \
    "INPUT_EXCLUDE-PATHS=${exclude_paths}" \
    GITHUB_OUTPUT="${WORK_DIR}/action-output" \
    node dist/index.js >"${WORK_DIR}/action.log" 2>&1; then
    grep -v '^::add-mask::' "${WORK_DIR}/action.log" >&2 || true
    return 1
  fi
  grep -v '^::add-mask::' "${WORK_DIR}/action.log" || true
}

output_value() {
  local file="$1"
  local key="$2"
  awk -v key="${key}" '
    index($0, key "=") == 1 {
      sub("^" key "=", "")
      value = $0
    }
    index($0, key "<<") == 1 {
      getline
      value = $0
    }
    END { print value }
  ' "${file}"
}

read_file() {
  local path="$1"
  local ref="$2"
  curl -fsS -H "${AUTH_HEADER}" \
    "${ROOT_URL}/api/v1/repos/e2e/demo/contents/${path}?ref=${ref}" |
    jq -r '.content' |
    tr -d '\n' |
    base64 -d
}

wait_for_mergeable() {
  wait_for_mergeable_in_repo e2e/demo "$1"
}

wait_for_mergeable_in_repo() {
  local repository="$1"
  local number="$2"
  local pull_request=''
  for _ in $(seq 1 30); do
    pull_request="$(curl -fsS -H "${AUTH_HEADER}" \
      "${ROOT_URL}/api/v1/repos/${repository}/pulls/${number}")"
    if test "$(jq -r '.mergeable' <<<"${pull_request}")" = 'true'; then
      return 0
    fi
    sleep 1
  done
  echo "PR #${number} did not become mergeable." >&2
  return 1
}

merge_pull_request() {
  merge_pull_request_in_repo e2e/demo "$1" "$2" "$3" "$4"
}

merge_pull_request_in_repo() {
  local repository="$1"
  local number="$2"
  local method="$3"
  local title="$4"
  local output="$5"
  local status=''
  for _ in $(seq 1 10); do
    status="$(curl -sS -o "${output}" -w '%{http_code}' -X POST \
      -H "${AUTH_HEADER}" \
      -H 'Content-Type: application/json' \
      -d "{\"Do\":\"${method}\",\"MergeTitleField\":\"${title}\",\"MergeMessageField\":\"\"}" \
      "${ROOT_URL}/api/v1/repos/${repository}/pulls/${number}/merge")"
    if test "${status}" = '200'; then
      return 0
    fi
    if test "${status}" != '405' && test "${status}" != '409'; then
      break
    fi
    sleep 1
  done
  echo "Unable to merge PR #${number}; HTTP ${status}: $(<"${output}")" >&2
  return 1
}

run_action
test "$(output_value "${WORK_DIR}/action-output" prs_created)" = 'true'
test "$(output_value "${WORK_DIR}/action-output" pr_created)" = 'true'

pulls="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
test "$(jq 'length' <<<"${pulls}")" = '1'
test "$(jq -r '.[0].title' <<<"${pulls}")" = "${FIRST_TITLE}"
test "$(jq -r '.[0].number' <<<"${pulls}")" = '1'
first_release_head="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/branches/release-please--branches--main" |
  jq -r '.commit.id')"
test -n "${first_release_head}"

release_notes="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/RELEASE.md?ref=release-please--branches--main")"
jq -r '.content' <<<"${release_notes}" | tr -d '\n' | base64 -d | grep -q 'initial feature'
if jq -r '.content' <<<"${release_notes}" | tr -d '\n' | base64 -d | grep -q 'docs-only change'; then
  echo 'Excluded docs-only commit appeared in release notes.' >&2
  exit 1
fi
test "$(read_file package.json release-please--branches--main | jq -r '.version')" = '0.1.0'
test "$(read_file packages/worker.json release-please--branches--main | jq -r '.version')" = '0.1.0'
read_file pyproject.toml release-please--branches--main | grep -q 'version = "0.1.0"'
test "$(read_file .release-please-manifest.json release-please--branches--main | jq -r '.["."]')" = '0.1.0'

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"fix: follow-up before release","content":"Zm9sbG93LXVwCg=="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/follow-up.txt" >"${WORK_DIR}/follow-up-commit.json"
follow_up_sha="$(jq -r '.commit.sha' "${WORK_DIR}/follow-up-commit.json")"
test -n "${follow_up_sha}"
run_action
test "$(output_value "${WORK_DIR}/action-output" pr_updated)" = 'true'
pulls="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
test "$(jq 'length' <<<"${pulls}")" = '1'
test "$(jq -r '.[0].number' <<<"${pulls}")" = '1'
release_notes="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/RELEASE.md?ref=release-please--branches--main")"
decoded_notes="$(jq -r '.content' <<<"${release_notes}" | tr -d '\n' | base64 -d)"
grep -q 'initial feature' <<<"${decoded_notes}"
grep -q 'follow-up before release' <<<"${decoded_notes}"
release_commits="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/commits?sha=release-please--branches--main&limit=50")"
test "$(jq -r '.[1].sha' <<<"${release_commits}")" = "${follow_up_sha}"
test "$(jq --arg sha "${first_release_head}" '[.[] | select(.sha == $sha)] | length' \
  <<<"${release_commits}")" = '0'

wait_for_mergeable 1
merge_pull_request 1 squash "${FIRST_TITLE}" "${WORK_DIR}/merge.json"

merge_sha="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/1" | jq -r '.merge_commit_sha')"
test -n "${merge_sha}"

run_action
test "$(output_value "${WORK_DIR}/action-output" release_created)" = 'true'
test "$(output_value "${WORK_DIR}/action-output" tag_name)" = "${FIRST_TAG}"
test "$(output_value "${WORK_DIR}/action-output" prs_created)" = 'false'

tags="$(curl -fsS -H "${AUTH_HEADER}" "${ROOT_URL}/api/v1/repos/e2e/demo/tags")"
releases="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/releases")"
test "$(jq 'length' <<<"${tags}")" = '1'
test "$(jq -r '.[0].name' <<<"${tags}")" = "${FIRST_TAG}"
test "$(jq -r '.[0].commit.sha' <<<"${tags}")" = "${merge_sha}"
test "$(jq 'length' <<<"${releases}")" = '1'
test "$(jq -r '.[0].tag_name' <<<"${releases}")" = "${FIRST_TAG}"
test "$(jq -r '.[0].target_commitish' <<<"${releases}")" = "${merge_sha}"

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"fix: second release","content":"Zml4Cg=="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/fix.txt" >"${WORK_DIR}/second-commit.json"

run_action
second_pr_created="$(output_value "${WORK_DIR}/action-output" pr_created)"
if test "${second_pr_created}" != 'true'; then
  echo "Expected second prepare run to create a PR, got: ${second_pr_created}" >&2
  exit 1
fi
second_pull="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
second_pull_count="$(jq 'length' <<<"${second_pull}")"
second_pull_number="$(jq -r '.[0].number' <<<"${second_pull}")"
second_pull_title="$(jq -r '.[0].title' <<<"${second_pull}")"
if test "${second_pull_count}" != '1' || test "${second_pull_number}" != '2' || test "${second_pull_title}" != "${SECOND_PATCH_TITLE}"; then
  echo "Unexpected second release PR: count=${second_pull_count} number=${second_pull_number} title=${second_pull_title}" >&2
  exit 1
fi
test "$(read_file package.json release-please--branches--main | jq -r '.version')" = '0.1.1'
read_file pyproject.toml release-please--branches--main | grep -q 'version = "0.1.1"'

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"feat: add second feature","content":"ZmVhdHVyZSB0d28K"}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/second-feature.txt" >"${WORK_DIR}/second-feature-commit.json"
run_action
second_pull="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
test "$(jq 'length' <<<"${second_pull}")" = '1'
test "$(jq -r '.[0].number' <<<"${second_pull}")" = '2'
test "$(jq -r '.[0].title' <<<"${second_pull}")" = "${SECOND_MINOR_TITLE}"
test "$(read_file package.json release-please--branches--main | jq -r '.version')" = '0.2.0'
read_file pyproject.toml release-please--branches--main | grep -q 'version = "0.2.0"'

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"feat!: replace public API","content":"YnJlYWtpbmcK"}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/breaking.txt" >"${WORK_DIR}/breaking-commit.json"
breaking_sha="$(jq -r '.commit.sha' "${WORK_DIR}/breaking-commit.json")"
test -n "${breaking_sha}"
run_action
second_pull="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
test "$(jq 'length' <<<"${second_pull}")" = '1'
test "$(jq -r '.[0].number' <<<"${second_pull}")" = '2'
test "$(jq -r '.[0].title' <<<"${second_pull}")" = "${SECOND_TITLE}"
test "$(read_file package.json release-please--branches--main | jq -r '.version')" = '1.0.0'
test "$(read_file packages/worker.json release-please--branches--main | jq -r '.version')" = '1.0.0'
read_file pyproject.toml release-please--branches--main | grep -q 'version = "1.0.0"'
release_commits="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/commits?sha=release-please--branches--main&limit=50")"
test "$(jq -r '.[1].sha' <<<"${release_commits}")" = "${breaking_sha}"
changelog="$(read_file CHANGELOG.md release-please--branches--main)"
test "$(grep -c 'second release' <<<"${changelog}")" = '1'
test "$(grep -c 'add second feature' <<<"${changelog}")" = '1'
test "$(grep -c 'replace public API' <<<"${changelog}")" = '1'
test "$(grep -c '## \[0.1.0\]' <<<"${changelog}")" = '1'
test "$(grep -c '## \[1.0.0\]' <<<"${changelog}")" = '1'

wait_for_mergeable 2
merge_pull_request 2 merge "${SECOND_TITLE}" "${WORK_DIR}/second-merge.json"
second_merge_sha="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/2" | jq -r '.merge_commit_sha')"
test -n "${second_merge_sha}"

run_action
test "$(output_value "${WORK_DIR}/action-output" release_created)" = 'true'
tags="$(curl -fsS -H "${AUTH_HEADER}" "${ROOT_URL}/api/v1/repos/e2e/demo/tags")"
releases="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/releases")"
test "$(jq 'length' <<<"${tags}")" = '2'
test "$(jq -r --arg tag "${SECOND_TAG}" '.[] | select(.name == $tag) | .commit.sha' <<<"${tags}")" = "${second_merge_sha}"
test "$(jq 'length' <<<"${releases}")" = '2'
test "$(jq -r --arg tag "${SECOND_TAG}" '.[] | select(.tag_name == $tag) | .target_commitish' <<<"${releases}")" = "${second_merge_sha}"

run_action
test "$(output_value "${WORK_DIR}/action-output" release_created)" = 'false'
test "$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/tags" | jq 'length')" = '2'
test "$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/releases" | jq 'length')" = '2'

# Release PRs merged with both rebase modes must publish like squash and merge commits.
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"fix: release through rebase","content":"cmViYXNlCg=="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/rebase.txt" >"${WORK_DIR}/rebase-commit.json"
run_action
third_pull="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
third_number="$(jq -r '.[0].number' <<<"${third_pull}")"
third_title="$(jq -r '.[0].title' <<<"${third_pull}")"
test "${third_title}" = 'chore(main): release 1.0.1'
wait_for_mergeable "${third_number}"
merge_pull_request "${third_number}" rebase "${third_title}" "${WORK_DIR}/rebase-merge.json"
third_merge_sha="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/${third_number}" | jq -r '.merge_commit_sha')"
test -n "${third_merge_sha}"
test "${third_merge_sha}" != 'null'
run_action
test "$(output_value "${WORK_DIR}/action-output" release_created)" = 'true'
test "$(output_value "${WORK_DIR}/action-output" tag_name)" = "${TAG_PREFIX}1.0.1"

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"fix: release through rebase merge","content":"cmViYXNlLW1lcmdlCg=="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/rebase-merge.txt" >"${WORK_DIR}/rebase-explicit-commit.json"
run_action
fourth_pull="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
fourth_number="$(jq -r '.[0].number' <<<"${fourth_pull}")"
fourth_title="$(jq -r '.[0].title' <<<"${fourth_pull}")"
test "${fourth_title}" = 'chore(main): release 1.0.2'
wait_for_mergeable "${fourth_number}"
merge_pull_request "${fourth_number}" rebase-merge "${fourth_title}" "${WORK_DIR}/rebase-explicit-merge.json"
fourth_merge_sha="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/${fourth_number}" | jq -r '.merge_commit_sha')"
test -n "${fourth_merge_sha}"
test "${fourth_merge_sha}" != 'null'
run_action
test "$(output_value "${WORK_DIR}/action-output" release_created)" = 'true'
test "$(output_value "${WORK_DIR}/action-output" tag_name)" = "${TAG_PREFIX}1.0.2"

# A single non-root package can use a token-owned fork for the machine branch.
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"username":"release-team","full_name":"Release Team"}' \
  "${ROOT_URL}/api/v1/orgs" >"${WORK_DIR}/organization.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"name":"path-demo","auto_init":true,"default_branch":"main","readme":"Default"}' \
  "${ROOT_URL}/api/v1/orgs/release-team/repos" >"${WORK_DIR}/path-repository.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"chore: add release manifest","content":"e30K"}' \
  "${ROOT_URL}/api/v1/repos/release-team/path-demo/contents/.release-please-manifest.json" >"${WORK_DIR}/path-manifest.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"feat: package feature","content":"cGFja2FnZQo="}' \
  "${ROOT_URL}/api/v1/repos/release-team/path-demo/contents/packages/api/feature.txt" >"${WORK_DIR}/path-feature.json"
curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"feat!: unrelated root break","content":"cm9vdAo="}' \
  "${ROOT_URL}/api/v1/repos/release-team/path-demo/contents/root.txt" >"${WORK_DIR}/path-root.json"

run_action release-team/path-demo packages/api true '[]' '[]'
test "$(output_value "${WORK_DIR}/action-output" pr_created)" = 'true'
path_pull="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/release-team/path-demo/pulls?state=open")"
path_number="$(jq -r '.[0].number' <<<"${path_pull}")"
path_title="$(jq -r '.[0].title' <<<"${path_pull}")"
test "${path_title}" = 'chore(main): release 0.1.0'
test "$(jq -r '.[0].head.repo.full_name' <<<"${path_pull}")" = 'e2e/path-demo'
path_notes="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/path-demo/contents/packages/api/RELEASE.md?ref=release-please--branches--main" | \
  jq -r '.content' | tr -d '\n' | base64 -d)"
grep -q 'package feature' <<<"${path_notes}"
path_manifest="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/path-demo/contents/.release-please-manifest.json?ref=release-please--branches--main" | \
  jq -r '.content' | tr -d '\n' | base64 -d)"
test "$(jq -r '.["packages/api"]' <<<"${path_manifest}")" = '0.1.0'
if grep -q 'unrelated root break' <<<"${path_notes}"; then
  echo 'Root-only commit appeared in path-scoped release notes.' >&2
  exit 1
fi

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"fix: package follow-up","content":"Zml4Cg=="}' \
  "${ROOT_URL}/api/v1/repos/release-team/path-demo/contents/packages/api/fix.txt" >"${WORK_DIR}/path-fix.json"
run_action release-team/path-demo packages/api true '[]' '[]'
test "$(output_value "${WORK_DIR}/action-output" pr_updated)" = 'true'
path_notes="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/path-demo/contents/packages/api/RELEASE.md?ref=release-please--branches--main" | \
  jq -r '.content' | tr -d '\n' | base64 -d)"
grep -q 'package follow-up' <<<"${path_notes}"

wait_for_mergeable_in_repo release-team/path-demo "${path_number}"
merge_pull_request_in_repo release-team/path-demo "${path_number}" squash "${path_title}" "${WORK_DIR}/path-merge.json"
run_action release-team/path-demo packages/api true '[]' '[]'
test "$(output_value "${WORK_DIR}/action-output" release_created)" = 'false'
test "$(output_value "${WORK_DIR}/action-output" packages/api--release_created)" = 'true'
test "$(output_value "${WORK_DIR}/action-output" packages/api--tag_name)" = "${FIRST_TAG}"
test "$(output_value "${WORK_DIR}/action-output" paths_released)" = '["packages/api"]'
test "$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/release-team/path-demo/releases" | jq -r '.[0].tag_name')" = "${FIRST_TAG}"
fork_branch_status="$(curl -sS -o /dev/null -w '%{http_code}' -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/path-demo/branches/release-please--branches--main")"
test "${fork_branch_status}" = '404'

echo 'Gitea 1.27 integration test passed.'
