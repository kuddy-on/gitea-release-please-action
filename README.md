# Gitea Release Please Action

`gitea-release-please-action` maintains a release pull request from Conventional Commits and publishes a Gitea tag and Release when that pull request is merged.

It follows the core workflow of Google's `release-please`, but talks directly to the Gitea 1.27+ REST API. It runs on Node.js 24 with Gitea Runner 1.0+ (2.0 recommended) and does not require `actions/checkout`.

## How it works

On every push to the target branch, the action:

1. Finds Conventional Commits since the latest reachable matching SemVer tag.
2. Creates or updates one release PR containing a cumulative `CHANGELOG.md` and a replace-on-update `RELEASE.md`.
3. Detects when a generated release PR has been merged.
4. Tags the PR merge commit and creates a Gitea Release whose body is the merged `RELEASE.md`.

The generated PR is identified by a machine-readable marker in its body. Reruns are idempotent: an existing matching tag is reused, a missing Release is repaired, and a tag pointing at a different commit is never moved.

## Usage

On Gitea 1.27+, use the per-job built-in `GITEA_TOKEN`. It does not need to be created or stored as a custom secret.

```yaml
name: release-please

on:
  push:
    branches:
      - main

permissions:
  code: write
  releases: write
  pull-requests: write
  issues: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: https://github.com/kuddy-on/gitea-release-please-action@v1
        with:
          token: ${{ secrets.GITEA_TOKEN }}
```

For an action mirrored onto the same Gitea instance, use its normal `owner/repository@v1` reference instead.

The workflow requests write access to repository code, Releases, pull requests, and issue labels. Effective permissions are capped by the owner and repository settings under `Settings` → `Actions` → `General`, so those settings must also allow the requested writes. `contents: write` can be used instead of separate `code: write` and `releases: write` permissions. See [Gitea Actions job token permissions](https://docs.gitea.com/usage/actions/token-permissions).

The `token` input remains required so the authentication choice is explicit. When the built-in token cannot be granted the required permissions, use a personal access token in a repository or organization secret instead:

```yaml
with:
  token: ${{ secrets.RELEASE_TOKEN }}
```

The personal access token's user must be allowed to push the generated branch and create pull requests, tags, Releases, and labels.

## Triggering build workflows

A release PR merged through the Gitea UI by a normal user produces a `push` event on the target branch. Other workflows such as the following build workflow will run normally:

```yaml
name: build

on:
  push:
    branches:
      - main
```

Gitea suppresses new workflow runs for events whose actor is the internal `gitea-actions` user, preventing recursive Actions runs. This affects operations performed with `GITEA_TOKEN` as follows:

| Operation | Starts another matching workflow? |
| --- | --- |
| Release PR merged in the UI by a normal user | Yes; the merge emits `push` on the target branch and `pull_request` closed events. |
| Release branch or PR created/updated by this action | No. |
| Tag or Gitea Release created by this action | No; separate `push`-tag, `create`, or `release` workflows are not started. |
| Release PR merged by another job using `GITEA_TOKEN` | No. |
| `workflow_dispatch` requested through the API with `GITEA_TOKEN` | Yes, when the release job has `actions: write`. |

Therefore, a normal UI merge can trigger an independent build workflow on `push` to `main`. If artifacts must be built only after this action has created the tag and Release, either run the build in the same job or explicitly dispatch a separate build workflow. Do not rely on implicit tag or Release events. The suppression behavior is implemented by Gitea's [Actions notifier](https://github.com/go-gitea/gitea/blob/main/services/actions/notifier_helper.go).

### Dispatch a build after creating the Release

Add `actions: write` to the release workflow, then call the workflow dispatch API only when `release_created` is `true`:

```yaml
permissions:
  code: write
  releases: write
  pull-requests: write
  issues: write
  actions: write

steps:
  - uses: https://github.com/kuddy-on/gitea-release-please-action@v1
    id: release
    with:
      token: ${{ secrets.GITEA_TOKEN }}

  - name: Dispatch build workflow
    if: ${{ steps.release.outputs.release_created == 'true' }}
    shell: sh
    env:
      GITEA_API_URL: ${{ gitea.api_url }}
      GITEA_REPOSITORY: ${{ gitea.repository }}
      GITEA_TOKEN: ${{ secrets.GITEA_TOKEN }}
      TAG_NAME: ${{ steps.release.outputs.tag_name }}
    run: |
      node --input-type=module -e '
        const url = `${process.env.GITEA_API_URL}/repos/${process.env.GITEA_REPOSITORY}/actions/workflows/build.yml/dispatches`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `token ${process.env.GITEA_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: "main",
            inputs: {tag_name: process.env.TAG_NAME},
          }),
        });
        if (!response.ok) {
          throw new Error(`workflow_dispatch failed: ${response.status} ${await response.text()}`);
        }
        console.log(`Dispatched build for ${process.env.TAG_NAME}`);
      '
