import { GiteaApiError, GiteaClient } from './gitea-client.js';
import {
  extractReleaseNotesFromPullRequestBody,
  hashContent,
} from './marker.js';
import { extractReleaseNotesFromChangelog } from './markdown.js';
import type {
  Logger,
  PullRequest,
  ReleaseMarker,
  RepositoryLabel,
} from './types.js';

export const PENDING_LABEL = 'autorelease: pending';
export const TAGGED_LABEL = 'autorelease: tagged';

export type LifecycleApi = Pick<
  GiteaClient,
  'createLabel' | 'editPullRequest' | 'listLabels'
>;

export function releaseBranchName(targetBranch: string): string {
  const safeTarget = targetBranch.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `release-please--branches--${safeTarget}`;
}

export async function verifyReleaseState(
  client: Pick<GiteaClient, 'getTextContent'>,
  marker: ReleaseMarker,
  ref: string,
  pullRequestNumber: number,
  pullRequestBody: string,
): Promise<string> {
  const contents = new Map<string, string>();
  for (const [path, expectedHash] of Object.entries(marker.fileHashes)) {
    const content = await client.getTextContent(path, ref);
    if (content === null || hashContent(content) !== expectedHash) {
      throw new Error(
        `Generated file ${path} in release PR #${pullRequestNumber} does not match its release marker.`,
      );
    }
    contents.set(path, content);
  }

  if (marker.schema === 1 || marker.schema === 2) {
    const releaseNotes = marker.releaseNotesPath
      ? contents.get(marker.releaseNotesPath)
      : undefined;
    if (releaseNotes !== undefined) return releaseNotes;
    throw new Error(
      `Release PR #${pullRequestNumber} marker does not contain its legacy release notes file.`,
    );
  }

  const releaseNotes = marker.changelogPath
    ? extractReleaseNotesFromChangelog(
        contents.get(marker.changelogPath) ?? '',
        marker.version,
      )
    : extractReleaseNotesFromPullRequestBody(pullRequestBody);
  if (releaseNotes === null) {
    throw new Error(
      marker.changelogPath
        ? `Release PR #${pullRequestNumber} changelog does not contain version ${marker.version}.`
        : `Release PR #${pullRequestNumber} body does not contain release notes.`,
    );
  }
  if (hashContent(releaseNotes) !== marker.releaseNotesHash) {
    throw new Error(
      `Release notes in release PR #${pullRequestNumber} do not match its release marker.`,
    );
  }
  return releaseNotes;
}

export class LifecycleLabels {
  private labels: RepositoryLabel[] | null = null;

  constructor(
    private readonly client: LifecycleApi,
    private readonly logger: Logger,
  ) {}

  async set(
    pullRequest: PullRequest,
    desiredNames: string[],
    managedNames: string[],
  ): Promise<void> {
    try {
      const desired = await Promise.all(
        desiredNames.map((name) => this.ensure(name, this.color(name))),
      );
      const managed = await Promise.all(
        managedNames.map((name) => this.ensure(name, this.color(name))),
      );
      const managedIds = new Set(managed.map((label) => label.id));
      const preservedIds = (pullRequest.labels ?? [])
        .map((label) => label.id)
        .filter((id) => !managedIds.has(id));
      await this.client.editPullRequest(pullRequest.number, {
        labels: [...new Set([...preservedIds, ...desired.map((label) => label.id)])],
      });
    } catch (error) {
      this.logger.warning(
        `Unable to update lifecycle labels for PR #${pullRequest.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private color(name: string): string {
    if (name === PENDING_LABEL) return 'fbca04';
    if (name === TAGGED_LABEL) return '0e8a16';
    return 'ededed';
  }

  private async ensure(name: string, color: string): Promise<RepositoryLabel> {
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
