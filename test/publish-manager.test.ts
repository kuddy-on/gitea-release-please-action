import { describe, expect, it } from 'vitest';

import { buildPullRequestBody, hashContent } from '../src/marker.js';
import { PublishManager, type PublishApi } from '../src/publish-manager.js';
import type { ReleaseHead } from '../src/release-head.js';
import type {
  ActionConfig,
  Logger,
  PullRequest,
  RepositoryLabel,
  RepositoryRelease,
  RepositoryTag,
} from '../src/types.js';

const mergeSha = '9999999999999999999999999999999999999999';
const targetHeadSha = '8888888888888888888888888888888888888888';
const releaseBranch = 'release-please--branches--main';
const changelog = '# Changelog\n\n## 1.3.0\n';
const releaseNotes = '## 1.3.0\n\nRelease notes\n';
const manifest = '{\n  ".": "1.3.0"\n}\n';

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
  initialVersion: '1.0.0',
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

function releaseBody(
  tagName = 'v1.3.0',
  version = '1.3.0',
  manifestContent = `{\n  ".": "${version}"\n}\n`,
): string {
  return buildPullRequestBody(
    {
      schema: 2,
      version,
      tagName,
      targetBranch: 'main',
      targetHeadSha,
      changelogPath: 'CHANGELOG.md',
      releaseNotesPath: 'RELEASE.md',
      manifestPath: '.release-please-manifest.json',
      fileHashes: {
        'CHANGELOG.md': hashContent(changelog),
        'RELEASE.md': hashContent(releaseNotes),
        '.release-please-manifest.json': hashContent(manifestContent),
      },
    },
    releaseNotes,
  );
}

function managedPullRequest(): PullRequest {
  return {
    number: 7,
    title: 'chore(main): release 1.3.0',
    body: releaseBody(),
    state: 'closed',
    html_url: 'https://gitea.example/acme/demo/pulls/7',
    merged: true,
    merged_at: '2026-07-14T01:00:00Z',
    merge_commit_sha: mergeSha,
    head: {
      ref: releaseBranch,
      sha: '7777777777777777777777777777777777777777',
      repo: { full_name: 'acme/demo' },
    },
    base: {
      ref: 'main',
      sha: mergeSha,
      repo: { full_name: 'acme/demo' },
    },
    labels: [{ id: 1, name: 'autorelease: pending', color: 'fbca04' }],
  };
}

class FakePublishApi implements PublishApi {
  pullRequest = managedPullRequest();
  tags: RepositoryTag[] = [];
  releases: RepositoryRelease[] = [];
  labels: RepositoryLabel[] = [
    { id: 1, name: 'autorelease: pending', color: 'fbca04' },
    { id: 2, name: 'autorelease: tagged', color: '0e8a16' },
  ];
  branchExists = true;
  changedFiles = ['CHANGELOG.md', 'RELEASE.md', '.release-please-manifest.json'];
  files = new Map([
    [`${mergeSha}:CHANGELOG.md`, changelog],
    [`${mergeSha}:RELEASE.md`, releaseNotes],
    [`${mergeSha}:.release-please-manifest.json`, manifest],
  ]);

  async getTextContent(path: string, ref: string) {
    return this.files.get(`${ref}:${path}`) ?? null;
  }

  async getContent(path: string, ref: string) {
    const content = this.files.get(`${ref}:${path}`);
    return content === undefined
      ? null
      : {
          content: Buffer.from(content).toString('base64'),
          encoding: 'base64',
          path,
          sha: hashContent(content),
          type: 'file' as const,
        };
  }

  async getTag(tagName: string) {
    return this.tags.find((tag) => tag.name === tagName) ?? null;
  }

  async createTag(tagName: string, target: string) {
    const tag = { name: tagName, commit: { sha: target } };
    this.tags.push(tag);
    return tag;
  }

  async getReleaseByTag(tagName: string) {
    return this.releases.find((release) => release.tag_name === tagName) ?? null;
  }

  async createRelease(options: Parameters<PublishApi['createRelease']>[0]) {
    const release: RepositoryRelease = {
      id: this.releases.length + 1,
      tag_name: options.tagName,
      name: options.name ?? options.tagName,
      body: options.body,
      html_url: `https://gitea.example/acme/demo/releases/tag/${options.tagName}`,
      upload_url: `https://gitea.example/api/v1/repos/acme/demo/releases/1/assets`,
      ...(options.draft === undefined ? {} : { draft: options.draft }),
      ...(options.prerelease === undefined ? {} : { prerelease: options.prerelease }),
    };
    this.releases.push(release);
    return release;
  }

