import semver from 'semver';

import { parseChanges } from './conventional.js';
import { expandExtraFiles, updateExtraFile } from './extra-files.js';
import { GiteaApiError, GiteaClient } from './gitea-client.js';
import { packageVersion, parseManifest, updateManifest } from './manifest.js';
import { buildPullRequestBody, hashContent, parseMarker } from './marker.js';
import { generateReleaseMarkdown } from './markdown.js';
import type { ReleaseHead } from './release-head.js';
import { addPath, pathContains, ROOT_PROJECT_PATH } from './repository-path.js';
import {
  LifecycleLabels,
  releaseBranchName,
  verifyMarkerFiles,
} from './release-state.js';
import { calculateVersion } from './versioning.js';
import type {
  ActionConfig,
  ChangeFileOperation,
  Logger,
  PrepareResult,
  PullRequest,
  PullRequestOutput,
  ReleaseCandidate,
  ReleaseMarker,
  RepositoryCommit,
  RepositoryTag,
} from './types.js';

export type ReleaseApi = Pick<
  GiteaClient,
  | 'changeFiles'
  | 'createLabel'
  | 'createPullRequest'
  | 'editPullRequest'
  | 'getBranch'
  | 'getContent'
  | 'getRepository'
  | 'getTextContent'
  | 'listCommits'
  | 'listLabels'
  | 'listFiles'
  | 'listPullRequests'
  | 'listTags'
  | 'updatePullRequestBranch'
>;

interface CommitScan {
  commits: RepositoryCommit[];
  previousTag?: RepositoryTag;
  targetHeadSha: string;
}

function versionFromTag(tagName: string, prefix: string): string | null {
  if (!tagName.startsWith(prefix)) return null;
  const candidate = tagName.slice(prefix.length);
  const parsed = semver.parse(candidate);
  if (!parsed) return null;
  return parsed.version;
}

function createMarker(
  config: ActionConfig,
  targetBranch: string,
  targetHeadSha: string,
  candidate: ReleaseCandidate,
): ReleaseMarker {
  const marker: ReleaseMarker = {
    schema: 2,
    path: config.path,
    version: candidate.version,
    tagName: candidate.tagName,
    targetBranch,
    targetHeadSha,
    releaseNotesPath: addPath(config.path, config.releaseNotesPath),
    manifestPath: config.manifestFile,
    fileHashes: Object.fromEntries(
      Object.entries(candidate.files).map(([path, content]) => [path, hashContent(content)]),
    ),
  };
  if (!config.skipChangelog) marker.changelogPath = addPath(config.path, config.changelogPath);
  return marker;
}

function formatDate(date: Date, pattern: string): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return pattern
    .replace(/%Y/g, year)
    .replace(/%m/g, month)
    .replace(/%d/g, day)
    .replace(/%F/g, `${year}-${month}-${day}`);
}

function releaseTitle(pattern: string, targetBranch: string, version: string): string {
  return pattern
    .replaceAll('${scope}', `(${targetBranch})`)
    .replaceAll('${component}', '')
    .replaceAll('${version}', version)
    .replaceAll('${branch?}', targetBranch);
}

function pullRequestOutput(
  pullRequest: PullRequest,
  files: string[],
  labels: string[],
): PullRequestOutput {
  const output: PullRequestOutput = {
    headBranchName: pullRequest.head.ref,
    baseBranchName: pullRequest.base.ref,
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    labels,
    files,
  };
  if (pullRequest.merge_commit_sha) output.mergeCommitOid = pullRequest.merge_commit_sha;
  if (pullRequest.head.sha) output.sha = pullRequest.head.sha;
  return output;
}

export class ReleaseManager {
  private readonly lifecycle: LifecycleLabels;

  constructor(
    private readonly client: ReleaseApi,
    private readonly config: ActionConfig,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly head: ReleaseHead = {
      client: client as GiteaClient,
      fullName: `${config.owner}/${config.repo}`,
      owner: config.owner,
      fork: false,
    },
  ) {
    this.lifecycle = new LifecycleLabels(client, logger);
  }

