export interface ActionConfig {
  token: string;
  apiUrl: string;
  webUrl: string;
  owner: string;
  repo: string;
  targetBranch?: string;
  initialVersion: string;
  tagPrefix: string;
  changelogPath: string;
  releaseNotesPath: string;
  bootstrapSha?: string;
}

export interface Repository {
  default_branch: string;
  html_url: string;
}

export interface RepositoryBranch {
  name: string;
  commit: {
    id: string;
    message: string;
  };
}

export interface CommitMeta {
  sha: string;
  url?: string;
}

export interface RepositoryCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
  };
  parents: CommitMeta[];
}

export interface RepositoryTag {
  name: string;
  commit: CommitMeta;
}

export interface PullRequestBranch {
  ref: string;
  sha: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  html_url: string;
  merged: boolean;
  merged_at?: string;
  merge_commit_sha?: string;
  merge_base?: string;
  head: PullRequestBranch;
  base: PullRequestBranch;
  labels?: RepositoryLabel[];
}

export interface RepositoryContent {
  content: string;
  encoding: string;
  path: string;
  sha: string;
}

export interface RepositoryRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
}

export interface RepositoryLabel {
  id: number;
  name: string;
  color: string;
}

export type ChangeFileOperation = {
  operation: 'create' | 'update' | 'delete';
  path: string;
  content?: string;
  sha?: string;
};

export interface ParsedChange {
  sha: string;
  url: string;
  type: string;
  scope: string | null;
  subject: string;
  breaking: boolean;
  breakingNotes: string[];
}

export type VersionBump = 'major' | 'minor' | 'patch';

export interface ReleaseCandidate {
  version: string;
  tagName: string;
  previousTag?: string;
  changes: ParsedChange[];
  changelog: string;
  releaseNotes: string;
}

export interface ReleaseMarker {
  schema: 1;
  version: string;
  tagName: string;
  targetBranch: string;
  changelogPath: string;
  releaseNotesPath: string;
  fileHashes: Record<string, string>;
}

export interface ActionResult {
  prCreated: boolean;
  prUpdated: boolean;
  prNumber?: number;
  releaseCreated: boolean;
  tagName?: string;
  version?: string;
  sha?: string;
  releaseUrl?: string;
  body?: string;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
}