  async listPullRequests(state: 'open' | 'closed') {
    return state === 'closed' ? [this.pullRequest] : [];
  }

  async listPullRequestFiles() {
    return this.changedFiles.map((filename) => ({ filename }));
  }

  async getBranch() {
    return this.branchExists
      ? { name: releaseBranch, commit: { id: 'release-head', message: 'release' } }
      : null;
  }

  async deleteBranch() {
    this.branchExists = false;
  }

  async listLabels() {
    return this.labels;
  }

  async createLabel(name: string, color: string) {
    const label = { id: this.labels.length + 1, name, color };
    this.labels.push(label);
    return label;
  }

  async editPullRequest(
    _number: number,
    options: Parameters<PublishApi['editPullRequest']>[1],
  ) {
    if (options.labels) {
      this.pullRequest.labels = options.labels
        .map((id) => this.labels.find((label) => label.id === id))
        .filter((label): label is RepositoryLabel => label !== undefined);
    }
    return this.pullRequest;
  }
}

async function publish(
  api: FakePublishApi,
  overrides: Partial<ActionConfig> = {},
  head?: Pick<ReleaseHead, 'client' | 'fullName'>,
) {
  const result = await new PublishManager(
    api,
    { ...config, ...overrides },
    logger,
    head,
  ).run();
  if (!result) throw new Error('Expected a release result.');
  return result;
}

