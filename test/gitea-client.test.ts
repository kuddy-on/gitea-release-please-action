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
      files: Array<{ content: string }>;
    };
    expect(body).toMatchObject({ branch: 'main', new_branch: 'release/main' });
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
});
