import { afterEach, describe, expect, it, vi } from 'vitest';

import { GiteaClient } from '../src/gitea-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GiteaClient', () => {
  it('authenticates requests and encodes atomic multi-file changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ commit: { sha: 'new-commit' }, files: [] }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/root/api/v1',
      'super-secret',
      'acme',
      'demo',
    );

    const sha = await client.changeFiles({
      branch: 'main',
      newBranch: 'release/main',
      forcePush: true,
      message: 'chore(main): release v0.1.0',
      files: [
        { operation: 'create', path: 'CHANGELOG.md', content: '# Changelog\n' },
        { operation: 'update', path: 'docs/RELEASE.md', content: '# v0.1.0\n', sha: 'old' },
      ],
    });

    expect(sha).toBe('new-commit');
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://gitea.example/root/api/v1/repos/acme/demo/contents',
    );
    expect(init.headers).toMatchObject({ Authorization: 'token super-secret' });
    const body = JSON.parse(String(init.body)) as {
      branch: string;
      new_branch: string;
      force_push: boolean;
      files: Array<{ content: string }>;
    };
    expect(body).toMatchObject({
      branch: 'main',
      new_branch: 'release/main',
      force_push: true,
    });
    expect(Buffer.from(body.files[0]?.content ?? '', 'base64').toString()).toBe(
      '# Changelog\n',
    );
  });

  it('paginates list endpoints until a short page is returned', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      name: `v0.0.${index}`,
      commit: { sha: String(index) },
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(
        jsonResponse([{ name: 'v1.0.0', commit: { sha: 'last' } }]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/api/v1',
      'secret',
      'acme',
      'demo',
    );

    const tags = await client.listTags();

    expect(tags).toHaveLength(51);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(secondUrl.searchParams.get('page')).toBe('2');
    expect(secondUrl.searchParams.get('limit')).toBe('50');
  });

  it('stops commit pagination as soon as the release boundary is found', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      sha: `commit-${index}`,
      html_url: `https://gitea.example/acme/demo/commit/${index}`,
      commit: { message: `fix: commit ${index}` },
      parents: [],
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/api/v1',
      'secret',
      'acme',
      'demo',
    );

    const commits = await client.listCommits('main', true, {
      stopSha: 'commit-23',
      maxResults: 500,
    });

    expect(commits).toHaveLength(24);
    expect(commits.at(-1)?.sha).toBe('commit-23');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('files')).toBe('true');
  });

  it('bounds pagination and filters pull requests by base branch', async () => {
    const page = Array.from({ length: 50 }, (_, index) => ({
      number: index + 1,
      base: { ref: index === 0 ? 'develop' : 'main' },
      merged: index !== 1,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse(page));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/api/v1',
      'secret',
      'acme',
      'demo',
    );

    const pullRequests = await client.listPullRequests('closed', {
      base: 'main',
      maxResults: 60,
      merged: true,
    });

    expect(pullRequests).toHaveLength(60);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(firstUrl.searchParams.get('base')).toBe('main');
    expect(firstUrl.searchParams.get('page')).toBe('1');
    const secondUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(secondUrl.searchParams.get('page')).toBe('2');
    expect(pullRequests.every((pullRequest) => (
      pullRequest.base.ref === 'main' && pullRequest.merged
    ))).toBe(true);
  });

  it('returns null for allowed 404 file and release lookups', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/api/v1',
      'secret',
      'acme',
      'demo',
    );

    await expect(client.getContent('docs/RELEASE.md', 'main')).resolves.toBeNull();
    await expect(client.getReleaseByTag('v0.1.0')).resolves.toBeNull();
    const firstUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(firstUrl.pathname).toContain('/contents/docs/RELEASE.md');
  });

  it('attaches an Undici dispatcher when proxy-server is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/api/v1',
      'secret',
      'acme',
      'demo',
      'http://proxy.example:8080/',
    );

    await client.listTags();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
  });

  it('uses Gitea 1.27 fork and branch-update endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ login: 'release-bot' }))
      .mockResolvedValueOnce(jsonResponse([{ full_name: 'release-bot/demo' }]))
      .mockResolvedValueOnce(
        jsonResponse({ name: 'release-please--branches--main', commit: { id: 'base' } }, 201),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/api/v1',
      'secret',
      'acme',
      'demo',
    );

    await expect(client.getAuthenticatedUser()).resolves.toMatchObject({
      login: 'release-bot',
    });
    await expect(client.listForks()).resolves.toHaveLength(1);
    await client.createBranch('release-please--branches--main', 'upstream-sha');
    await client.updateBranch(
      'release-please--branches--main',
      'new-upstream-sha',
      'old-release-sha',
    );
    await client.updatePullRequestBranch(7, 'rebase');

    const createBranchBody = JSON.parse(
      String((fetchMock.mock.calls[2]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(createBranchBody).toEqual({
      new_branch_name: 'release-please--branches--main',
      old_ref_name: 'upstream-sha',
    });
    const updateBranchBody = JSON.parse(
      String((fetchMock.mock.calls[3]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(updateBranchBody).toMatchObject({
      new_commit_id: 'new-upstream-sha',
      old_commit_id: 'old-release-sha',
      force: true,
    });
    expect((fetchMock.mock.calls[4]?.[0] as URL).toString()).toContain(
      '/pulls/7/update?style=rebase',
    );
  });

  it('recursively lists repository files for extra-files globs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { path: 'package.json', sha: 'one', type: 'file' },
          { path: 'packages', sha: 'two', type: 'dir' },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ path: 'packages/api.json', sha: 'three', type: 'file' }]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/api/v1',
      'secret',
      'acme',
      'demo',
    );

    await expect(client.listFiles('main')).resolves.toEqual([
      'package.json',
      'packages/api.json',
    ]);
    expect((fetchMock.mock.calls[1]?.[0] as URL).pathname).toContain(
      '/contents/packages',
    );
  });

  it('passes draft and prerelease flags to Gitea releases', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 1,
        tag_name: 'v2.0.0-beta.0',
        name: 'v2.0.0-beta.0',
        body: 'notes',
        html_url: 'https://gitea.example/acme/demo/releases/tag/v2.0.0-beta.0',
      }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new GiteaClient(
      'https://gitea.example/api/v1',
      'secret',
      'acme',
      'demo',
    );

    await client.createRelease({
      tagName: 'v2.0.0-beta.0',
      target: 'release-sha',
      body: 'notes',
      draft: true,
      prerelease: true,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      draft: true,
      prerelease: true,
    });
  });
});