  async run(): Promise<PrepareResult> {
    const repository = await this.client.getRepository();
    const targetBranch = this.config.targetBranch ?? repository.default_branch;
    if (!targetBranch) throw new Error('The repository has no default branch.');

    const result: PrepareResult = {
      prCreated: false,
      prUpdated: false,
    };
    const untaggedMerged = await this.findUntaggedMergedRelease(targetBranch);
    if (untaggedMerged) {
      this.logger.warning(
        `Release PR #${untaggedMerged.number} is merged but untagged; skipping release PR creation.`,
      );
      return result;
    }

    const manifestContent = await this.client.getTextContent(
      this.config.manifestFile,
      targetBranch,
    );
    if (manifestContent === null) {
      throw new Error(
        `Manifest file ${this.config.manifestFile} does not exist on ${targetBranch}.`,
      );
    }
    const manifest = parseManifest(manifestContent, this.config.manifestFile);
    const previousVersion = packageVersion(
      manifest,
      this.config.path,
      this.config.manifestFile,
    );
    const scan = await this.scanCommits(targetBranch, previousVersion);
    const commits = await this.applyCommitOverrides(
      scan.commits.filter((commit) => this.includeCommit(commit)),
    );
    const changes = parseChanges(commits, this.config.changelogSections);
    if (changes.length === 0) {
      this.logger.info('No releasable Conventional Commits were found.');
      return result;
    }

    const version = calculateVersion(previousVersion, changes, this.config);

    const tagName = `${this.config.tagPrefix}${version}`;
    const changelogPath = addPath(this.config.path, this.config.changelogPath);
    const releaseNotesPath = addPath(this.config.path, this.config.releaseNotesPath);
    const existingChangelog = this.config.skipChangelog
      ? null
      : await this.client.getTextContent(changelogPath, targetBranch);
    const now = this.now();
    const date = formatDate(now, '%Y-%m-%d');
    const extraFileDate = formatDate(now, this.config.dateFormat);
    const markdown = generateReleaseMarkdown({
      version,
      tagName,
      date,
      changes,
      webUrl: this.config.changelogHost,
      owner: this.config.owner,
      repo: this.config.repo,
      changelogSections: this.config.changelogSections,
      includeCommitAuthors: this.config.includeCommitAuthors,
      ...(existingChangelog === null ? {} : { existingChangelog }),
      ...(scan.previousTag ? { previousTag: scan.previousTag.name } : {}),
    });
    const files: Record<string, string> = {
      [releaseNotesPath]: markdown.releaseNotes,
      [this.config.manifestFile]: updateManifest(manifest, this.config.path, version),
    };
    if (!this.config.skipChangelog) files[changelogPath] = markdown.changelog;
    const repositoryExtraFiles = this.config.extraFiles.map((file) => ({
      ...file,
      path: addPath(this.config.path, file.path),
    }));
    const repositoryFiles = this.config.extraFiles.some((file) => file.glob)
      ? await this.client.listFiles(targetBranch)
      : [];
    const configuredExtraFiles = expandExtraFiles(repositoryExtraFiles, repositoryFiles);
    const reservedPaths = new Set([
      changelogPath,
      releaseNotesPath,
      this.config.manifestFile,
    ]);
    const reservedMatch = configuredExtraFiles.find((file) => reservedPaths.has(file.path));
    if (reservedMatch) {
      throw new Error(`extra-files path ${reservedMatch.path} conflicts with a release file.`);
    }
    const extraFiles = await Promise.all(
      configuredExtraFiles.map(async (extraFile) => {
        const content = await this.client.getTextContent(extraFile.path, targetBranch);
        if (content === null) {
          throw new Error(`Configured extra file ${extraFile.path} does not exist on ${targetBranch}.`);
        }
        return [
          extraFile.path,
          updateExtraFile(
            extraFile,
            content,
            version,
            extraFileDate,
            this.config.dateFormat,
          ),
        ] as const;
      }),
    );
    for (const [path, content] of extraFiles) files[path] = content;

    const candidate: ReleaseCandidate = {
      version,
      tagName,
      changes,
      changelog: markdown.changelog,
      releaseNotes: markdown.releaseNotes,
      files,
      ...(scan.previousTag ? { previousTag: scan.previousTag.name } : {}),
    };

    await this.syncReleasePullRequest(targetBranch, scan.targetHeadSha, candidate, result);
    return result;
  }

