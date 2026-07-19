# Gitea Release Please Action

A Node.js 24 action that brings the standard Google Release Please workflow to Gitea 1.27+ and `gitea/runner` 2.x. It supports one package at the repository root or in one subdirectory, one target branch, and the `simple` release type. Monorepos, component-specific versions, and language/platform release strategies are out of scope.

## Standard workflow

Run the same action on every push to the target branch:

```yaml
name: release-please

on:
  push:
    branches: [main]

concurrency:
  group: release-please-main
  cancel-in-progress: false

jobs:
  release-please:
    permissions:
      code: write
      releases: write
      pull-requests: write
      issues: write
      actions: write # only needed for workflow_dispatch below
    runs-on: ubuntu-latest
    steps:
      - uses: https://github.com/kuddy-on/gitea-release-please-action@v2
        id: release
        with:
          token: ${{ secrets.GITEA_TOKEN }}

      - name: Dispatch release build
        if: ${{ steps.release.outputs.release_created == 'true' }}
        shell: sh
        env:
          GITEA_API_URL: ${{ gitea.api_url }}
          GITEA_REPOSITORY: ${{ gitea.repository }}
          GITEA_TOKEN: ${{ secrets.GITEA_TOKEN }}
          TAG_NAME: ${{ steps.release.outputs.tag_name }}
        run: |
          node --input-type=module -e '
            const response = await fetch(`${process.env.GITEA_API_URL}/repos/${process.env.GITEA_REPOSITORY}/actions/workflows/build.yml/dispatches`, {
              method: "POST",
              headers: {Authorization: `token ${process.env.GITEA_TOKEN}`, "Content-Type": "application/json"},
              body: JSON.stringify({ref: "main", inputs: {tag_name: process.env.TAG_NAME}}),
            });
            if (!response.ok) throw new Error(`dispatch failed: ${response.status} ${await response.text()}`);
          '
```

Short references such as `owner/gitea-release-please-action@v2` resolve against Gitea's
`[actions].DEFAULT_ACTIONS_URL`, which defaults to GitHub. For an action mirrored on an
internal Gitea instance, use its absolute URL, for example
`https://gitea.example.com/owner/gitea-release-please-action@v2`. Use a short reference
only when the server is intentionally configured with `DEFAULT_ACTIONS_URL=self`.

Add `.release-please-manifest.json` before the first run. An empty object bootstraps a new package; an existing project must record its latest released version:

```json
{
  ".": "1.2.3"
}
```

Each invocation performs the two Google-style phases in order:

1. Find a merged, pending Release PR and create its tag and Gitea Release.
2. Read the manifest, recalculate changes after its matching release tag, and create or update the next Release PR.

Merging the Release PR creates a `push` on `main`; that push starts the action and publishes the release immediately. No separate publish action or PR-number input is required.

## Release PR behavior

The action parses Conventional Commits since the Tag recorded by `.release-please-manifest.json`. `feat` produces a minor bump, `fix`, `perf`, `deps`, and `revert` produce a patch, and `!` or `BREAKING CHANGE:` produces a major bump. Before 1.0, the two pre-major bump options can alter this behavior. A manifest version must have a matching reachable Tag; an empty manifest is accepted only when no release Tags exist.

When using Gitea's merge-commit method for ordinary pull requests, keep the default merge
title. A custom Conventional Commit merge title is parsed in addition to Conventional
Commits already present in the pull request and can produce duplicate changelog entries.
Squash merges contain only the resulting squash commit and are not affected by this rule.

The first release defaults to `1.0.0` when the manifest has no package entry. The Release PR updates:

- `.release-please-manifest.json`, recording the pending package version;
- `CHANGELOG.md`, containing cumulative release history;
- configured `extra-files`.

The pending release notes are shown in the Release PR body. The action does not create a
standalone `RELEASE.md` file. During publication it extracts the pending version section from
`CHANGELOG.md`; with `skip-changelog: true`, it uses the hash-checked notes section embedded in
the Release PR body instead.

The machine branch is `release-please--branches--main`, and the default PR title is `chore(main): release 1.2.3`. While it remains open, every new push to `main` rebuilds that branch from the latest `main`, updates the same PR, and recalculates the highest bump. The branch must allow force updates and must not be edited manually. Squash, merge, rebase, and rebase-merge are all supported when the Release PR is merged. Gitea's **Delete branch after merge** option is also supported; publication uses the verified merge commit when Gitea has already archived the PR head ref.

`Release-As: 2.0.0` in a commit footer forces a version. A merged PR body may replace a single commit's parsed message with:

```text
BEGIN_COMMIT_OVERRIDE
feat(api): describe the squashed change
END_COMMIT_OVERRIDE
```

## Configuration

Inputs can configure the action directly. `manifest-file` defaults to `.release-please-manifest.json`. For a reusable Release Please configuration, pass `config-file: release-please-config.json`. Flat configuration and exactly one `packages` entry are accepted:

```json
{
  "packages": {
    ".": {
      "release-type": "simple",
      "initial-version": "1.0.0",
      "include-v-in-tag": false,
      "extra-files": [
        {"type": "json", "path": "package.json", "jsonpath": "$.version"},
        {"type": "toml", "path": "pyproject.toml", "jsonpath": "$.project.version"}
      ]
    }
  }
}
```

### Package path

Set `path` when the only released package is below the repository root:

```yaml
with:
  token: ${{ secrets.GITEA_TOKEN }}
  path: services/api
```

Only commits touching `services/api` participate in version calculation. `CHANGELOG.md` and `extra-files` paths are relative to that directory; the manifest remains at the repository-relative `manifest-file` location and uses the key `services/api`. The equivalent repository configuration is:

