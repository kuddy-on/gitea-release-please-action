import { describe, expect, it } from 'vitest';

import { GiteaApiError } from '../src/gitea-client.js';
import { hashContent, parseMarker } from '../src/marker.js';
import type { ReleaseHead } from '../src/release-head.js';
import { ReleaseManager, type ReleaseApi } from '../src/release-manager.js';
import type {
  ActionConfig,
  Logger,
  PullRequest,
  RepositoryBranch,
  RepositoryCommit,
  RepositoryContent,
  RepositoryLabel,
  RepositoryTag,
} from '../src/types.js';

const config: ActionConfig = {
  token: 'secret',
  apiUrl: 'https://gitea.example/api/v1',
  webUrl: 'https://gitea.example',
  fork: false,
  owner: 'acme',
  repo: 'demo',
  manifestFile: '.release-please-manifest.json',
  targetBranch: 'main',
  path: '.',
  releaseType: 'simple',
  initialVersion: '0.1.0',
  tagPrefix: 'v',
  includeVInReleaseName: true,
  changelogPath: 'CHANGELOG.md',
  changelogHost: 'https://gitea.example',
  releaseNotesPath: 'RELEASE.md',
  extraFiles: [],
  excludePaths: [],
  versioningStrategy: 'default',
  bumpMinorPreMajor: false,
  bumpPatchForMinorPreMajor: false,
  draft: false,
  prerelease: false,
  draftPullRequest: false,
  skipGiteaRelease: false,
  skipGiteaPullRequest: false,
  skipLabeling: false,
  skipChangelog: false,
  labels: ['autorelease: pending'],
  releaseLabels: ['autorelease: tagged'],
  extraLabels: [],
  pullRequestTitlePattern: 'chore${scope}: release${component} ${version}',
  pullRequestHeader: ':robot: I have created a release *beep* *boop*',
  pullRequestFooter:
    'This PR was generated with [Gitea Release Please](https://github.com/kuddy-on/gitea-release-please-action).',
  changelogSections: [
    { type: 'feat', section: 'Features' },
    { type: 'fix', section: 'Bug Fixes' },
  ],
  includeCommitAuthors: false,
  dateFormat: '%Y-%m-%d',
  alwaysUpdate: false,
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
  files = new Map<string, Map<string, StoredFile>>([
    [
      'main',
      new Map([
        [
          '.release-please-manifest.json',
          { content: '{}\n', sha: 'release-manifest' },
        ],
      ]),
    ],
  ]);
  branchParents = new Map<string, string>();
  changeFilesCalls: Array<Parameters<ReleaseApi['changeFiles']>[0]> = [];
  lastChangeFiles: Parameters<ReleaseApi['changeFiles']>[0] | null = null;
  rejectForcePush = false;
  pullRequestHeadFullName = 'acme/demo';
  updatedBranches: Array<{ branch: string; newCommitId: string; oldCommitId?: string }> = [];
  updatedPullRequestBranches: number[] = [];
  private changeCounter = 0;

  async getRepository() {
    return { default_branch: 'main', html_url: 'https://gitea.example/acme/demo' };
  }

  async listCommits() {
    return this.commits;
  }

  async listTags() {
    return this.tags;
  }

  async listPullRequests(state: 'open' | 'closed') {
    return this.pullRequests.filter((pullRequest) => pullRequest.state === state);
  }

  async updatePullRequestBranch(number: number) {
    this.updatedPullRequestBranches.push(number);
  }

  async listFiles() {
    return [...(this.files.get('main')?.keys() ?? [])];
  }

  async createPullRequest(options: Parameters<ReleaseApi['createPullRequest']>[0]) {
    const targetHead = this.commits[0];
    if (!targetHead) throw new Error('Missing target head');
    const headRef = options.head.includes(':')
      ? (options.head.split(':', 2)[1] ?? options.head)
      : options.head;
    const pullRequest: PullRequest = {
      number: this.pullRequests.length + 1,
      title: options.title,
      body: options.body,
      state: 'open',
      html_url: `https://gitea.example/acme/demo/pulls/${this.pullRequests.length + 1}`,
      merged: false,
      merge_base: targetHead.sha,
      head: {
        ref: headRef,
        sha: this.branches.get(headRef)?.commit.id ?? '',
        repo: { full_name: this.pullRequestHeadFullName },
      },
      base: {
        ref: options.base,
        sha: targetHead.sha,
        repo: { full_name: 'acme/demo' },
      },
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

  async getBranch(branch: string) {
    return this.branches.get(branch) ?? null;
  }

  async createBranch(branch: string, oldRef: string) {
    const sourceEntry = [...this.branches.values()].find(
      (candidate) => candidate.commit.id === oldRef,
    );
    const sourceBranch = sourceEntry?.name ?? 'main';
    const sourceFiles = this.files.get(sourceBranch) ?? new Map();
    this.files.set(branch, new Map([...sourceFiles].map(([path, file]) => [path, { ...file }])));
    const created = { name: branch, commit: { id: oldRef, message: 'base' } };
    this.branches.set(branch, created);
    return created;
  }

  async updateBranch(branch: string, newCommitId: string, oldCommitId?: string) {
    this.updatedBranches.push({
      branch,
      newCommitId,
      ...(oldCommitId === undefined ? {} : { oldCommitId }),
    });
    const sourceEntry = [...this.branches.values()].find(
      (candidate) => candidate.commit.id === newCommitId,
    );
    const sourceFiles = this.files.get(sourceEntry?.name ?? 'main') ?? new Map();
    this.files.set(branch, new Map([...sourceFiles].map(([path, file]) => [path, { ...file }])));
    this.branches.set(branch, { name: branch, commit: { id: newCommitId, message: 'base' } });
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
    if (options.forcePush && this.rejectForcePush) {
      throw new GiteaApiError(403, 'branch is protected from force push');
    }
    this.changeFilesCalls.push(options);
    this.lastChangeFiles = options;
    const destination = options.newBranch ?? options.branch;
    if (options.newBranch) {
      if (this.branches.has(destination) && !options.forcePush) {
        throw new Error(`Branch ${destination} already exists without forcePush.`);
      }
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
    this.changeCounter += 1;
    const sourceHead =
      options.branch === 'main'
        ? this.commits[0]?.sha
        : this.branches.get(options.branch)?.commit.id;
    const sha = hashContent(
      `${options.message}-${sourceHead ?? ''}-${this.changeCounter}-${JSON.stringify([...destinationFiles])}`,
    ).slice(0, 40);
    this.branches.set(destination, {
      name: destination,
      commit: { id: sha, message: options.message },
    });
    if (sourceHead) this.branchParents.set(destination, sourceHead);
    for (const pullRequest of this.pullRequests) {
      if (pullRequest.state === 'open' && pullRequest.head.ref === destination) {
        pullRequest.head.sha = sha;
        if (sourceHead) pullRequest.merge_base = sourceHead;
      }
    }
    return sha;
  }

  addMainCommit(sha: string, message: string): void {
    this.commits.unshift(commit(sha, message));
    this.branches.set('main', { name: 'main', commit: { id: sha, message } });
  }

  async listLabels() {
    return this.labels;
  }

  async createLabel(name: string, color: string) {
    const label = { id: this.labels.length + 1, name, color };
    this.labels.push(label);
    return label;
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
      newBranch: 'release-please--branches--main',
      message: 'chore(main): release 0.1.0',
    });
    expect(api.lastChangeFiles?.forcePush).toBeUndefined();
    expect(api.lastChangeFiles?.files).toHaveLength(3);
    expect(
      JSON.parse(
        (await api.getTextContent(
          '.release-please-manifest.json',
          'release-please--branches--main',
        )) ?? '',
      ),
    ).toEqual({ '.': '0.1.0' });
    const pullRequest = api.pullRequests[0];
    expect(pullRequest?.title).toBe('chore(main): release 0.1.0');
    expect(parseMarker(pullRequest?.body ?? '')).toMatchObject({
      schema: 2,
      version: '0.1.0',
      targetBranch: 'main',
      manifestPath: '.release-please-manifest.json',
    });
  });

  it('accepts null commit files when root releases do not request file filtering', async () => {
    const api = new FakeApi();
    const firstCommit = api.commits[0];
    if (!firstCommit) throw new Error('Missing test commit');
    firstCommit.files = null;

    await expect(manager(api).run()).resolves.toMatchObject({
      prCreated: true,
      prUpdated: false,
    });
  });

  it('requires a valid manifest and a matching reachable release tag', async () => {
    const missing = new FakeApi();
    missing.files.get('main')?.delete('.release-please-manifest.json');
    await expect(manager(missing).run()).rejects.toThrow(
      'Manifest file .release-please-manifest.json does not exist',
    );

    const missingEntry = new FakeApi();
    missingEntry.tags = [
      { name: 'v0.1.0', commit: { sha: '1111111111111111' } },
    ];
    await expect(manager(missingEntry).run()).rejects.toThrow(
      'has no . entry, but release tags already exist',
    );

    const missingTag = new FakeApi();
    missingTag.files.get('main')?.set('.release-please-manifest.json', {
      content: '{".":"0.1.0"}\n',
      sha: 'release-manifest',
    });
    await expect(manager(missingTag).run()).rejects.toThrow(
      'expects release tag v0.1.0, but it does not exist',
    );

    const unreachable = new FakeApi();
    unreachable.files.get('main')?.set('.release-please-manifest.json', {
      content: '{".":"0.1.0"}\n',
      sha: 'release-manifest',
    });
    unreachable.tags = [
      { name: 'v0.1.0', commit: { sha: '9999999999999999' } },
    ];
    await expect(manager(unreachable).run()).rejects.toThrow(
      'Manifest release tag v0.1.0 is not reachable from main',
    );
  });

  it('updates the same PR when another releasable commit reaches main', async () => {
    const api = new FakeApi();
    await manager(api).run();
    const firstReleaseHead = api.branches.get(
      'release-please--branches--main',
    )?.commit.id;
    api.addMainCommit('2222222222222222', 'fix: second change');

    const result = await manager(api).run();

    expect(result).toMatchObject({ prCreated: false, prUpdated: true, prNumber: 1 });
    expect(api.pullRequests).toHaveLength(1);
    expect(api.lastChangeFiles).toMatchObject({
      branch: 'main',
      newBranch: 'release-please--branches--main',
      forcePush: true,
    });
    expect(api.branchParents.get('release-please--branches--main')).toBe(
      '2222222222222222',
    );
    expect(api.branches.get('release-please--branches--main')?.commit.id).not.toBe(
      firstReleaseHead,
    );
    const notes = await api.getTextContent(
      'RELEASE.md',
      'release-please--branches--main',
    );
    expect(notes).toContain('initial feature');
    expect(notes).toContain('second change');
  });

  it('does not rebuild an unchanged release pull request', async () => {
    const api = new FakeApi();
    await manager(api).run();
    const calls = api.changeFilesCalls.length;

    const result = await manager(api).run();

    expect(result).toMatchObject({ prCreated: false, prUpdated: false });
    expect(api.changeFilesCalls).toHaveLength(calls);
  });

  it('safely rebuilds a matching orphaned release branch before recovering it', async () => {
    const api = new FakeApi();
    await manager(api).run();
    const abandoned = api.pullRequests[0];
    if (!abandoned) throw new Error('Missing release pull request');
    abandoned.state = 'closed';

    const result = await manager(api).run();

    expect(result).toMatchObject({ prCreated: true, prNumber: 2 });
    expect(api.pullRequests).toHaveLength(2);
    expect(api.lastChangeFiles).toMatchObject({
      branch: 'main',
      newBranch: 'release-please--branches--main',
      forcePush: true,
    });
    expect(api.pullRequests[1]?.head.ref).toBe(
      'release-please--branches--main',
    );
  });

  it('dynamically escalates the same release from patch to minor to major', async () => {
    const api = new FakeApi();
    api.commits = [
      commit('2222222222222222', 'fix: repair cache'),
      commit('1111111111111111', 'chore(main): release v1.2.3'),
    ];
    api.tags = [{ name: 'v1.2.3', commit: { sha: '1111111111111111' } }];
    api.files.get('main')?.set('.release-please-manifest.json', {
      content: '{".":"1.2.3"}\n',
      sha: 'release-manifest',
    });
    api.branches.set('main', {
      name: 'main',
      commit: { id: '2222222222222222', message: 'fix: repair cache' },
    });
    api.files.get('main')?.set('CHANGELOG.md', {
      content: '# Changelog\n\n## 1.2.3\n\nPrevious release\n',
      sha: 'old-changelog',
    });

    await manager(api).run();
    expect(api.pullRequests[0]?.title).toBe('chore(main): release 1.2.4');

    api.addMainCommit('3333333333333333', 'feat: add batch import');
    await manager(api).run();
    expect(api.pullRequests).toHaveLength(1);
    expect(api.pullRequests[0]?.title).toBe('chore(main): release 1.3.0');

    api.addMainCommit('4444444444444444', 'feat!: replace public API');
    await manager(api).run();

    expect(api.pullRequests).toHaveLength(1);
    expect(api.pullRequests[0]?.title).toBe('chore(main): release 2.0.0');
    expect(parseMarker(api.pullRequests[0]?.body ?? '')).toMatchObject({
      version: '2.0.0',
      tagName: 'v2.0.0',
    });
    expect(api.branchParents.get('release-please--branches--main')).toBe(
      '4444444444444444',
    );
    const notes = await api.getTextContent(
      'RELEASE.md',
      'release-please--branches--main',
    );
    expect(notes).toContain('repair cache');
    expect(notes).toContain('add batch import');
    expect(notes).toContain('replace public API');
  });

  it('fails clearly when Gitea rejects the release branch force-push', async () => {
    const api = new FakeApi();
    await manager(api).run();
    api.addMainCommit('2222222222222222', 'fix: second change');
    api.rejectForcePush = true;

    await expect(manager(api).run()).rejects.toThrow(
      'Ensure release-please--branches--main allows force pushes',
    );
    expect(api.pullRequests).toHaveLength(1);
  });

  it('refuses to overwrite generated files changed outside the action', async () => {
    const api = new FakeApi();
    await manager(api).run();
    const releaseFiles = api.files.get('release-please--branches--main');
    releaseFiles?.set('RELEASE.md', { content: 'manually edited', sha: 'manual' });

    await expect(manager(api).run()).rejects.toThrow('does not match its release marker');
  });

  it('rejects a spoofed open pull request carrying a release marker', async () => {
    const api = new FakeApi();
    await manager(api).run();
    const pullRequest = api.pullRequests[0];
    if (!pullRequest) throw new Error('Missing release pull request');
    pullRequest.head.repo = { full_name: 'attacker/demo' };

    await expect(manager(api).run()).rejects.toThrow(
      'is not the managed release-please--branches--main pull request from acme/demo',
    );
  });

  it('atomically updates and verifies configured extra files', async () => {
    const api = new FakeApi();
    const extraFiles: ActionConfig['extraFiles'] = [
      { type: 'json', path: 'package.json', jsonpath: '$.version' },
      { type: 'toml', path: 'pyproject.toml', jsonpath: '$.project.version' },
    ];
    api.files.get('main')?.set('package.json', {
      content: '{"name":"demo","version":"0.0.0"}\n',
      sha: 'package-json',
    });
    api.files.get('main')?.set('pyproject.toml', {
      content: '[project]\nname = "demo"\nversion = "0.0.0"\n',
      sha: 'pyproject-toml',
    });

    await manager(api, { extraFiles }).run();

    expect(api.lastChangeFiles?.files).toHaveLength(5);
    const releaseFiles = api.files.get('release-please--branches--main');
    expect(JSON.parse(releaseFiles?.get('package.json')?.content ?? '')).toMatchObject({
      version: '0.1.0',
    });
    expect(releaseFiles?.get('pyproject.toml')?.content).toContain('version = "0.1.0"');
    expect(parseMarker(api.pullRequests[0]?.body ?? '')?.fileHashes).toEqual(
      expect.objectContaining({
        'CHANGELOG.md': expect.any(String),
        'RELEASE.md': expect.any(String),
        '.release-please-manifest.json': expect.any(String),
        'package.json': expect.any(String),
        'pyproject.toml': expect.any(String),
      }),
    );

  });

  it('refuses to overwrite a configured extra file changed on the release branch', async () => {
    const api = new FakeApi();
    const extraFiles: ActionConfig['extraFiles'] = [
      { type: 'json', path: 'package.json', jsonpath: '$.version' },
    ];
    api.files.get('main')?.set('package.json', {
      content: '{"name":"demo","version":"0.0.0"}\n',
      sha: 'package-json',
    });
    await manager(api, { extraFiles }).run();
    api.files.get('release-please--branches--main')?.set('package.json', {
      content: '{"name":"demo","version":"manual"}\n',
      sha: 'manual',
    });

    await expect(manager(api, { extraFiles }).run()).rejects.toThrow(
      'Generated file package.json',
    );
  });

  it('increments from the latest reachable tag after the first release', async () => {
    const api = new FakeApi();
    api.commits = [
      commit('2222222222222222', 'feat: second feature'),
      commit('1111111111111111', 'chore(main): release v0.1.0'),
    ];
    api.tags = [{ name: 'v0.1.0', commit: { sha: '1111111111111111' } }];
    api.files.get('main')?.set('.release-please-manifest.json', {
      content: '{".":"0.1.0"}\n',
      sha: 'release-manifest',
    });
    api.files.get('main')?.set('CHANGELOG.md', {
      content: '# Changelog\n\n## 0.1.0\n\nInitial release\n',
      sha: 'old-changelog',
    });

    await manager(api).run();
    expect(api.pullRequests[0]?.title).toBe('chore(main): release 0.2.0');
  });

  it('creates release pull requests without a tag prefix', async () => {
    const api = new FakeApi();
    const unprefixed = { tagPrefix: '' };

    await manager(api, unprefixed).run();
    expect(api.pullRequests[0]?.title).toBe('chore(main): release 0.1.0');
    expect(parseMarker(api.pullRequests[0]?.body ?? '')).toMatchObject({
      version: '0.1.0',
      tagName: '0.1.0',
    });

  });

  it('increments from the latest reachable tag without a prefix', async () => {
    const api = new FakeApi();
    api.commits = [
      commit('2222222222222222', 'feat: second feature'),
      commit('1111111111111111', 'chore(main): release 0.1.0'),
    ];
    api.tags = [{ name: '0.1.0', commit: { sha: '1111111111111111' } }];
    api.files.get('main')?.set('.release-please-manifest.json', {
      content: '{".":"0.1.0"}\n',
      sha: 'release-manifest',
    });

    await manager(api, { tagPrefix: '' }).run();

    expect(api.pullRequests[0]?.title).toBe('chore(main): release 0.2.0');
  });

  it('excludes commits when all changed files are under configured paths', async () => {
    const api = new FakeApi();
    const docsOnly = commit('2222222222222222', 'feat: rewrite all docs');
    docsOnly.files = [{ filename: 'docs/guide.md' }];
    const sourceChange = commit('1111111111111111', 'fix: repair runtime');
    sourceChange.files = [{ filename: 'src/runtime.ts' }];
    api.commits = [docsOnly, sourceChange];

    await manager(api, { excludePaths: ['docs'] }).run();

    const notes = await api.getTextContent('RELEASE.md', 'release-please--branches--main');
    expect(notes).toContain('repair runtime');
    expect(notes).not.toContain('rewrite all docs');
  });

  it('scopes commits and release files to one non-root package path', async () => {
    const api = new FakeApi();
    const unrelated = commit('3333333333333333', 'feat: unrelated root feature');
    unrelated.files = [{ filename: 'src/root.ts' }];
    const packageFix = commit('2222222222222222', 'fix: repair package API');
    packageFix.files = [{ filename: 'packages/api/src/api.ts' }];
    const previousRelease = commit('1111111111111111', 'chore(main): release 1.0.0');
    previousRelease.files = [{ filename: '.release-please-manifest.json' }];
    api.commits = [unrelated, packageFix, previousRelease];
    api.tags = [{ name: 'v1.0.0', commit: { sha: previousRelease.sha } }];
    api.files.get('main')?.set('.release-please-manifest.json', {
      content: '{"packages/api":"1.0.0"}\n',
      sha: 'release-manifest',
    });
    api.files.get('main')?.set('packages/api/package.json', {
      content: '{"name":"api","version":"1.0.0"}\n',
      sha: 'package-json',
    });

    await manager(api, {
      path: 'packages/api',
      extraFiles: [{ type: 'json', path: 'package.json', jsonpath: '$.version' }],
    }).run();

    expect(api.pullRequests[0]?.title).toBe('chore(main): release 1.0.1');
    expect(api.lastChangeFiles?.files.map((file) => file.path).sort()).toEqual([
      '.release-please-manifest.json',
      'packages/api/CHANGELOG.md',
      'packages/api/RELEASE.md',
      'packages/api/package.json',
    ]);
    const marker = parseMarker(api.pullRequests[0]?.body ?? '');
    expect(marker).toMatchObject({
      path: 'packages/api',
      changelogPath: 'packages/api/CHANGELOG.md',
      releaseNotesPath: 'packages/api/RELEASE.md',
      manifestPath: '.release-please-manifest.json',
    });
    const notes = await api.getTextContent(
      'packages/api/RELEASE.md',
      'release-please--branches--main',
    );
    expect(notes).toContain('repair package API');
    expect(notes).not.toContain('unrelated root feature');
  });

  it('creates and rebuilds a managed release branch in a fork', async () => {
    const upstream = new FakeApi();
    upstream.pullRequestHeadFullName = 'release-bot/demo';
    const fork = new FakeApi();
    fork.pullRequests = upstream.pullRequests;
    const head: ReleaseHead = {
      client: fork as unknown as ReleaseHead['client'],
      fullName: 'release-bot/demo',
      owner: 'release-bot',
      fork: true,
    };
    const createManager = () =>
      new ReleaseManager(
        upstream,
        { ...config, fork: true },
        logger,
        () => new Date('2026-07-14T00:00:00Z'),
        head,
      );

    await createManager().run();

    expect(upstream.pullRequests[0]?.head).toMatchObject({
      ref: 'release-please--branches--main',
      repo: { full_name: 'release-bot/demo' },
    });
    expect(fork.files.get('release-please--branches--main')?.has('RELEASE.md')).toBe(true);
    expect(upstream.files.get('release-please--branches--main')).toBeUndefined();

    upstream.addMainCommit('2222222222222222', 'fix: update fork release');
    await createManager().run();

    expect(upstream.pullRequests).toHaveLength(1);
    expect(fork.updatedBranches.at(-1)).toMatchObject({
      branch: 'release-please--branches--main',
      newCommitId: '2222222222222222',
    });
    expect(upstream.updatedPullRequestBranches).toEqual([1]);
    expect(
      fork.files.get('release-please--branches--main')?.get('RELEASE.md')?.content,
    ).toContain('update fork release');
  });

  it('does not open another PR while a merged managed release remains untagged', async () => {
    const api = new FakeApi();
    await manager(api).run();
    const releasePullRequest = api.pullRequests[0];
    if (!releasePullRequest) throw new Error('Missing release pull request');
    releasePullRequest.state = 'closed';
    releasePullRequest.merged = true;
    releasePullRequest.merge_commit_sha = '9999999999999999';
    api.addMainCommit('2222222222222222', 'fix: change after unpublished release');

    const result = await manager(api).run();

    expect(result).toEqual({ prCreated: false, prUpdated: false });
    expect(api.pullRequests).toHaveLength(1);
  });

});