  private async applyCommitOverrides(
    commits: RepositoryCommit[],
  ): Promise<RepositoryCommit[]> {
    const closedPullRequests = await this.client.listPullRequests('closed');
    const overrides = new Map<string, string>();
    for (const pullRequest of closedPullRequests) {
      if (!pullRequest.merged || !pullRequest.merge_commit_sha) continue;
      const match = (pullRequest.body ?? '').match(
        /(?:^|\n)BEGIN_COMMIT_OVERRIDE\s*\r?\n([\s\S]*?)\r?\nEND_COMMIT_OVERRIDE(?:\n|$)/,
      );
      const override = match?.[1]?.trim();
      if (override) overrides.set(pullRequest.merge_commit_sha, override);
    }
    return commits.map((commit) => {
      const override = overrides.get(commit.sha);
      if (!override || commit.parents.length > 1) return commit;
      this.logger.info(`Using merged PR commit override for ${commit.sha.slice(0, 7)}.`);
      return { ...commit, commit: { ...commit.commit, message: override } };
    });
  }

  private includeCommit(commit: RepositoryCommit): boolean {
    if (commit.files == null) return this.config.path === ROOT_PROJECT_PATH;
    const relevantFiles = commit.files.filter((file) =>
      pathContains(this.config.path, file.filename),
    );
    if (relevantFiles.length === 0) return false;
    if (this.config.excludePaths.length === 0) return true;
    return !relevantFiles.every((file) =>
      this.config.excludePaths.some(
        (path) => file.filename === path || file.filename.startsWith(`${path}/`),
      ),
    );
  }

  private async findUntaggedMergedRelease(
    targetBranch: string,
  ): Promise<PullRequest | undefined> {
    const [closedPullRequests, tags] = await Promise.all([
      this.client.listPullRequests('closed'),
      this.client.listTags(),
    ]);
    const tagNames = new Set(tags.map((tag) => tag.name));
    return closedPullRequests.find((pullRequest) => {
      if (!pullRequest.merged) return false;
      const marker = parseMarker(pullRequest.body ?? '');
      if (!marker || marker.targetBranch !== targetBranch || tagNames.has(marker.tagName)) {
        return false;
      }
      if ((marker.path ?? ROOT_PROJECT_PATH) !== this.config.path) return false;
      if (this.config.skipLabeling) return true;
      const names = new Set((pullRequest.labels ?? []).map((label) => label.name));
      return this.config.labels.every((label) => names.has(label));
    });
  }