```json
{
  "packages": {
    "services/api": {
      "release-type": "simple",
      "extra-files": [
        {"type": "json", "path": "package.json", "jsonpath": "$.version"}
      ]
    }
  }
}
```

The matching manifest is:

```json
{
  "services/api": "1.2.3"
}
```

Important options include `release-as`, `bootstrap-sha`, `last-release-sha`, `versioning`, `bump-minor-pre-major`, `bump-patch-for-minor-pre-major`, `prerelease`, `prerelease-type`, `draft`, `draft-pull-request`, `skip-changelog`, `exclude-paths`, `changelog-sections`, `include-commit-authors`, PR title/header/footer, lifecycle labels, release-name prefix, date format, and signoff. See [`action.yml`](action.yml) for direct action inputs.

Set `tag-prefix: ''` or `include-v-in-tag: false` for tags such as `1.2.3`. Gitea's create-PR API has no draft field, so `draft-pull-request` uses its `WIP:` title convention.

`force-tag-creation` needs no special setting: this action always creates the Gitea Tag explicitly before creating the Release, including for draft Releases. Set `proxy-server: proxy.example:8080` (or a full HTTP/HTTPS proxy URL) to proxy all Gitea API calls.

### Extra files

Supported types are `generic`, `json`, `toml`, `yaml`, and `xml`. Structured formats use `jsonpath` or `xpath`. Generic files use Release Please markers:

```ts
export const VERSION = '1.2.3'; // x-release-please-version
export const MAJOR = 1; // x-release-please-major
```

As in Google Release Please, a bare path string selects the generic marker updater; use an object with an explicit type and selector for structured files.

Set `"glob": true` to expand `*`, `?`, and `**`, for example:

```json
{"type":"json","path":"packages/**/package.json","jsonpath":"$.version","glob":true}
```

Every matched file must exist and every selector or generic marker must match. A mismatch stops the action instead of leaving versions inconsistent.

## Publishing and security

Publishing requires all of the following: a closed and merged PR, the action's machine-readable marker, the pending lifecycle label, the expected machine branch and source repository, a manifest entry matching the pending version, matching generated-file and release-notes hashes at the merge commit, and a non-conflicting tag. The action tags the Release PR merge SHA, creates the Gitea Release from the current `CHANGELOG.md` version section (or the Release PR body when `skip-changelog` is enabled), changes `autorelease: pending` to `autorelease: tagged`, and deletes the machine branch. Reruns are idempotent and can repair a missing Release when the correct tag already exists.

### Migrating from v1

Version 2 replaces the mandatory `version.txt` contract with the standard manifest. Before changing `@v1` to `@v2`, create `.release-please-manifest.json` with the version of the latest reachable Tag, remove `version-file`, and keep real package versions under `extra-files`. For example, migrate Tag `v1.2.3` with `{ ".": "1.2.3" }`. A mismatch stops the action rather than guessing a release boundary.

`release-notes-path` is deprecated and ignored. Existing open Release PRs using the old marker
format remain publishable through their legacy notes file, but new Release PRs do not create or
update that file. A previously generated `RELEASE.md` can be removed after upgrading.

`skip-gitea-release` leaves publication to an external process. Until a matching tag exists, the merged pending PR intentionally blocks creation of another Release PR.

Use `${{ secrets.GITEA_TOKEN }}` with `code`, `releases`, `pull-requests`, and `issues` write permissions. Add `actions: write` only when dispatching another workflow. Effective permissions are capped by the repository/owner Actions settings. A PAT may be used when the built-in token cannot force-push the machine branch or manage releases.

Set `fork: true` to put the machine branch in the token user's fork and open the PR as `username:release-please--branches--main`. The action creates or reuses that fork, rebases it onto new target-branch commits before each rebuild, and deletes its machine branch after publication. The token must be allowed to create a fork and must still have upstream permission to create labels, Tags, and Releases; a user PAT is normally required.

Actions performed by Gitea's internal Actions user may not recursively trigger other workflows. Dispatching `build.yml` explicitly after `release_created == 'true'` is therefore more reliable than waiting for the generated tag event. See [`examples/release.yml`](examples/release.yml) and [`examples/build.yml`](examples/build.yml).

## Outputs

The Google-compatible outputs are `release_created`, `releases_created`, `paths_released`, `prs_created`, `pr`, `prs`, `upload_url`, `html_url`, `tag_name`, `version`, `major`, `minor`, `patch`, `sha`, `body`, `id`, `name`, `path`, `prNumber`, and `draft`. Compatibility aliases `pr_created`, `pr_updated`, and `pr_number` are also emitted.

As in Google's Action, a non-root package prefixes release-specific outputs with its path. For `path: services/api`, use `${{ steps.release.outputs['services/api--release_created'] }}` and `${{ steps.release.outputs['services/api--tag_name'] }}`; `releases_created`, `paths_released`, and PR outputs remain global.

## Compatibility boundary

Supported Google behavior includes the standard push trigger, a single-package Release Please manifest, one continuously updated Release PR, automatic publication after every Gitea merge method, a root or non-root package path, Conventional Commit/Release-As calculation, changelog customization, versioning strategies, labels, draft/prerelease releases, extra files and globs, repository config, fork PRs, explicit proxies, and action outputs.

Not supported: multiple manifest packages, multiple components or simultaneous versions, language/platform-specific release types, and their plugins. `changelog-type: github` has no Gitea 1.27 equivalent because Gitea does not expose GitHub's generated-release-notes API; use the default Conventional Commit changelog.

## Development

```bash
npm ci
npm run check
npm run test:integration
```

The integration test starts a disposable standard `gitea/gitea:1.27` container and verifies the full create-update-merge-tag-release lifecycle, all four merge methods, path-scoped commits and outputs, fork branch rebuilds, and both `v` and empty tag prefixes. Commit the generated `dist/` bundle after runtime changes.
