import { describe, expect, it } from 'vitest';

import { hashContent, parseMarker } from '../src/marker.js';
import { ReleaseManager, type ReleaseApi } from '../src/release-manager.js';
import type {
  ActionConfig,
  Logger,
  PullRequest,
  RepositoryBranch,
  RepositoryCommit,
  RepositoryContent,
  RepositoryLabel,
  RepositoryRelease,
  RepositoryTag,
} from '../src/types.js';

const config: ActionConfig = {
  token: 'secret',
  apiUrl: 'https://gitea.example/api/v1',
  webUrl: 'https://gitea.example',
  owner: 'acme',
  repo: 'demo',
  targetBranch: 'main',
  initialVersion: '0.1.0',
  tagPrefix: 'v',
  changelogPath: 'CHANGELOG.md',
  releaseNotesPath: 'RELEASE.md',
};

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warning: () => undefined,
};

function commit(sha: string, message: string): RepositoryCommit {
  return {
    sha,
    html_url: `https://gitea.example/acme/demo/commit/${sha}`,
    commit: { message },
    parents: [],
  };
}

interface StoredFile {
  content: string;
  sha: string;
}

class FakeApi implements ReleaseApi {
  commits: RepositoryCommit[] = [commit('1111111111111111', 'feat: initial feature')];
  tags: RepositoryTag[] = [];
  pullRequests: PullRequest[] = [];
  releases: RepositoryRelease[] = [];
  labels: RepositoryLabel[] = [
    { id: 1, name: 'autorelease: pending', color: 'fbca04' },
    { id: 2, name: 'autorelease: tagged', color: '0e8a16' },
  ];
  branches = new Map<string, RepositoryBranch>([
    [
      'main',
      { name: 'main', commit: { id: '1111111111111111', message: 'feat: initial feature' } },
    ],
  ]);
  files = new Map<string, Map<string, StoredFile>>([['main', new Map()]]);
  lastChangeFiles: Parameters<ReleaseApi['changeFiles']>[0] | null = null;

  async getRepository() {
    return { default_branch: 'main', html_url: 'https://gitea.example/acme/demo' };
  }

  async listCommits() {
    return this.commits;
  }

  async listTags() {
    return this.tags;
  }

  async getTag(tagName: string) {
    return this.tags.find((tag) => tag.name === tagName) ?? null;
  }

  async createTag(tagName: string, target: string) {
    const tag = { name: tagName, commit: { sha: target } };
    this.tags.push(tag);
    return tag;
  }

  async listPullRequests(state: 'open' | 'closed') {
    return this.pullRequests.filter((pullRequest) => pullRequest.state === state);
  }

  async createPullRequest(options: Parameters<ReleaseApi['createPullRequest']>[0]) {
    const targetHead = this.commits[0];
    if (!targetHead) throw new Error('Missing target head');
    const pullRequest: PullRequest = {
      number: this.pullRequests.length + 1,
      title: options.title,
      body: options.body,
      state: 'open',
      html_url: `https://gitea.example/acme/demo/pulls/${this.pullRequests.length + 1}`,
      merged: false,
      merge_base: targetHead.sha,
      head: { ref: options.head, sha: this.branches.get(options.head)?.commit.id ?? '' },
      base: { ref: options.base, sha: targetHead.sha },
      labels: [],
    };
    this.pullRequests.push(pullRequest);
    return pullRequest;
  }

  async editPullRequest(
    number: number,
    options: Parameters<ReleaseApi['editPullRequest']>[1],
  ) {
    const pullRequest = this.pullRequests.find((candidate) => candidate.number === number);
    if (!pullRequest) throw new Error(`Unknown pull request ${number}`);
    if (options.title !== undefined) pullRequest.title = options.title;
    if (options.body !== undefined) pullRequest.body = options.body;
    if (options.labels !== undefined) {
      pullRequest.labels = options.labels
        .map((id) => this.labels.find((label) => label.id === id))
        .filter((label): label is RepositoryLabel => label !== undefined);
    }
    return pullRequest;
  }

  async updatePullRequestBranch(number: number) {
    const pullRequest = this.pullRequests.find((candidate) => candidate.number === number);
    if (!pullRequest) throw new Error(`Unknown pull request ${number}`);
    const targetHead = this.commits[0];
    if (!targetHead) throw new Error('Missing target head');
    pullRequest.merge_base = targetHead.sha;
  }

  async getBranch(branch: string) {
    return this.branches.get(branch) ?? null;
  }