  private async scanCommits(
    targetBranch: string,
    previousVersion: string | null,
  ): Promise<CommitScan> {
    const [commits, tags] = await Promise.all([
      this.client.listCommits(
        targetBranch,
        this.config.path !== ROOT_PROJECT_PATH || this.config.excludePaths.length > 0,
      ),
      this.client.listTags(),
    ]);
    const targetHead = commits[0];
    if (!targetHead) throw new Error(`Target branch ${targetBranch} has no commits.`);

    const releaseTags = tags.filter(
      (tag) => versionFromTag(tag.name, this.config.tagPrefix) !== null,
    );
    const expectedTagName =
      previousVersion === null
        ? null
        : `${this.config.tagPrefix}${previousVersion}`;
    const expectedTag = expectedTagName
      ? releaseTags.find((tag) => tag.name === expectedTagName)
      : undefined;
    if (previousVersion === null && releaseTags.length > 0) {
      throw new Error(
        `${this.config.manifestFile} has no ${this.config.path} entry, but release tags already exist. Initialize the manifest with the latest released version.`,
      );
    }
    if (
      previousVersion !== null &&
      !expectedTag &&
      (previousVersion !== '0.0.0' || releaseTags.length > 0)
    ) {
      throw new Error(
        `${this.config.manifestFile} expects release tag ${expectedTagName}, but it does not exist.`,
      );
    }

    const selectedCommits: RepositoryCommit[] = [];
    const boundarySha =
      expectedTag?.commit.sha ?? this.config.lastReleaseSha ?? this.config.bootstrapSha;
    let foundBoundary = !boundarySha;

    for (const commit of commits) {
      if (boundarySha && commit.sha.startsWith(boundarySha)) {
        foundBoundary = true;
        break;
      }
      selectedCommits.push(commit);
    }

    if (!foundBoundary) {
      throw new Error(
        expectedTag
          ? `Manifest release tag ${expectedTag.name} is not reachable from ${targetBranch}.`
          : `commit boundary ${boundarySha} was not found on ${targetBranch}.`,
      );
    }

    const scan: CommitScan = {
      commits: selectedCommits.reverse(),
      targetHeadSha: targetHead.sha,
    };
    if (expectedTag) scan.previousTag = expectedTag;
    return scan;
  }

  private async syncReleasePullRequest(
    targetBranch: string,
    targetHeadSha: string,
    candidate: ReleaseCandidate,
    result: PrepareResult,
  ): Promise<void> {
    const branch = releaseBranchName(targetBranch);
    const repository = this.head.fullName;
    const pullRequests = await this.client.listPullRequests('open');
    const releasePullRequests = pullRequests.filter((pullRequest) => {
      const marker = parseMarker(pullRequest.body ?? '');
      return marker?.targetBranch === targetBranch;
    });
    for (const pullRequest of releasePullRequests) {
      const marker = parseMarker(pullRequest.body ?? '');
      if ((marker?.path ?? ROOT_PROJECT_PATH) !== this.config.path) {
        throw new Error(
          `PR #${pullRequest.number} manages path ${marker?.path ?? ROOT_PROJECT_PATH}, not configured path ${this.config.path}. Close it before changing path.`,
        );
      }
      if (
        pullRequest.head.ref !== branch ||
        pullRequest.base.ref !== targetBranch ||
        pullRequest.head.repo?.full_name !== repository
      ) {
        throw new Error(
          `PR #${pullRequest.number} has a release marker for ${targetBranch} but is not the managed ${branch} pull request from ${repository}.`,
        );
      }
    }
    if (releasePullRequests.length > 1) {
      throw new Error(
        `Found multiple open release pull requests for ${targetBranch}: ${releasePullRequests
          .map((pullRequest) => `#${pullRequest.number}`)
          .join(', ')}.`,
      );
    }

    const baseTitle = releaseTitle(
      this.config.pullRequestTitlePattern,
      targetBranch,
      candidate.version,
    );
    const title = this.config.draftPullRequest ? `WIP: ${baseTitle}` : baseTitle;
    const commitMessage = this.config.signoff
      ? `${baseTitle}\n\nSigned-off-by: ${this.config.signoff}`
      : baseTitle;
    const marker = createMarker(this.config, targetBranch, targetHeadSha, candidate);
    const body = buildPullRequestBody(
      marker,
      candidate.releaseNotes,
      this.config.pullRequestHeader,
      this.config.pullRequestFooter,
    );
    const existingPullRequest = releasePullRequests[0];

    if (!existingPullRequest) {
      await this.createReleasePullRequest(
        targetBranch,
        targetHeadSha,
        branch,
        title,
        body,
        commitMessage,
        candidate,
        result,
      );
      return;
    }

    const previousMarker = parseMarker(existingPullRequest.body ?? '');
    if (!previousMarker) throw new Error('Internal error: release pull request marker disappeared.');
    if (
      (previousMarker.path ?? ROOT_PROJECT_PATH) !== this.config.path ||
      previousMarker.changelogPath !==
        (this.config.skipChangelog
          ? undefined
          : addPath(this.config.path, this.config.changelogPath)) ||
      previousMarker.releaseNotesPath !== addPath(this.config.path, this.config.releaseNotesPath) ||
      previousMarker.manifestPath !== this.config.manifestFile
    ) {
      throw new Error(
        `Release file paths changed while PR #${existingPullRequest.number} is open. Close it before changing action paths.`,
      );
    }
    const previousFiles = Object.keys(previousMarker.fileHashes).sort();
    const candidateFiles = Object.keys(candidate.files).sort();
    if (JSON.stringify(previousFiles) !== JSON.stringify(candidateFiles)) {
      throw new Error(
        `Generated file set changed while PR #${existingPullRequest.number} is open. Close it before changing extra-files.`,
      );
    }