describe('PublishManager', () => {
  it('automatically publishes a merged managed release PR and deletes its branch', async () => {
    const api = new FakePublishApi();
    const result = await publish(api);

    expect(result).toMatchObject({
      releaseCreated: true,
      tagName: 'v1.3.0',
      version: '1.3.0',
      sha: mergeSha,
      body: releaseNotes,
      prNumber: 7,
    });
    expect(api.tags).toEqual([{ name: 'v1.3.0', commit: { sha: mergeSha } }]);
    expect(api.releases[0]?.body).toBe(releaseNotes);
    expect(api.pullRequest.labels?.map((label) => label.name)).toContain(
      'autorelease: tagged',
    );
    expect(api.branchExists).toBe(false);
  });

  it('finishes lifecycle cleanup idempotently when tag and release already exist', async () => {
    const api = new FakePublishApi();
    api.tags.push({ name: 'v1.3.0', commit: { sha: mergeSha } });
    api.releases.push({
      id: 1,
      tag_name: 'v1.3.0',
      name: 'v1.3.0',
      body: releaseNotes,
      html_url: 'https://gitea.example/acme/demo/releases/tag/v1.3.0',
    });

    const result = await publish(api);
    expect(result.releaseCreated).toBe(false);
    expect(api.tags).toHaveLength(1);
    expect(api.releases).toHaveLength(1);
    expect(await new PublishManager(api, config, logger).run()).toBeNull();
  });

  it('repairs a missing release without recreating the matching tag', async () => {
    const api = new FakePublishApi();
    api.tags.push({ name: 'v1.3.0', commit: { sha: mergeSha } });
    api.pullRequest.head.ref = 'refs/pull/7/head';

    const result = await publish(api);
    expect(result.releaseCreated).toBe(true);
    expect(api.tags).toHaveLength(1);
    expect(api.releases).toHaveLength(1);
  });

  it('ignores ordinary and unmerged pull requests', async () => {
    const ordinary = new FakePublishApi();
    ordinary.pullRequest.body = 'ordinary feature pull request';
    expect(await new PublishManager(ordinary, config, logger).run()).toBeNull();

    const unmerged = new FakePublishApi();
    unmerged.pullRequest.merged = false;
    expect(await new PublishManager(unmerged, config, logger).run()).toBeNull();
  });

  it('rejects fork, wrong-prefix, tampered, and conflicting release data', async () => {
    const fork = new FakePublishApi();
    fork.pullRequest.head.repo = { full_name: 'attacker/demo' };
    await expect(publish(fork)).rejects.toThrow('must originate from acme/demo');

    const prefix = new FakePublishApi();
    prefix.pullRequest.body = releaseBody('1.3.0');
    await expect(publish(prefix)).rejects.toThrow('invalid version marker');

    const tampered = new FakePublishApi();
    tampered.files.set(`${mergeSha}:RELEASE.md`, 'manually changed');
    await expect(publish(tampered)).rejects.toThrow('does not match its release marker');

    const conflict = new FakePublishApi();
    conflict.tags.push({ name: 'v1.3.0', commit: { sha: 'different-sha' } });
    await expect(publish(conflict)).rejects.toThrow('points to different-sha');

    const wrongManifest = new FakePublishApi();
    const incorrectManifest = '{".":"9.9.9"}\n';
    wrongManifest.files.set(
      `${mergeSha}:.release-please-manifest.json`,
      incorrectManifest,
    );
    wrongManifest.pullRequest.body = releaseBody(
      'v1.3.0',
      '1.3.0',
      incorrectManifest,
    );
    await expect(publish(wrongManifest)).rejects.toThrow(
      'records 9.9.9, not 1.3.0',
    );

    const unhashed = new FakePublishApi();
    unhashed.changedFiles.push('backdoor.txt');
    unhashed.files.set(`${mergeSha}:backdoor.txt`, 'malicious\n');
    await expect(publish(unhashed)).rejects.toThrow(
      'files absent from its marker: backdoor.txt',
    );
  });

  it('ignores stale PR file entries unchanged from the rebuilt target head', async () => {
    const api = new FakePublishApi();
    api.changedFiles.push('follow-up.txt');
    api.files.set(`${targetHeadSha}:follow-up.txt`, 'follow-up\n');
    api.files.set(`${mergeSha}:follow-up.txt`, 'follow-up\n');

    const result = await publish(api);

    expect(result.releaseCreated).toBe(true);
    expect(api.releases).toHaveLength(1);
  });

  it('publishes tags without a prefix when configured', async () => {
    const api = new FakePublishApi();
    api.pullRequest.body = releaseBody('1.3.0');

    const result = await publish(api, { tagPrefix: '' });
    expect(result.tagName).toBe('1.3.0');
    expect(api.tags[0]?.name).toBe('1.3.0');
  });

  it('configures the Gitea Release display-name v prefix independently', async () => {
    const api = new FakePublishApi();
    await publish(api, { includeVInReleaseName: false });
    expect(api.releases[0]?.name).toBe('1.3.0');
  });

  it('passes draft and prerelease publication flags to Gitea', async () => {
    const api = new FakePublishApi();
    await publish(api, {
      draft: true,
      prerelease: true,
      versioningStrategy: 'prerelease',
    });
    expect(api.releases[0]).toMatchObject({ draft: true, prerelease: true });
  });

  it('publishes a single non-root package from its scoped release files', async () => {
    const api = new FakePublishApi();
    const packageChangelog = '# Changelog\n\n## 1.3.0\n';
    const packageNotes = '## 1.3.0\n\nPackage release notes\n';
    api.pullRequest.body = buildPullRequestBody(
      {
        schema: 2,
        path: 'packages/api',
        version: '1.3.0',
        tagName: 'v1.3.0',
        targetBranch: 'main',
        targetHeadSha,
        changelogPath: 'packages/api/CHANGELOG.md',
        releaseNotesPath: 'packages/api/RELEASE.md',
        manifestPath: '.release-please-manifest.json',
        fileHashes: {
          'packages/api/CHANGELOG.md': hashContent(packageChangelog),
          'packages/api/RELEASE.md': hashContent(packageNotes),
          '.release-please-manifest.json': hashContent(
            '{\n  "packages/api": "1.3.0"\n}\n',
          ),
        },
      },
      packageNotes,
    );
    api.changedFiles = [
      'packages/api/CHANGELOG.md',
      'packages/api/RELEASE.md',
      '.release-please-manifest.json',
    ];
    api.files = new Map([
      [`${mergeSha}:packages/api/CHANGELOG.md`, packageChangelog],
      [`${mergeSha}:packages/api/RELEASE.md`, packageNotes],
      [
        `${mergeSha}:.release-please-manifest.json`,
        '{\n  "packages/api": "1.3.0"\n}\n',
      ],
    ]);

    const result = await publish(api, { path: 'packages/api' });

    expect(result).toMatchObject({ path: 'packages/api', body: packageNotes });
    expect(api.releases[0]?.body).toBe(packageNotes);
  });

  it('publishes an upstream release and cleans up a fork release branch', async () => {
    const upstream = new FakePublishApi();
    upstream.pullRequest.head.repo = { full_name: 'release-bot/demo' };
    const fork = new FakePublishApi();

    const result = await publish(
      upstream,
      { fork: true },
      {
        client: fork as unknown as ReleaseHead['client'],
        fullName: 'release-bot/demo',
      },
    );

    expect(result.releaseCreated).toBe(true);
    expect(upstream.tags[0]).toEqual({ name: 'v1.3.0', commit: { sha: mergeSha } });
    expect(upstream.releases).toHaveLength(1);
    expect(fork.branchExists).toBe(false);
    expect(upstream.branchExists).toBe(true);
  });
});
