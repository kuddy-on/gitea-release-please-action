import { ProxyAgent, type Dispatcher } from 'undici';

import type {
  AuthenticatedUser,
  ChangeFileOperation,
  PullRequest,
  PullRequestChangedFile,
  Repository,
  RepositoryBranch,
  RepositoryCommit,
  RepositoryContent,
  RepositoryLabel,
  RepositoryRelease,
  RepositoryTag,
} from './types.js';

interface RequestOptions {
  query?: Record<string, boolean | number | string | undefined>;
  body?: unknown;
  allowNotFound?: boolean;
}

interface ChangeFilesOptions {
  branch: string;
  newBranch?: string;
  forcePush?: boolean;
  message: string;
  files: ChangeFileOperation[];
}

interface CreatePullRequestOptions {
  title: string;
  body: string;
  head: string;
  base: string;
}

interface EditPullRequestOptions {
  title?: string;
  body?: string;
  labels?: number[];
}

interface CreateReleaseOptions {
  tagName: string;
  target: string;
  name?: string;
  body: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface FilesResponse {
  commit: {
    sha: string;
  };
}

const PAGE_SIZE = 50;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export class GiteaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GiteaApiError';
  }
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class GiteaClient {
  private readonly repositoryPath: string;
  private readonly dispatcher?: Dispatcher;

  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    owner: string,
    repo: string,
    proxyServer?: string,
  ) {
    this.repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    if (proxyServer) this.dispatcher = new ProxyAgent(proxyServer);
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T | null> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `token ${this.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'gitea-release-please-action',
          },
          signal: AbortSignal.timeout(30_000),
        };
        if (this.dispatcher) requestInit.dispatcher = this.dispatcher;
        if (options.body !== undefined) requestInit.body = JSON.stringify(options.body);
        response = await fetch(url, requestInit);
      } catch (error) {
        if (attempt < 2) {
          await delay(250 * 2 ** attempt);
          continue;
        }
        throw new Error(
          `Gitea API request failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (response.status === 404 && options.allowNotFound) return null;
      if (!response.ok) {
        if (attempt < 2 && RETRYABLE_STATUS.has(response.status)) {
          await delay(250 * 2 ** attempt);
          continue;
        }
        const responseText = (await response.text()).slice(0, 1_000);
        const safeText = responseText.split(this.token).join('[REDACTED]');
        throw new GiteaApiError(
          response.status,
          `Gitea API ${method} ${path} failed with ${response.status}${
            safeText ? `: ${safeText}` : ''
          }`,
        );
      }

      if (response.status === 204) return null;
      const text = await response.text();
      return text === '' ? null : (JSON.parse(text) as T);
    }

    throw new Error('Internal error: exhausted Gitea API retry loop.');
  }

  private async listAll<T>(
    path: string,
    query: Record<string, boolean | number | string | undefined> = {},
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 1_000; page += 1) {
      const items =
        (await this.request<T[]>('GET', path, {
          query: { ...query, page, limit: PAGE_SIZE },
        })) ?? [];
      all.push(...items);
      if (items.length < PAGE_SIZE) return all;
    }
    throw new Error(`Gitea API pagination exceeded 1000 pages for ${path}.`);
  }

  async getRepository(): Promise<Repository> {
    const repository = await this.request<Repository>('GET', this.repositoryPath);
    if (!repository) throw new Error('Gitea returned an empty repository response.');
    return repository;
  }

  async getAuthenticatedUser(): Promise<AuthenticatedUser> {
    const user = await this.request<AuthenticatedUser>('GET', '/user');
    if (!user?.login) throw new Error('Gitea returned an empty authenticated user response.');
    return user;
  }

  async listForks(): Promise<Repository[]> {
    return this.listAll<Repository>(`${this.repositoryPath}/forks`);
  }

  async createFork(): Promise<Repository> {
    const repository = await this.request<Repository>(
      'POST',
      `${this.repositoryPath}/forks`,
      { body: {} },
    );
    if (!repository) throw new Error('Gitea returned an empty fork response.');
    return repository;
  }

  async listCommits(branch: string, includeFiles = false): Promise<RepositoryCommit[]> {
    return this.listAll<RepositoryCommit>(`${this.repositoryPath}/commits`, {
      sha: branch,
      stat: false,
      verification: false,
      files: includeFiles,
    });
  }

  async getBranch(branch: string): Promise<RepositoryBranch | null> {
    return this.request<RepositoryBranch>(
      'GET',
      `${this.repositoryPath}/branches/${encodeURIComponent(branch)}`,
      { allowNotFound: true },
    );
  }

  async createBranch(branch: string, oldRef: string): Promise<RepositoryBranch> {
    const created = await this.request<RepositoryBranch>(
      'POST',
      `${this.repositoryPath}/branches`,
      { body: { new_branch_name: branch, old_ref_name: oldRef } },
    );
    if (!created) throw new Error('Gitea returned an empty branch response.');
    return created;
  }

  async updateBranch(
    branch: string,
    newCommitId: string,
    oldCommitId?: string,
  ): Promise<void> {
    await this.request(
      'PUT',
      `${this.repositoryPath}/branches/${encodeURIComponent(branch)}`,
      {
        body: {
          new_commit_id: newCommitId,
          force: true,
          ...(oldCommitId ? { old_commit_id: oldCommitId } : {}),
        },
      },
    );
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.request(
      'DELETE',
      `${this.repositoryPath}/branches/${encodeURIComponent(branch)}`,
      { allowNotFound: true },
    );
  }

  async listTags(): Promise<RepositoryTag[]> {
    return this.listAll<RepositoryTag>(`${this.repositoryPath}/tags`);
  }

  async getTag(tagName: string): Promise<RepositoryTag | null> {
    return this.request<RepositoryTag>(
      'GET',
      `${this.repositoryPath}/tags/${encodeURIComponent(tagName)}`,
      { allowNotFound: true },
    );
  }

  async createTag(tagName: string, target: string): Promise<RepositoryTag> {
    const tag = await this.request<RepositoryTag>('POST', `${this.repositoryPath}/tags`, {
      body: { tag_name: tagName, target },
    });
    if (!tag) throw new Error('Gitea returned an empty tag response.');
    return tag;
  }

  async listPullRequests(state: 'open' | 'closed'): Promise<PullRequest[]> {
    return this.listAll<PullRequest>(`${this.repositoryPath}/pulls`, {
      state,
      sort: 'recentupdate',
    });
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const pullRequest = await this.request<PullRequest>(
      'GET',
      `${this.repositoryPath}/pulls/${number}`,
    );
    if (!pullRequest) throw new Error('Gitea returned an empty pull request response.');
    return pullRequest;
  }

  async listPullRequestFiles(number: number): Promise<PullRequestChangedFile[]> {
    return this.listAll<PullRequestChangedFile>(
      `${this.repositoryPath}/pulls/${number}/files`,
    );
  }

  async updatePullRequestBranch(
    number: number,
    style: 'merge' | 'rebase' = 'rebase',
  ): Promise<void> {
    await this.request(
      'POST',
      `${this.repositoryPath}/pulls/${number}/update`,
      { query: { style } },
    );
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest> {
    const pullRequest = await this.request<PullRequest>(
      'POST',
      `${this.repositoryPath}/pulls`,
      { body: options },
    );
    if (!pullRequest) throw new Error('Gitea returned an empty pull request response.');
    return pullRequest;
  }

  async editPullRequest(
    number: number,
    options: EditPullRequestOptions,
  ): Promise<PullRequest> {
    const pullRequest = await this.request<PullRequest>(
      'PATCH',
      `${this.repositoryPath}/pulls/${number}`,
      { body: options },
    );
    if (!pullRequest) throw new Error('Gitea returned an empty pull request response.');
    return pullRequest;
  }

  async getContent(path: string, ref: string): Promise<RepositoryContent | null> {
    return this.request<RepositoryContent>(
      'GET',
      `${this.repositoryPath}/contents/${encodePath(path)}`,
      { query: { ref }, allowNotFound: true },
    );
  }

  async getTextContent(path: string, ref: string): Promise<string | null> {
    const content = await this.getContent(path, ref);
    if (!content) return null;
    if (content.content === undefined) {
      throw new Error(`Repository path ${path} is not a file.`);
    }
    if (content.encoding !== 'base64') {
      throw new Error(`Unsupported content encoding ${content.encoding} for ${path}.`);
    }
    return Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8');
  }

  async listFiles(ref: string): Promise<string[]> {
    const files: string[] = [];
    const pending = [''];
    while (pending.length > 0) {
      const directory = pending.pop() ?? '';
      const suffix = directory === '' ? '/contents' : `/contents/${encodePath(directory)}`;
      const entries = await this.request<RepositoryContent[] | RepositoryContent>(
        'GET',
        `${this.repositoryPath}${suffix}`,
        { query: { ref } },
      );
      if (!entries) continue;
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (entry.type === 'dir') pending.push(entry.path);
        else files.push(entry.path);
        if (files.length + pending.length > 10_000) {
          throw new Error('Repository contains too many paths to expand extra-files globs.');
        }
      }
    }
    return files.sort();
  }

  async changeFiles(options: ChangeFilesOptions): Promise<string> {
    const body: Record<string, unknown> = {
      branch: options.branch,
      message: options.message,
      files: options.files.map((file) => ({
        ...file,
        content:
          file.content === undefined
            ? undefined
            : Buffer.from(file.content, 'utf8').toString('base64'),
      })),
    };
    if (options.newBranch) body.new_branch = options.newBranch;
    if (options.forcePush !== undefined) body.force_push = options.forcePush;

    const response = await this.request<FilesResponse>(
      'POST',
      `${this.repositoryPath}/contents`,
      { body },
    );
    if (!response?.commit.sha) throw new Error('Gitea returned an empty files response.');
    return response.commit.sha;
  }

  async getReleaseByTag(tagName: string): Promise<RepositoryRelease | null> {
    return this.request<RepositoryRelease>(
      'GET',
      `${this.repositoryPath}/releases/tags/${encodeURIComponent(tagName)}`,
      { allowNotFound: true },
    );
  }

  async createRelease(options: CreateReleaseOptions): Promise<RepositoryRelease> {
    const release = await this.request<RepositoryRelease>(
      'POST',
      `${this.repositoryPath}/releases`,
      {
        body: {
          tag_name: options.tagName,
          target_commitish: options.target,
          name: options.name ?? options.tagName,
          body: options.body,
          draft: options.draft ?? false,
          prerelease: options.prerelease ?? false,
        },
      },
    );
    if (!release) throw new Error('Gitea returned an empty release response.');
    return release;
  }

  async listLabels(): Promise<RepositoryLabel[]> {
    return this.listAll<RepositoryLabel>(`${this.repositoryPath}/labels`);
  }

  async createLabel(name: string, color: string): Promise<RepositoryLabel> {
    const label = await this.request<RepositoryLabel>(
      'POST',
      `${this.repositoryPath}/labels`,
      { body: { name, color, description: 'Managed by Gitea Release Please.' } },
    );
    if (!label) throw new Error('Gitea returned an empty label response.');
    return label;
  }
}