    await verifyMarkerFiles(
      this.head.client,
      previousMarker,
      branch,
      existingPullRequest.number,
    );
    const releaseOperations = await this.fileOperations(branch, candidate, this.head.client);
    const baseChanged = previousMarker.targetHeadSha !== targetHeadSha;
    const rebuildBranch = baseChanged || releaseOperations.length > 0;
    if (rebuildBranch) {
      const operations = await this.fileOperations(targetBranch, candidate);
      if (operations.length === 0) {
        throw new Error(
          `Release PR #${existingPullRequest.number} has no generated diff from ${targetBranch}; close it before rerunning.`,
        );
      }
      this.logger.info(
        `Rebuilding release PR #${existingPullRequest.number} from ${targetBranch}.`,
      );
      try {
        if (this.head.fork) {
          this.logger.info(
            `Rebasing fork release PR #${existingPullRequest.number} onto ${targetBranch}.`,
          );
          await this.client.updatePullRequestBranch(existingPullRequest.number, 'rebase');
          const currentBranch = await this.head.client.getBranch(branch);
          if (!currentBranch) throw new Error(`Fork release branch ${branch} disappeared.`);
          await this.head.client.updateBranch(
            branch,
            targetHeadSha,
            currentBranch.commit.id,
          );
          await this.head.client.changeFiles({ branch, message: commitMessage, files: operations });
        } else {
          await this.client.changeFiles({
            branch: targetBranch,
            newBranch: branch,
            forcePush: true,
            message: commitMessage,
            files: operations,
          });
        }
      } catch (error) {
        if (error instanceof GiteaApiError && error.status === 403) {
          throw new Error(
            `Gitea rejected the force-push for release PR #${existingPullRequest.number}. Ensure ${branch} allows force pushes and the token has repository write permission.`,
            { cause: error },
          );
        }
        throw error;
      }
    }