  async deleteBranch(branch: string) {
    this.branches.delete(branch);
    this.files.delete(branch);
  }

  async getContent(path: string, ref: string): Promise<RepositoryContent | null> {
    const stored = this.files.get(ref)?.get(path);
    if (!stored) return null;
    return {
      path,
      sha: stored.sha,
      encoding: 'base64',
      content: Buffer.from(stored.content).toString('base64'),
    };
  }

  async getTextContent(path: string, ref: string) {
    return this.files.get(ref)?.get(path)?.content ?? null;
  }

  async changeFiles(options: Parameters<ReleaseApi['changeFiles']>[0]) {
    this.lastChangeFiles = options;
    const destination = options.newBranch ?? options.branch;
    if (options.newBranch) {
      const source = this.files.get(options.branch) ?? new Map();
      this.files.set(destination, new Map([...source].map(([path, file]) => [path, { ...file }])));
    }
    const destinationFiles = this.files.get(destination) ?? new Map<string, StoredFile>();
    for (const operation of options.files) {
      if (operation.operation === 'delete') {
        destinationFiles.delete(operation.path);
      } else if (operation.content !== undefined) {
        destinationFiles.set(operation.path, {
          content: operation.content,
          sha: hashContent(operation.content).slice(0, 40),
        });
      }
    }
    this.files.set(destination, destinationFiles);
    const sha = hashContent(`${options.message}-${destinationFiles.size}`).slice(0, 40);
    this.branches.set(destination, {
      name: destination,
      commit: { id: sha, message: options.message },
    });
    return sha;
  }

  async getReleaseByTag(tagName: string) {
    return this.releases.find((release) => release.tag_name === tagName) ?? null;
  }

  async createRelease(options: Parameters<ReleaseApi['createRelease']>[0]) {
    const release: RepositoryRelease = {
      id: this.releases.length + 1,
      tag_name: options.tagName,
      name: options.tagName,
      body: options.body,
      html_url: `https://gitea.example/acme/demo/releases/tag/${options.tagName}`,
    };
    this.releases.push(release);
    return release;
  }

  async listLabels() {
    return this.labels;
  }

  async createLabel(name: string, color: string) {
    const label = { id: this.labels.length + 1, name, color };
    this.labels.push(label);
    return label;
  }

  simulateMerge(number = 1, mergeSha = '9999999999999999'): void {
    const pullRequest = this.pullRequests.find((candidate) => candidate.number === number);
    if (!pullRequest) throw new Error(`Unknown pull request ${number}`);
    const branchFiles = this.files.get(pullRequest.head.ref) ?? new Map();
    const mergedFiles = new Map([...branchFiles].map(([path, file]) => [path, { ...file }]));
    this.files.set(mergeSha, mergedFiles);
    this.files.set('main', new Map([...mergedFiles].map(([path, file]) => [path, { ...file }])));
    pullRequest.state = 'closed';
    pullRequest.merged = true;
    pullRequest.merge_commit_sha = mergeSha;
    this.commits = [commit(mergeSha, pullRequest.title), ...this.commits];
    this.branches.set('main', {
      name: 'main',
      commit: { id: mergeSha, message: pullRequest.title },
    });
  }
}

function manager(api: FakeApi, overrides: Partial<ActionConfig> = {}): ReleaseManager {
  return new ReleaseManager(
    api,
    { ...config, ...overrides },
    logger,
    () => new Date('2026-07-14T00:00:00Z'),
  );
}

