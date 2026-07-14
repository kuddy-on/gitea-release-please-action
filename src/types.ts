export interface ActionConfig {
  token: string;
  apiUrl: string;
  webUrl: string;
  proxyServer?: string;
  fork: boolean;
  owner: string;
  repo: string;
  configFile?: string;
  manifestFile: string;
  targetBranch?: string;
  path: string;
  releaseType: 'simple';
  initialVersion: string;
  tagPrefix: string;
  includeVInReleaseName: boolean;
  changelogPath: string;
  changelogHost: string;
  releaseNotesPath: string;
  extraFiles: ExtraFile[];
  excludePaths: string[];
  bootstrapSha?: string;
  lastReleaseSha?: string;
  releaseAs?: string;
  versioningStrategy: VersioningStrategy;
  bumpMinorPreMajor: boolean;
  bumpPatchForMinorPreMajor: boolean;
  prereleaseType?: string;
  draft: boolean;
  prerelease: boolean;
  draftPullRequest: boolean;
  skipGiteaRelease: boolean;
  skipGiteaPullRequest: boolean;
  skipLabeling: boolean;
  skipChangelog: boolean;
  labels: string[];
  releaseLabels: string[];
  extraLabels: string[];
  pullRequestTitlePattern: string;
  pullRequestHeader: string;
  pullRequestFooter: string;
  signoff?: string;
  changelogSections: ChangelogSection[];
  includeCommitAuthors: boolean;
  dateFormat: string;
  alwaysUpdate: boolean;
}

export type ExtraFile =
  | { type: 'generic'; path: string; glob?: boolean }
  | { type: 'json'; path: string; jsonpath: string; glob?: boolean }
  | { type: 'toml'; path: string; jsonpath: string; glob?: boolean }
  | { type: 'yaml'; path: string; jsonpath: string; glob?: boolean }
  | { type: 'xml'; path: string; xpath: string; glob?: boolean };

export type VersioningStrategy =
  | 'default'
  | 'always-bump-patch'
  | 'always-bump-minor'
  | 'always-bump-major'
  | 'prerelease';

export interface ChangelogSection {
  type: string;
  section: string;
  hidden?: boolean;
}

export interface Repository {
  default_branch: string;
  html_url: string;
  full_name?: string;
  parent?: {
    full_name?: string;
  };
}

export interface AuthenticatedUser {
  login: string;
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
  author?: {
    username?: string;
    full_name?: string;
  };
  files?: PullRequestChangedFile[];
}

export interface RepositoryTag {
  name: string;
  commit: CommitMeta;
}

export interface PullRequestBranch {
  ref: string;
  sha: string;
  repo?: {
    full_name: string;
  };
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
  content?: string;
  encoding?: string;
  path: string;
  sha: string;
  type?: 'dir' | 'file' | 'symlink' | 'submodule';
}

export interface RepositoryRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  upload_url?: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface PullRequestChangedFile {
  filename: string;
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
  hidden?: boolean;
  releaseAs?: string;
  author?: string;
}

export type VersionBump = 'major' | 'minor' | 'patch';

export interface ReleaseCandidate {
  version: string;
  tagName: string;
  previousTag?: string;
  changes: ParsedChange[];
  changelog: string;
  releaseNotes: string;
  files: Record<string, string>;
}

export interface ReleaseMarker {
  schema: 1 | 2;
  path?: string;
  version: string;
  tagName: string;
  targetBranch: string;
  targetHeadSha?: string;
  changelogPath?: string;
  releaseNotesPath: string;
  manifestPath?: string;
  fileHashes: Record<string, string>;
}

export interface PrepareResult {
  prCreated: boolean;
  prUpdated: boolean;
  prNumber?: number;
  pullRequest?: PullRequestOutput;
}

export interface PublishResult {
  releaseCreated: boolean;
  releaseId: number;
  releaseName: string;
  draft: boolean;
  tagName: string;
  version: string;
  sha: string;
  releaseUrl: string;
  uploadUrl: string;
  body: string;
  prNumber: number;
  path: string;
}

export interface PullRequestOutput {
  headBranchName: string;
  baseBranchName: string;
  number: number;
  mergeCommitOid?: string;
  title: string;
  body: string;
  labels: string[];
  files: string[];
  sha?: string;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
}
