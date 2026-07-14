import semver from 'semver';

import { parseChanges, requiredBump } from './conventional.js';
import { GiteaApiError, GiteaClient } from './gitea-client.js';
import { buildPullRequestBody, hashContent, parseMarker } from './marker.js';
import { generateReleaseMarkdown } from './markdown.js';
import type {
  ActionConfig,
  ActionResult,
  ChangeFileOperation,
  Logger,
  PullRequest,
  ReleaseCandidate,
  ReleaseMarker,
  RepositoryCommit,
  RepositoryLabel,
  RepositoryTag,
} from './types.js';

export type ReleaseApi = Pick<
  GiteaClient,
  | 'changeFiles'
  | 'createLabel'
  | 'createPullRequest'
  | 'createRelease'
  | 'createTag'
  | 'deleteBranch'
  | 'editPullRequest'
  | 'getBranch'
  | 'getContent'
  | 'getReleaseByTag'
  | 'getRepository'
  | 'getTag'
  | 'getTextContent'
  | 'listCommits'
  | 'listLabels'
  | 'listPullRequests'
  | 'listTags'
  | 'updatePullRequestBranch'
>;

const PENDING_LABEL = 'autorelease: pending';
const TAGGED_LABEL = 'autorelease: tagged';

interface CommitScan {
  commits: RepositoryCommit[];
  previousTag?: RepositoryTag;
  targetHeadSha: string;
}

function releaseBranchName(targetBranch: string): string {
  const safeTarget = targetBranch.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `gitea-release-please--branches--${safeTarget}`;
}

function versionFromTag(tagName: string, prefix: string): string | null {
  if (!tagName.startsWith(prefix)) return null;
  const candidate = tagName.slice(prefix.length);
  const parsed = semver.parse(candidate);
  if (!parsed || parsed.prerelease.length > 0 || parsed.build.length > 0) return null;
  return parsed.version;
}

function createMarker(
  config: ActionConfig,
  targetBranch: string,
  candidate: ReleaseCandidate,
): ReleaseMarker {
  return {
    schema: 1,
    version: candidate.version,
    tagName: candidate.tagName,
    targetBranch,
    changelogPath: config.changelogPath,
    releaseNotesPath: config.releaseNotesPath,
    fileHashes: {
      [config.changelogPath]: hashContent(candidate.changelog),
      [config.releaseNotesPath]: hashContent(candidate.releaseNotes),
    },
  };
}

export class ReleaseManager {
  private labels: RepositoryLabel[] | null = null;