describe('ReleaseManager', () => {
  it('creates one release PR and atomically writes both release files', async () => {
    const api = new FakeApi();
    const result = await manager(api).run();

    expect(result).toMatchObject({ prCreated: true, prUpdated: false, prNumber: 1 });
    expect(api.lastChangeFiles).toMatchObject({
      branch: 'main',
      newBranch: 'gitea-release-please--branches--main',
      message: 'chore(main): release v0.1.0',
    });
    expect(api.lastChangeFiles?.files).toHaveLength(2);
    const pullRequest = api.pullRequests[0];
    expect(pullRequest?.title).toBe('chore(main): release v0.1.0');
    expect(parseMarker(pullRequest?.body ?? '')).toMatchObject({
      version: '0.1.0',
      targetBranch: 'main',
    });
  });

  it('updates the same PR when another releasable commit reaches main', async () => {
    const api = new FakeApi();
    await manager(api).run();
    api.commits.unshift(commit('2222222222222222', 'fix: second change'));

    const result = await manager(api).run();

    expect(result).toMatchObject({ prCreated: false, prUpdated: true, prNumber: 1 });
    expect(api.pullRequests).toHaveLength(1);
    const notes = await api.getTextContent(
      'RELEASE.md',
      'gitea-release-please--branches--main',
    );
    expect(notes).toContain('initial feature');
    expect(notes).toContain('second change');
  });

  it('refuses to overwrite generated files changed outside the action', async () => {
    const api = new FakeApi();
    await manager(api).run();
    const releaseFiles = api.files.get('gitea-release-please--branches--main');
    releaseFiles?.set('RELEASE.md', { content: 'manually edited', sha: 'manual' });

    await expect(manager(api).run()).rejects.toThrow('was changed outside this action');
  });

  it('creates the tag and release after merge, then becomes a no-op', async () => {
    const api = new FakeApi();
    await manager(api).run();
    const expectedBody = await api.getTextContent(
      'RELEASE.md',
      'gitea-release-please--branches--main',
    );
    api.simulateMerge();

    const released = await manager(api).run();
    expect(released).toMatchObject({
      releaseCreated: true,
      tagName: 'v0.1.0',
      version: '0.1.0',
      sha: '9999999999999999',
    });
    expect(api.tags[0]).toEqual({
      name: 'v0.1.0',
      commit: { sha: '9999999999999999' },
    });
    expect(api.releases[0]?.body).toBe(expectedBody);
    expect(api.branches.has('gitea-release-please--branches--main')).toBe(false);

    const rerun = await manager(api).run();
    expect(rerun.releaseCreated).toBe(false);
    expect(api.tags).toHaveLength(1);
    expect(api.releases).toHaveLength(1);
  });

  it('increments from the latest reachable tag after the first release', async () => {
    const api = new FakeApi();
    api.commits = [
      commit('2222222222222222', 'feat: second feature'),
      commit('1111111111111111', 'chore(main): release v0.1.0'),
    ];
    api.tags = [{ name: 'v0.1.0', commit: { sha: '1111111111111111' } }];
    api.files.get('main')?.set('CHANGELOG.md', {
      content: '# Changelog\n\n## 0.1.0\n\nInitial release\n',
      sha: 'old-changelog',
    });

    await manager(api).run();
    expect(api.pullRequests[0]?.title).toBe('chore(main): release v0.2.0');
  });

  it('creates tags and releases without a prefix', async () => {
    const api = new FakeApi();
    const unprefixed = { tagPrefix: '' };

    await manager(api, unprefixed).run();
    expect(api.pullRequests[0]?.title).toBe('chore(main): release 0.1.0');
    expect(parseMarker(api.pullRequests[0]?.body ?? '')).toMatchObject({
      version: '0.1.0',
      tagName: '0.1.0',
    });

    api.simulateMerge();
    const released = await manager(api, unprefixed).run();

    expect(released).toMatchObject({ releaseCreated: true, tagName: '0.1.0' });
    expect(api.tags[0]?.name).toBe('0.1.0');
    expect(api.releases[0]?.tag_name).toBe('0.1.0');
  });

  it('increments from the latest reachable tag without a prefix', async () => {
    const api = new FakeApi();
    api.commits = [
      commit('2222222222222222', 'feat: second feature'),
      commit('1111111111111111', 'chore(main): release 0.1.0'),
    ];
    api.tags = [{ name: '0.1.0', commit: { sha: '1111111111111111' } }];

    await manager(api, { tagPrefix: '' }).run();

    expect(api.pullRequests[0]?.title).toBe('chore(main): release 0.2.0');
  });

  it('fails instead of moving a conflicting existing tag', async () => {
    const api = new FakeApi();
    await manager(api).run();
    api.simulateMerge();
    api.tags.push({ name: 'v0.1.0', commit: { sha: 'different-sha' } });

    await expect(manager(api).run()).rejects.toThrow('points to different-sha');
  });

  it('creates a missing release without recreating an existing matching tag', async () => {
    const api = new FakeApi();
    await manager(api).run();
    api.simulateMerge();
    api.tags.push({
      name: 'v0.1.0',
      commit: { sha: '9999999999999999' },
    });

    const result = await manager(api).run();

    expect(result.releaseCreated).toBe(true);
    expect(api.tags).toHaveLength(1);
    expect(api.releases).toHaveLength(1);
  });
});
