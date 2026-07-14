#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE="${GITEA_E2E_IMAGE:-gitea/gitea:1.27}"
readonly PORT="${GITEA_E2E_PORT:-33000}"
readonly CONTAINER="gitea-release-please-e2e-${$}"
readonly ROOT_URL="http://127.0.0.1:${PORT}"
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

run_action() {
  : >"${WORK_DIR}/output"
  if ! env \
    INPUT_TOKEN="${TOKEN}" \
    "INPUT_GITEA-URL=${ROOT_URL}" \
    INPUT_REPOSITORY=e2e/demo \
    GITHUB_OUTPUT="${WORK_DIR}/output" \
    node dist/index.js >"${WORK_DIR}/action.log" 2>&1; then
    grep -v '^::add-mask::' "${WORK_DIR}/action.log" >&2 || true
    return 1
  fi
  grep -v '^::add-mask::' "${WORK_DIR}/action.log" || true
}

wait_for_mergeable() {
  local number="$1"
  local pull_request=''
  for _ in $(seq 1 30); do
    pull_request="$(curl -fsS -H "${AUTH_HEADER}" \
      "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/${number}")"
    if test "$(jq -r '.mergeable' <<<"${pull_request}")" = 'true'; then
      return 0
    fi
    sleep 1
  done
  echo "PR #${number} did not become mergeable." >&2
  return 1
}

run_action

pulls="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
test "$(jq 'length' <<<"${pulls}")" = '1'
test "$(jq -r '.[0].title' <<<"${pulls}")" = 'chore(main): release v0.1.0'
test "$(jq -r '.[0].number' <<<"${pulls}")" = '1'

release_notes="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/RELEASE.md?ref=gitea-release-please--branches--main")"
jq -r '.content' <<<"${release_notes}" | tr -d '\n' | base64 -d | grep -q 'initial feature'

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"fix: follow-up before release","content":"Zm9sbG93LXVwCg=="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/follow-up.txt" >"${WORK_DIR}/follow-up-commit.json"
run_action
pulls="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
test "$(jq 'length' <<<"${pulls}")" = '1'
test "$(jq -r '.[0].number' <<<"${pulls}")" = '1'
release_notes="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/RELEASE.md?ref=gitea-release-please--branches--main")"
decoded_notes="$(jq -r '.content' <<<"${release_notes}" | tr -d '\n' | base64 -d)"
grep -q 'initial feature' <<<"${decoded_notes}"
grep -q 'follow-up before release' <<<"${decoded_notes}"

wait_for_mergeable 1
curl -fsS -X POST \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"Do":"squash","MergeTitleField":"chore(main): release v0.1.0","MergeMessageField":""}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/1/merge" >"${WORK_DIR}/merge.json"

merge_sha="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/1" | jq -r '.merge_commit_sha')"
test -n "${merge_sha}"

run_action

tags="$(curl -fsS -H "${AUTH_HEADER}" "${ROOT_URL}/api/v1/repos/e2e/demo/tags")"
releases="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/releases")"
test "$(jq 'length' <<<"${tags}")" = '1'
test "$(jq -r '.[0].name' <<<"${tags}")" = 'v0.1.0'
test "$(jq -r '.[0].commit.sha' <<<"${tags}")" = "${merge_sha}"
test "$(jq 'length' <<<"${releases}")" = '1'
test "$(jq -r '.[0].tag_name' <<<"${releases}")" = 'v0.1.0'
test "$(jq -r '.[0].target_commitish' <<<"${releases}")" = "${merge_sha}"

curl -fsS \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"main","message":"fix: second release","content":"Zml4Cg=="}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/contents/fix.txt" >"${WORK_DIR}/second-commit.json"

run_action
second_pull="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls?state=open")"
test "$(jq 'length' <<<"${second_pull}")" = '1'
test "$(jq -r '.[0].number' <<<"${second_pull}")" = '2'
test "$(jq -r '.[0].title' <<<"${second_pull}")" = 'chore(main): release v0.1.1'

wait_for_mergeable 2
curl -fsS -X POST \
  -H "${AUTH_HEADER}" \
  -H 'Content-Type: application/json' \
  -d '{"Do":"merge","MergeTitleField":"chore(main): release v0.1.1","MergeMessageField":""}' \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/2/merge" >"${WORK_DIR}/second-merge.json"
second_merge_sha="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/pulls/2" | jq -r '.merge_commit_sha')"
test -n "${second_merge_sha}"

run_action
tags="$(curl -fsS -H "${AUTH_HEADER}" "${ROOT_URL}/api/v1/repos/e2e/demo/tags")"
releases="$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/releases")"
test "$(jq 'length' <<<"${tags}")" = '2'
test "$(jq -r '.[] | select(.name == "v0.1.1") | .commit.sha' <<<"${tags}")" = "${second_merge_sha}"
test "$(jq 'length' <<<"${releases}")" = '2'
test "$(jq -r '.[] | select(.tag_name == "v0.1.1") | .target_commitish' <<<"${releases}")" = "${second_merge_sha}"

run_action
test "$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/tags" | jq 'length')" = '2'
test "$(curl -fsS -H "${AUTH_HEADER}" \
  "${ROOT_URL}/api/v1/repos/e2e/demo/releases" | jq 'length')" = '2'

echo 'Gitea 1.27 integration test passed.'