```

The dispatch request is:

```json
{
  "ref": "main",
  "inputs": {
    "tag_name": "v1.2.3"
  }
}
```

Send it to `POST /api/v1/repos/{owner}/{repo}/actions/workflows/build.yml/dispatches`. The build workflow declares `workflow_dispatch` and reads `${{ inputs.tag_name }}`. See the complete [release workflow](examples/release.yml) and [build workflow](examples/build.yml). This path is covered by a real Gitea 1.27.0 and Gitea Runner 2.0 test.

## Commit and version rules

| Commit | Version effect | Release notes section |
| --- | --- | --- |
| `feat:` | minor | Features |
| `fix:` | patch | Bug Fixes |
| `perf:` | patch | Performance |
| `deps:` | patch | Dependencies |
| `type!:` or `BREAKING CHANGE:` | major | Breaking Changes |
| Other types | none | omitted |

Examples:

```text
feat(api): add sample search
fix: handle an empty result
refactor(storage)!: replace the legacy schema
```

When no matching tag exists, the first releasable commit produces `0.1.0` by default, regardless of its normal bump level. Normal SemVer bumping starts after that release. Pre-release versions are not supported in v1.

Release PRs support Merge Commit and Squash Merge. Rebase Merge is not supported because it does not provide a stable single merge SHA for tagging.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `token` | yes | — | Built-in `GITEA_TOKEN` (recommended on Gitea 1.27+) or a personal access token. |
| `gitea-url` | no | current Actions server | Gitea root URL or `/api/v1` URL. |
| `repository` | no | current repository | Repository in `owner/name` form. |
| `target-branch` | no | repository default | Release PR target branch. |
| `initial-version` | no | `0.1.0` | Version of the first release. |
| `tag-prefix` | no | `v` | Prefix for SemVer tags. |
| `changelog-path` | no | `CHANGELOG.md` | Cumulative changelog path. |
| `release-notes-path` | no | `RELEASE.md` | Current release body path. |
| `bootstrap-sha` | no | — | Exclusive lower commit boundary for the first scan. |

Paths are repository-relative and must be different. Set `changelog-path: changelog.md` and `release-notes-path: release.md` if lowercase names are preferred.

## Outputs

| Output | Description |
| --- | --- |
| `pr_created` | `true` when a release PR was created. |
| `pr_updated` | `true` when an existing release PR changed. |
| `pr_number` | Number of the created or updated PR. |
| `release_created` | `true` when a Gitea Release was created. |
| `tag_name` | Created release tag. |
| `version` | Full created release version. |
| `major`, `minor`, `patch` | Created release version components. |
| `sha` | Tagged merge commit. |
| `release_url` | Gitea Release URL. |
| `body` | Gitea Release body. |

Release-specific outputs are populated only when `release_created` is `true`.

```yaml
      - uses: https://github.com/kuddy-on/gitea-release-please-action@v1
        id: release
        with:
          token: ${{ secrets.GITEA_TOKEN }}

      - name: Publish artifacts
        if: ${{ steps.release.outputs.release_created == 'true' }}
        run: ./scripts/publish "${{ steps.release.outputs.tag_name }}"
```

## Generated state and recovery

- Branch: `gitea-release-please--branches--<target>`
- PR/commit title: `chore(<target>): release vX.Y.Z`
- Labels: `autorelease: pending` and `autorelease: tagged` when label permissions are available

Do not edit generated release files directly on the release branch. Their hashes are recorded in the PR marker, and the action stops instead of overwriting unexpected changes. To change release notes, amend the Conventional Commit messages before merging or close the release PR, remove its generated branch, and rerun.

After a release is created, the action deletes its merged generated branch so the same deterministic name can be used for the next release cycle.

If tag creation succeeds but Release creation fails, rerun the workflow. The action verifies the existing tag target and creates the missing Release. If the generated branch exists without a PR after an interrupted run, it is recovered only when its commit and files exactly match the current candidate.

## Development

Node.js 24 or newer is required.

```bash
npm ci
npm run check
```

With Docker, `curl`, and `jq` installed, run the real Gitea 1.27 lifecycle test with:

```bash
npm run test:integration
```

`dist/` is committed because Node actions execute the bundled entrypoint. Run `npm run build` after changing runtime code.

Current v1 scope is intentionally single-repository and single-version. Monorepo manifests, language-specific version files, prereleases, signed tags, release assets, forks, and rebase merges are not implemented.