  constructor(
    private readonly client: ReleaseApi,
    private readonly config: ActionConfig,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(): Promise<ActionResult> {
    const repository = await this.client.getRepository();
    const targetBranch = this.config.targetBranch ?? repository.default_branch;
    if (!targetBranch) throw new Error('The repository has no default branch.');

    const result: ActionResult = {
      prCreated: false,
      prUpdated: false,
      releaseCreated: false,
    };

    await this.finalizeMergedPullRequests(targetBranch, result);

    const scan = await this.scanCommits(targetBranch);
    const changes = parseChanges(scan.commits);
    const bump = requiredBump(changes);
    if (!bump) {
      this.logger.info('No releasable Conventional Commits were found.');
      return result;
    }

    const previousVersion = scan.previousTag
      ? versionFromTag(scan.previousTag.name, this.config.tagPrefix)
      : null;
    const version = previousVersion
      ? semver.inc(previousVersion, bump)
      : this.config.initialVersion;
    if (!version) throw new Error('Unable to calculate the next semantic version.');

    const tagName = `${this.config.tagPrefix}${version}`;
    const existingChangelog = await this.client.getTextContent(
      this.config.changelogPath,
      targetBranch,
    );
    const markdown = generateReleaseMarkdown({
      version,
      tagName,
      date: this.now().toISOString().slice(0, 10),
      changes,
      webUrl: this.config.webUrl,
      owner: this.config.owner,
      repo: this.config.repo,
      ...(existingChangelog === null ? {} : { existingChangelog }),
      ...(scan.previousTag ? { previousTag: scan.previousTag.name } : {}),
    });
    const candidate: ReleaseCandidate = {
      version,
      tagName,
      changes,
      changelog: markdown.changelog,
      releaseNotes: markdown.releaseNotes,
      ...(scan.previousTag ? { previousTag: scan.previousTag.name } : {}),
    };

    await this.syncReleasePullRequest(targetBranch, scan.targetHeadSha, candidate, result);
    return result;
  }

  private async scanCommits(targetBranch: string): Promise<CommitScan> {
    const [commits, tags] = await Promise.all([
      this.client.listCommits(targetBranch),
      this.client.listTags(),
    ]);
    const targetHead = commits[0];
    if (!targetHead) throw new Error(`Target branch ${targetBranch} has no commits.`);

    const tagsByCommit = new Map<string, RepositoryTag[]>();
    for (const tag of tags) {
      if (!versionFromTag(tag.name, this.config.tagPrefix)) continue;
      const existing = tagsByCommit.get(tag.commit.sha) ?? [];
      existing.push(tag);
      tagsByCommit.set(tag.commit.sha, existing);
    }

    const selectedCommits: RepositoryCommit[] = [];
    let previousTag: RepositoryTag | undefined;
    let foundBootstrap = !this.config.bootstrapSha;

    for (const commit of commits) {
      const matchingTags = tagsByCommit.get(commit.sha);
      if (matchingTags && matchingTags.length > 0) {
        previousTag = matchingTags.sort((left, right) => {
          const leftVersion = versionFromTag(left.name, this.config.tagPrefix) ?? '0.0.0';
          const rightVersion = versionFromTag(right.name, this.config.tagPrefix) ?? '0.0.0';
          return semver.rcompare(leftVersion, rightVersion);
        })[0];
        break;
      }

      if (this.config.bootstrapSha && commit.sha.startsWith(this.config.bootstrapSha)) {
        foundBootstrap = true;
        break;
      }
      selectedCommits.push(commit);
    }

    if (!foundBootstrap && !previousTag) {
      throw new Error(
        `bootstrap-sha ${this.config.bootstrapSha} was not found on ${targetBranch}.`,
      );
    }

    const scan: CommitScan = {
      commits: selectedCommits.reverse(),
      targetHeadSha: targetHead.sha,
    };
    if (previousTag) scan.previousTag = previousTag;
    return scan;
  }

  private async finalizeMergedPullRequests(
    targetBranch: string,
    result: ActionResult,
  ): Promise<void> {
    const [pullRequests, openPullRequests] = await Promise.all([
      this.client.listPullRequests('closed'),
      this.client.listPullRequests('open'),
    ]);
    const openHeads = new Set(openPullRequests.map((pullRequest) => pullRequest.head.ref));
    const pending = pullRequests
      .map((pullRequest) => ({ pullRequest, marker: parseMarker(pullRequest.body ?? '') }))
      .filter(
        (item): item is { pullRequest: PullRequest; marker: ReleaseMarker } =>
          item.marker !== null &&
          item.marker.targetBranch === targetBranch &&
          item.pullRequest.merged,
      );

    for (const { pullRequest, marker } of pending) {
      if (
        !semver.valid(marker.version) ||
        versionFromTag(marker.tagName, this.config.tagPrefix) !== marker.version
      ) {
        throw new Error(`Release PR #${pullRequest.number} has an invalid version marker.`);
      }
    }
    pending.sort((left, right) => semver.compare(left.marker.version, right.marker.version));

    for (const { pullRequest, marker } of pending) {
      const mergeSha = pullRequest.merge_commit_sha;
      if (!mergeSha) {
        throw new Error(`Merged release PR #${pullRequest.number} has no merge commit SHA.`);
      }

      const [existingTag, existingRelease] = await Promise.all([
        this.client.getTag(marker.tagName),
        this.client.getReleaseByTag(marker.tagName),
      ]);
      if (existingTag && existingTag.commit.sha !== mergeSha) {
        throw new Error(
          `Tag ${marker.tagName} points to ${existingTag.commit.sha}, not release PR #${pullRequest.number} merge ${mergeSha}.`,
        );
      }
      if (existingRelease) {
        await this.setLifecycleLabel(pullRequest, TAGGED_LABEL);
        continue;
      }

      const releaseNotes = await this.verifyMarkerFiles(marker, mergeSha, pullRequest.number);
      if (!existingTag) {
        this.logger.info(`Creating tag ${marker.tagName} at ${mergeSha}.`);
        await this.client.createTag(marker.tagName, mergeSha);
      }

      this.logger.info(`Creating Gitea Release ${marker.tagName}.`);
      const release = await this.client.createRelease({
        tagName: marker.tagName,
        target: mergeSha,
        body: releaseNotes,
      });
      await this.setLifecycleLabel(pullRequest, TAGGED_LABEL);

      result.releaseCreated = true;
      result.tagName = marker.tagName;
      result.version = marker.version;
      result.sha = mergeSha;
      result.releaseUrl = release.html_url;
      result.body = releaseNotes;
    }

    const latestMerged = pending.reduce<
      { pullRequest: PullRequest; marker: ReleaseMarker } | undefined
    >(
      (latest, current) =>
        !latest || current.pullRequest.number > latest.pullRequest.number ? current : latest,
      undefined,
    );
    if (latestMerged) {
      await this.cleanupReleaseBranch(
        latestMerged.pullRequest,
        latestMerged.marker,
        openHeads,
      );
    }
  }

  private async cleanupReleaseBranch(
    pullRequest: PullRequest,
    marker: ReleaseMarker,
    openHeads: Set<string>,
  ): Promise<void> {
    const expectedBranch = releaseBranchName(marker.targetBranch);
    if (pullRequest.head.ref !== expectedBranch || openHeads.has(expectedBranch)) return;
    if (!(await this.client.getBranch(expectedBranch))) return;
    this.logger.info(`Deleting merged release branch ${expectedBranch}.`);
    await this.client.deleteBranch(expectedBranch);
  }

  private async verifyMarkerFiles(
    marker: ReleaseMarker,
    ref: string,
    pullRequestNumber: number,
  ): Promise<string> {
    let releaseNotes: string | null = null;
    for (const [path, expectedHash] of Object.entries(marker.fileHashes)) {
      const content = await this.client.getTextContent(path, ref);
      if (content === null || hashContent(content) !== expectedHash) {
        throw new Error(
          `Generated file ${path} in release PR #${pullRequestNumber} was changed outside this action. Close the PR or restore the generated content before releasing.`,
        );
      }
      if (path === marker.releaseNotesPath) releaseNotes = content;
    }
    if (releaseNotes === null) {
      throw new Error(
        `Release PR #${pullRequestNumber} marker does not contain ${marker.releaseNotesPath}.`,
      );
    }
    return releaseNotes;
  }

  private async syncReleasePullRequest(
    targetBranch: string,
    targetHeadSha: string,
    candidate: ReleaseCandidate,
    result: ActionResult,
  ): Promise<void> {
    const pullRequests = await this.client.listPullRequests('open');
    const releasePullRequests = pullRequests.filter((pullRequest) => {
      const marker = parseMarker(pullRequest.body ?? '');
      return marker?.targetBranch === targetBranch;
    });
    if (releasePullRequests.length > 1) {
      throw new Error(
        `Found multiple open release pull requests for ${targetBranch}: ${releasePullRequests
          .map((pullRequest) => `#${pullRequest.number}`)
          .join(', ')}.`,
      );
    }

    const branch = releaseBranchName(targetBranch);
    const title = `chore(${targetBranch}): release ${candidate.tagName}`;
    const commitMessage = title;
    const marker = createMarker(this.config, targetBranch, candidate);
    const body = buildPullRequestBody(marker, candidate.releaseNotes);
    const existingPullRequest = releasePullRequests[0];

    if (!existingPullRequest) {
      await this.createReleasePullRequest(
        targetBranch,
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
      previousMarker.changelogPath !== this.config.changelogPath ||
      previousMarker.releaseNotesPath !== this.config.releaseNotesPath
    ) {
      throw new Error(
        `Release file paths changed while PR #${existingPullRequest.number} is open. Close it before changing action paths.`,
      );
    }

    await this.verifyMarkerFiles(previousMarker, branch, existingPullRequest.number);
    if (existingPullRequest.merge_base && existingPullRequest.merge_base !== targetHeadSha) {
      this.logger.info(`Synchronizing release PR #${existingPullRequest.number} with ${targetBranch}.`);
      try {
        await this.client.updatePullRequestBranch(existingPullRequest.number);
      } catch (error) {
        if (error instanceof GiteaApiError && error.status === 409) {
          throw new Error(
            `Release PR #${existingPullRequest.number} conflicts with ${targetBranch}; resolve or close it before rerunning.`,
            { cause: error },
          );
        }
        throw error;
      }
    }

    const operations = await this.fileOperations(branch, candidate);
    if (operations.length > 0) {
      this.logger.info(`Updating release PR #${existingPullRequest.number}.`);
      await this.client.changeFiles({
        branch,
        message: commitMessage,
        files: operations,
      });
    }

    const metadataChanged =
      existingPullRequest.title !== title || existingPullRequest.body !== body;
    if (metadataChanged) {
      await this.client.editPullRequest(existingPullRequest.number, { title, body });
    }
    if (operations.length > 0 || metadataChanged) {
      await this.setLifecycleLabel(existingPullRequest, PENDING_LABEL);
      result.prUpdated = true;
      result.prNumber = existingPullRequest.number;
    } else {
      this.logger.info(`Release PR #${existingPullRequest.number} is already up to date.`);
    }
  }

