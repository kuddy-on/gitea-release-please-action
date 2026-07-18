import semver from 'semver';

import { GiteaClient } from './gitea-client.js';
import { packageVersion, parseManifest } from './manifest.js';
import { parseMarker } from './marker.js';
import type { ReleaseHead } from './release-head.js';
import { addPath, ROOT_PROJECT_PATH } from './repository-path.js';
import { LifecycleLabels, releaseBranchName, verifyReleaseState } from './release-state.js';
import type { ActionConfig, Logger, PublishResult, PullRequest } from './types.js';

export type PublishApi = Pick<
  GiteaClient,
  | 'createLabel'
  | 'createRelease'
  | 'createTag'
  | 'deleteBranch'
  | 'editPullRequest'
  | 'getBranch'
  | 'getContent'
  | 'getReleaseByTag'
  | 'getTag'
  | 'getTextContent'
  | 'listLabels'
  | 'listPullRequestFiles'
  | 'listPullRequests'
>;

interface ManagedRelease {
  pullRequest: PullRequest;
  marker: NonNullable<ReturnType<typeof parseMarker>>;
}

export class PublishManager {
  private readonly lifecycle: LifecycleLabels;

  constructor(
    private readonly client: PublishApi,
    private readonly config: ActionConfig,
    private readonly logger: Logger,
    private readonly head: Pick<ReleaseHead, 'client' | 'fullName'> = {
      client: client as GiteaClient,
      fullName: `${config.owner}/${config.repo}`,
    },
  ) {
    this.lifecycle = new LifecycleLabels(client, logger);
  }

  async run(): Promise<PublishResult | null> {
    const managed = await this.findPendingRelease();
    if (!managed) return null;

    const { pullRequest, marker } = managed;
    const expectedBranch = releaseBranchName(marker.targetBranch);
    const repository = this.head.fullName;
    if (pullRequest.base.ref !== marker.targetBranch) {
      throw new Error(
        `PR #${pullRequest.number} targets ${pullRequest.base.ref}, not marker target ${marker.targetBranch}.`,
      );
    }
    if ((marker.path ?? ROOT_PROJECT_PATH) !== this.config.path) {
      throw new Error(
        `Release PR #${pullRequest.number} manages path ${marker.path ?? ROOT_PROJECT_PATH}, not configured path ${this.config.path}.`,
      );
    }
    if (pullRequest.head.repo?.full_name !== repository) {
      throw new Error(`Release PR #${pullRequest.number} must originate from ${repository}.`);
    }
    if (
      !semver.valid(marker.version) ||
      marker.tagName !== `${this.config.tagPrefix}${marker.version}`
    ) {
      throw new Error(`Release PR #${pullRequest.number} has an invalid version marker.`);
    }

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
    if (pullRequest.head.ref !== expectedBranch) {
      const archivedHead = `refs/pull/${pullRequest.number}/head`;
      if (pullRequest.head.ref !== archivedHead || !existingTag) {
        throw new Error(
          `PR #${pullRequest.number} does not use managed release branch ${expectedBranch}; found ${pullRequest.head.ref || '<deleted>'}.`,
        );
      }
      this.logger.info(
        `Release PR #${pullRequest.number} source branch was already deleted; repairing or verifying its Release from the existing tag.`,
      );
    }

    const expectedChangelogPath = this.config.skipChangelog
      ? undefined
      : addPath(this.config.path, this.config.changelogPath);
    const expectedManifestPath = this.config.manifestFile;
    const validManifestMarker = marker.schema === 1
      ? marker.manifestPath === undefined || marker.manifestPath === expectedManifestPath
      : marker.manifestPath === expectedManifestPath &&
        marker.fileHashes[expectedManifestPath] !== undefined;
    if (
      marker.changelogPath !== expectedChangelogPath ||
      !validManifestMarker
    ) {
      throw new Error(
        `Release PR #${pullRequest.number} marker does not match the configured release files.`,
      );
    }
    const releaseNotes = await verifyReleaseState(
      this.client,
      marker,
      mergeSha,
      pullRequest.number,
      pullRequest.body ?? '',
    );
    const manifestContent = await this.client.getTextContent(
      expectedManifestPath,
      mergeSha,
    );
    if (manifestContent === null) {
      throw new Error(
        `Release PR #${pullRequest.number} does not contain ${expectedManifestPath}.`,
      );
    }
    const manifest = parseManifest(manifestContent, expectedManifestPath);
    const releasedVersion = packageVersion(
      manifest,
      this.config.path,
      expectedManifestPath,
    );
    if (releasedVersion !== marker.version) {
      throw new Error(
        `Release PR #${pullRequest.number} ${expectedManifestPath} records ${releasedVersion ?? '<missing>'}, not ${marker.version}.`,
      );
    }
    const markerFiles = new Set(Object.keys(marker.fileHashes));
    const changedFiles = await this.client.listPullRequestFiles(pullRequest.number);
    const reportedUnhashed = changedFiles
      .map((file) => file.filename)
      .filter((path) => !markerFiles.has(path));
    const targetHeadSha = marker.targetHeadSha;
    const unhashed = targetHeadSha
      ? (
          await Promise.all(
            reportedUnhashed.map(async (path) => {
              const [targetContent, releaseContent] = await Promise.all([
                this.client.getContent(path, targetHeadSha),
                this.client.getContent(path, mergeSha),
              ]);
              return targetContent?.sha === releaseContent?.sha ? null : path;
            }),
          )
        ).filter((path): path is string => path !== null)
      : reportedUnhashed;
    const staleEntries = reportedUnhashed.filter((path) => !unhashed.includes(path));
    if (staleEntries.length > 0) {
      this.logger.warning(
        `Ignoring stale Gitea PR file entries unchanged from release base: ${staleEntries.join(', ')}.`,
      );
    }
    if (unhashed.length > 0) {
      throw new Error(
        `Release PR #${pullRequest.number} changes files absent from its marker: ${unhashed.join(', ')}.`,
      );
    }
    if (!existingTag) {
      this.logger.info(`Creating tag ${marker.tagName} at ${mergeSha}.`);
      await this.client.createTag(marker.tagName, mergeSha);
    }

    let release = existingRelease;
    let releaseCreated = false;
    if (!release) {
      this.logger.info(`Creating Gitea Release ${marker.tagName}.`);
      release = await this.client.createRelease({
        tagName: marker.tagName,
        target: mergeSha,
        name: `${this.config.includeVInReleaseName ? 'v' : ''}${marker.version}`,
        body: releaseNotes,
        draft: this.config.draft,
        prerelease: this.config.prerelease,
      });
      releaseCreated = true;
    }

    if (!this.config.skipLabeling) {
      await this.lifecycle.set(
        pullRequest,
        this.config.releaseLabels,
        [...this.config.labels, ...this.config.releaseLabels],
      );
    }
    await this.cleanupBranch(expectedBranch);
    return {
      releaseCreated,
      releaseId: release.id,
      releaseName: release.name,
      draft: release.draft ?? this.config.draft,
      tagName: marker.tagName,
      version: marker.version,
      sha: mergeSha,
      releaseUrl: release.html_url,
      uploadUrl: release.upload_url ?? '',
      body: releaseNotes,
      prNumber: pullRequest.number,
      path: this.config.path,
    };
  }