    const metadataChanged =
      existingPullRequest.title !== title || existingPullRequest.body !== body;
    let outputPullRequest = existingPullRequest;
    if (metadataChanged) {
      outputPullRequest = await this.client.editPullRequest(existingPullRequest.number, {
        title,
        body,
      });
    }
    if (rebuildBranch || metadataChanged || this.config.alwaysUpdate) {
      if (!this.config.skipLabeling) {
        await this.lifecycle.set(
          outputPullRequest,
          [...this.config.labels, ...this.config.extraLabels],
          [...this.config.labels, ...this.config.releaseLabels],
        );
      }
      result.prUpdated = true;
      result.prNumber = existingPullRequest.number;
      result.pullRequest = pullRequestOutput(
        { ...outputPullRequest, title, body },
        Object.keys(candidate.files),
        [...this.config.labels, ...this.config.extraLabels],
      );
    } else {
      this.logger.info(`Release PR #${existingPullRequest.number} is already up to date.`);
      if (!this.config.skipLabeling) {
        await this.lifecycle.set(
          existingPullRequest,
          [...this.config.labels, ...this.config.extraLabels],
          [...this.config.labels, ...this.config.releaseLabels],
        );
      }
    }
  }

  private async createReleasePullRequest(
    targetBranch: string,
    targetHeadSha: string,
    branch: string,
    title: string,
    body: string,
    commitMessage: string,
    candidate: ReleaseCandidate,
    result: PrepareResult,
  ): Promise<void> {
    const existingBranch = await this.head.client.getBranch(branch);
    if (existingBranch) {
      const operations = await this.fileOperations(branch, candidate, this.head.client);
      if (operations.length > 0 || existingBranch.commit.message.trim() !== commitMessage) {
        throw new Error(
          `Branch ${branch} exists without a managed release PR and contains unexpected content. Delete or rename it before rerunning.`,
        );
      }
      this.logger.info(`Recovering generated release branch ${branch}.`);
      const rebuiltOperations = await this.fileOperations(targetBranch, candidate);
      if (rebuiltOperations.length === 0) {
        throw new Error(
          `Release files already match ${targetBranch}; no pull request diff can be created.`,
        );
      }
      try {
        if (this.head.fork) {
          await this.head.client.updateBranch(
            branch,
            targetHeadSha,
            existingBranch.commit.id,
          );
          await this.head.client.changeFiles({
            branch,
            message: commitMessage,
            files: rebuiltOperations,
          });
        } else {
          await this.client.changeFiles({
            branch: targetBranch,
            newBranch: branch,
            forcePush: true,
            message: commitMessage,
            files: rebuiltOperations,
          });
        }
      } catch (error) {
        if (error instanceof GiteaApiError && error.status === 403) {
          throw new Error(
            `Gitea rejected the force-push for recovered release branch ${branch}. Ensure it allows force pushes and the token has repository write permission.`,
            { cause: error },
          );
        }
        throw error;
      }
    } else {
      const operations = await this.fileOperations(targetBranch, candidate);
      if (operations.length === 0) {
        throw new Error('Release files already match the candidate; no pull request diff can be created.');
      }
      this.logger.info(`Creating release branch ${branch}.`);
      if (this.head.fork) {
        const target = await this.client.getBranch(targetBranch);
        if (!target) throw new Error(`Target branch ${targetBranch} disappeared.`);
        await this.head.client.createBranch(branch, target.commit.id);
        await this.head.client.changeFiles({ branch, message: commitMessage, files: operations });
      } else {
        await this.client.changeFiles({
          branch: targetBranch,
          newBranch: branch,
          message: commitMessage,
          files: operations,
        });
      }
    }

    const pullRequest = await this.client.createPullRequest({
      title,
      body,
      head: this.head.fork ? `${this.head.owner}:${branch}` : branch,
      base: targetBranch,
    });
    if (!this.config.skipLabeling) {
      await this.lifecycle.set(
        pullRequest,
        [...this.config.labels, ...this.config.extraLabels],
        [...this.config.labels, ...this.config.releaseLabels],
      );
    }
    this.logger.info(`Created release PR #${pullRequest.number}: ${pullRequest.html_url}`);
    result.prCreated = true;
    result.prNumber = pullRequest.number;
    result.pullRequest = pullRequestOutput(
      pullRequest,
      Object.keys(candidate.files),
      [...this.config.labels, ...this.config.extraLabels],
    );
  }

  private async fileOperations(
    ref: string,
    candidate: ReleaseCandidate,
    client: Pick<GiteaClient, 'getContent' | 'getTextContent'> = this.client,
  ): Promise<ChangeFileOperation[]> {
    const operations: ChangeFileOperation[] = [];

    for (const [path, desiredContent] of Object.entries(candidate.files)) {
      const metadata = await client.getContent(path, ref);
      if (!metadata) {
        operations.push({ operation: 'create', path, content: desiredContent });
        continue;
      }
      const currentContent = await client.getTextContent(path, ref);
      if (currentContent === desiredContent) continue;
      operations.push({
        operation: 'update',
        path,
        content: desiredContent,
        sha: metadata.sha,
      });
    }
    return operations;
  }

}