  private async createReleasePullRequest(
    targetBranch: string,
    branch: string,
    title: string,
    body: string,
    commitMessage: string,
    candidate: ReleaseCandidate,
    result: ActionResult,
  ): Promise<void> {
    const existingBranch = await this.client.getBranch(branch);
    if (existingBranch) {
      const operations = await this.fileOperations(branch, candidate);
      if (operations.length > 0 || existingBranch.commit.message.trim() !== commitMessage) {
        throw new Error(
          `Branch ${branch} exists without a managed release PR and contains unexpected content. Delete or rename it before rerunning.`,
        );
      }
      this.logger.info(`Recovering generated release branch ${branch}.`);
    } else {
      const operations = await this.fileOperations(targetBranch, candidate);
      if (operations.length === 0) {
        throw new Error('Release files already match the candidate; no pull request diff can be created.');
      }
      this.logger.info(`Creating release branch ${branch}.`);
      await this.client.changeFiles({
        branch: targetBranch,
        newBranch: branch,
        message: commitMessage,
        files: operations,
      });
    }

    const pullRequest = await this.client.createPullRequest({
      title,
      body,
      head: branch,
      base: targetBranch,
    });
    await this.setLifecycleLabel(pullRequest, PENDING_LABEL);
    this.logger.info(`Created release PR #${pullRequest.number}: ${pullRequest.html_url}`);
    result.prCreated = true;
    result.prNumber = pullRequest.number;
  }