  private async findPendingRelease(): Promise<ManagedRelease | null> {
    const targetBranch = this.config.targetBranch;
    if (!targetBranch) throw new Error('Internal error: target branch was not resolved.');
    const pullRequests = await this.client.listPullRequests('closed');
    const candidates = pullRequests
      .filter((pullRequest) => pullRequest.merged && pullRequest.base.ref === targetBranch)
      .sort((left, right) => (right.merged_at ?? '').localeCompare(left.merged_at ?? ''))
      .flatMap((pullRequest) => {
        const marker = parseMarker(pullRequest.body ?? '');
        if (
          !marker ||
          marker.targetBranch !== targetBranch ||
          (marker.path ?? ROOT_PROJECT_PATH) !== this.config.path
        ) {
          return [];
        }
        if (!this.config.skipLabeling) {
          const labels = new Set((pullRequest.labels ?? []).map((label) => label.name));
          const pending = this.config.labels.every((label) => labels.has(label));
          const tagged = this.config.releaseLabels.every((label) => labels.has(label));
          if (!pending && !tagged) return [];
        }
        return [{ pullRequest, marker }];
      });

    for (const candidate of candidates) {
      const release = await this.client.getReleaseByTag(candidate.marker.tagName);
      const tag = await this.client.getTag(candidate.marker.tagName);
      const names = new Set(
        (candidate.pullRequest.labels ?? []).map((label) => label.name),
      );
      const pending = this.config.labels.every((label) => names.has(label));
      if (!tag || !release || (!this.config.skipLabeling && pending)) return candidate;
    }
    return null;
  }

  private async cleanupBranch(branch: string): Promise<void> {
    const openPullRequests = await this.client.listPullRequests('open');
    if (openPullRequests.some((pullRequest) => pullRequest.head.ref === branch)) return;
    if (!(await this.head.client.getBranch(branch))) return;
    this.logger.info(`Deleting merged release branch ${branch}.`);
    await this.head.client.deleteBranch(branch);
  }
}