  private async fileOperations(
    ref: string,
    candidate: ReleaseCandidate,
  ): Promise<ChangeFileOperation[]> {
    const desiredFiles: Array<[string, string]> = [
      [this.config.changelogPath, candidate.changelog],
      [this.config.releaseNotesPath, candidate.releaseNotes],
    ];
    const operations: ChangeFileOperation[] = [];

    for (const [path, desiredContent] of desiredFiles) {
      const metadata = await this.client.getContent(path, ref);
      if (!metadata) {
        operations.push({ operation: 'create', path, content: desiredContent });
        continue;
      }
      const currentContent = await this.client.getTextContent(path, ref);
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

  private async setLifecycleLabel(
    pullRequest: PullRequest,
    lifecycle: typeof PENDING_LABEL | typeof TAGGED_LABEL,
  ): Promise<void> {
    try {
      const pending = await this.ensureLabel(PENDING_LABEL, 'fbca04');
      const tagged = await this.ensureLabel(TAGGED_LABEL, '0e8a16');
      const managedIds = new Set([pending.id, tagged.id]);
      const preservedIds = (pullRequest.labels ?? [])
        .map((label) => label.id)
        .filter((id) => !managedIds.has(id));
      const lifecycleId = lifecycle === PENDING_LABEL ? pending.id : tagged.id;
      await this.client.editPullRequest(pullRequest.number, {
        labels: [...preservedIds, lifecycleId],
      });
    } catch (error) {
      this.logger.warning(
        `Unable to update lifecycle labels for PR #${pullRequest.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async ensureLabel(name: string, color: string): Promise<RepositoryLabel> {
    this.labels ??= await this.client.listLabels();
    const existing = this.labels.find((label) => label.name === name);
    if (existing) return existing;

    try {
      const created = await this.client.createLabel(name, color);
      this.labels.push(created);
      return created;
    } catch (error) {
      if (!(error instanceof GiteaApiError) || error.status !== 409) throw error;
      this.labels = await this.client.listLabels();
      const raced = this.labels.find((label) => label.name === name);
      if (!raced) throw error;
      return raced;
    }
  }
}
