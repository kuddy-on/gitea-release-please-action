import * as core from '@actions/core';
import semver from 'semver';

import { parseExtraFiles } from './extra-files.js';
import type { GiteaClient } from './gitea-client.js';
import { addPath, normalizePackagePath, ROOT_PROJECT_PATH } from './repository-path.js';
import type {
  ActionConfig,
  ChangelogSection,
  PrepareResult,
  PublishResult,
  VersioningStrategy,
} from './types.js';

const OUTPUT_NAMES = [
  'release_created',
  'releases_created',
  'paths_released',
  'prs_created',
  'pr',
  'prs',
  'upload_url',
  'html_url',
  'tag_name',
  'version',
  'major',
  'minor',
  'patch',
  'sha',
  'body',
  'id',
  'name',
  'path',
  'prNumber',
  'draft',
  // Backwards-compatible prepare aliases.
  'pr_created',
  'pr_updated',
  'pr_number',
] as const;

const DEFAULT_CHANGELOG_SECTIONS: ChangelogSection[] = [
  { type: 'feat', section: 'Features' },
  { type: 'fix', section: 'Bug Fixes' },
  { type: 'perf', section: 'Performance Improvements' },
  { type: 'deps', section: 'Dependencies' },
  { type: 'revert', section: 'Reverts' },
  { type: 'chore', section: 'Miscellaneous Chores', hidden: true },
  { type: 'docs', section: 'Documentation', hidden: true },
  { type: 'style', section: 'Styles', hidden: true },
  { type: 'refactor', section: 'Code Refactoring', hidden: true },
  { type: 'test', section: 'Tests', hidden: true },
  { type: 'build', section: 'Build System', hidden: true },
  { type: 'ci', section: 'Continuous Integration', hidden: true },
];

const VERSIONING_STRATEGIES = new Set<VersioningStrategy>([
  'default',
  'always-bump-patch',
  'always-bump-minor',
  'always-bump-major',
  'prerelease',
]);

function inputEnvironmentName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

function optionalInput(name: string): string | undefined {
  const value = core.getInput(name).trim();
  return value === '' ? undefined : value;
}

function requiredInput(name: string): string {
  return core.getInput(name, { required: true }).trim();
}

function inputWithDefault(
  name: string,
  defaultValue: string,
  env: NodeJS.ProcessEnv,
): string {
  return env[inputEnvironmentName(name)]?.trim() ?? defaultValue;
}

function hasInput(name: string, env: NodeJS.ProcessEnv): boolean {
  return Object.hasOwn(env, inputEnvironmentName(name));
}

function booleanValue(name: string, value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function booleanInput(
  name: string,
  defaultValue: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  return booleanValue(name, env[inputEnvironmentName(name)], defaultValue);
}

function normalizeUrls(rawUrl: string): { apiUrl: string; webUrl: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid Gitea URL: ${rawUrl}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The Gitea URL must use http or https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('The Gitea URL must not contain credentials.');
  }

  url.search = '';
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  const hasApiSuffix = path.endsWith('/api/v1');
  const webPath = hasApiSuffix ? path.slice(0, -'/api/v1'.length) : path;
  const apiPath = hasApiSuffix ? path : `${path}/api/v1`;

  const web = new URL(url.toString());
  web.pathname = webPath || '/';
  const api = new URL(url.toString());
  api.pathname = apiPath;

  return {
    apiUrl: api.toString().replace(/\/$/, ''),
    webUrl: web.toString().replace(/\/$/, ''),
  };
}

function normalizeProxyServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    throw new Error(`Invalid proxy-server: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('proxy-server must use http or https.');
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('proxy-server must not contain a path, query, or fragment.');
  }
  return url.toString();
}

function parseRepository(value: string): { owner: string; repo: string } {
  const parts = value.split('/').filter(Boolean);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository ${value}; expected owner/name.`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function validatePath(name: string, value: unknown): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const normalized = value.replace(/^\.\//, '');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`${name} must be a repository-relative path.`);
  }
  return normalized;
}

function validateVersion(name: string, value: unknown): string {
  if (typeof value !== 'string' || semver.valid(value) !== value) {
    throw new Error(`${name} must be a full SemVer: ${String(value)}`);
  }
  return value;
}

function validateSha(name: string, value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new Error(`${name} must be a 7-64 character hexadecimal commit SHA.`);
  }
  return value;
}

function parseLabels(name: string, value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (typeof value !== 'string') throw new Error(`${name} must be a comma-separated string.`);
  return [...new Set(value.split(',').map((label) => label.trim()).filter(Boolean))];
}

function parsePaths(name: string, value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${name} must be a valid JSON array of paths.`, { cause: error });
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be an array of paths.`);
  return [
    ...new Set(
      parsed.map((path, index) =>
        validatePath(`${name}[${index}]`, path).replace(/\/+$/, ''),
      ),
    ),
  ];
}

function parseChangelogSections(value: unknown): ChangelogSection[] {
  if (value === undefined) return DEFAULT_CHANGELOG_SECTIONS.map((section) => ({ ...section }));
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error('changelog-sections must be a valid JSON array.', { cause: error });
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('changelog-sections must be a non-empty array.');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`changelog-sections[${index}] must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.type !== 'string' || item.type.trim() === '') {
      throw new Error(`changelog-sections[${index}].type must be a non-empty string.`);
    }
    if (typeof item.section !== 'string' || item.section.trim() === '') {
      throw new Error(`changelog-sections[${index}].section must be a non-empty string.`);
    }
    const section: ChangelogSection = {
      type: item.type.trim().toLowerCase(),
      section: item.section.trim(),
    };
    if (item.hidden !== undefined) {
      section.hidden = booleanValue(`changelog-sections[${index}].hidden`, item.hidden, false);
    }
    return section;
  });
}

function validateVersioning(value: unknown): VersioningStrategy {
  if (typeof value !== 'string' || !VERSIONING_STRATEGIES.has(value as VersioningStrategy)) {
    throw new Error(
      `versioning must be one of ${[...VERSIONING_STRATEGIES].join(', ')}.`,
    );
  }
  return value as VersioningStrategy;
}

function checkConfig(config: ActionConfig): void {
  const generatedPaths = new Set([
    addPath(config.path, config.changelogPath),
    addPath(config.path, config.releaseNotesPath),
    config.manifestFile,
  ]);
  if (generatedPaths.size !== 3) {
    throw new Error(
      'changelog-path, release-notes-path, and manifest-file must be different files.',
    );
  }
  for (const extraFile of config.extraFiles) {
    if (generatedPaths.has(addPath(config.path, extraFile.path))) {
      throw new Error(`extra-files path ${extraFile.path} conflicts with a release file.`);
    }
  }
  if (!config.skipLabeling && (config.labels.length === 0 || config.releaseLabels.length === 0)) {
    throw new Error('label and release-label must not be empty unless skip-labeling is true.');
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ActionConfig {
  const token = requiredInput('token');
  core.setSecret(token);

  const serverUrl =
    optionalInput('gitea-url') ?? env.GITEA_SERVER_URL ?? env.GITHUB_SERVER_URL;
  if (!serverUrl) {
    throw new Error(
      'Missing Gitea URL. Set gitea-url or run inside Gitea Actions with GITEA_SERVER_URL.',
    );
  }
  const repository =
    optionalInput('repository') ??
    optionalInput('repo-url') ??
    env.GITEA_REPOSITORY ??
    env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error(
      'Missing repository. Set repository or run inside Gitea Actions with GITEA_REPOSITORY.',
    );
  }

  const releaseType = optionalInput('release-type') ?? 'simple';
  if (releaseType !== 'simple') {
    throw new Error('Only release-type simple is supported by this Gitea-compatible build.');
  }
  const initialVersion = validateVersion(
    'initial-version',
    optionalInput('initial-version') ?? '1.0.0',
  );
  const releaseAsInput = optionalInput('release-as');
  const prereleaseType = optionalInput('prerelease-type');
  if (optionalInput('version-file')) {
    throw new Error(
      'version-file is no longer supported; use manifest-file and extra-files.',
    );
  }
  const includeV = booleanInput('include-v-in-tag', true, env);
  const tagPrefix = hasInput('tag-prefix', env)
    ? inputWithDefault('tag-prefix', '', env)
    : includeV
      ? 'v'
      : '';

  const config: ActionConfig = {
    token,
    ...normalizeUrls(serverUrl),
    ...parseRepository(repository),
    fork: booleanInput('fork', false, env),
    manifestFile: validatePath(
      'manifest-file',
      optionalInput('manifest-file') ?? '.release-please-manifest.json',
    ),
    path: normalizePackagePath(optionalInput('path') ?? ROOT_PROJECT_PATH),
    releaseType: 'simple',
    initialVersion,
    tagPrefix,
    includeVInReleaseName: booleanInput('include-v-in-release-name', true, env),
    changelogPath: validatePath(
      'changelog-path',
      optionalInput('changelog-path') ?? 'CHANGELOG.md',
    ),
    changelogHost: optionalInput('changelog-host') ?? normalizeUrls(serverUrl).webUrl,
    releaseNotesPath: validatePath(
      'release-notes-path',
      optionalInput('release-notes-path') ?? 'RELEASE.md',
    ),
    extraFiles: parseExtraFiles(optionalInput('extra-files')),
    excludePaths: parsePaths('exclude-paths', optionalInput('exclude-paths'), []),
    versioningStrategy: validateVersioning(
      optionalInput('versioning-strategy') ?? 'default',
    ),
    bumpMinorPreMajor: booleanInput('bump-minor-pre-major', false, env),
    bumpPatchForMinorPreMajor: booleanInput(
      'bump-patch-for-minor-pre-major',
      false,
      env,
    ),
    draft: booleanInput('draft', false, env),
    prerelease: booleanInput('prerelease', false, env),
    draftPullRequest: booleanInput('draft-pull-request', false, env),
    skipGiteaRelease:
      booleanInput('skip-gitea-release', false, env) ||
      booleanInput('skip-github-release', false, env),
    skipGiteaPullRequest:
      booleanInput('skip-gitea-pull-request', false, env) ||
      booleanInput('skip-github-pull-request', false, env),
    skipLabeling: booleanInput('skip-labeling', false, env),
    skipChangelog: booleanInput('skip-changelog', false, env),
    labels: parseLabels('label', optionalInput('label'), ['autorelease: pending']),
    releaseLabels: parseLabels(
      'release-label',
      optionalInput('release-label'),
      ['autorelease: tagged'],
    ),
    extraLabels: parseLabels('extra-label', optionalInput('extra-label'), []),
    pullRequestTitlePattern:
      optionalInput('pull-request-title-pattern') ??
      'chore${scope}: release${component} ${version}',
    pullRequestHeader:
      optionalInput('pull-request-header') ?? ':robot: I have created a release *beep* *boop*',
    pullRequestFooter:
      optionalInput('pull-request-footer') ??
      'This PR was generated with [Gitea Release Please](https://github.com/kuddy-on/gitea-release-please-action).',
    changelogSections: parseChangelogSections(optionalInput('changelog-sections')),
    includeCommitAuthors: booleanInput('include-commit-authors', false, env),
    dateFormat: optionalInput('date-format') ?? '%Y-%m-%d',
    alwaysUpdate: booleanInput('always-update', false, env),
  };

  const configFile = optionalInput('config-file');
  const targetBranch = optionalInput('target-branch');
  const bootstrapSha = validateSha('bootstrap-sha', optionalInput('bootstrap-sha'));
  const lastReleaseSha = validateSha(
    'last-release-sha',
    optionalInput('last-release-sha'),
  );
  const signoff = optionalInput('signoff');
  const proxyServer = optionalInput('proxy-server');
  if (signoff && !/^.+\s<[^<>\s]+@[^<>\s]+>$/.test(signoff)) {
    throw new Error('signoff must use the format Name <email@example.com>.');
  }
  if (config.prerelease && config.versioningStrategy !== 'prerelease') {
    throw new Error('prerelease: true requires versioning-strategy prerelease.');
  }

  if (configFile) config.configFile = validatePath('config-file', configFile);
  if (targetBranch) config.targetBranch = targetBranch;
  if (bootstrapSha) config.bootstrapSha = bootstrapSha;
  if (lastReleaseSha) config.lastReleaseSha = lastReleaseSha;
  if (releaseAsInput) config.releaseAs = validateVersion('release-as', releaseAsInput);
  if (prereleaseType) config.prereleaseType = prereleaseType;
  if (signoff) config.signoff = signoff;
  if (proxyServer) {
    if (proxyServer.includes('@')) core.setSecret(proxyServer);
    config.proxyServer = normalizeProxyServer(proxyServer);
  }
  checkConfig(config);
  return config;
}

type RepositoryConfigApi = Pick<GiteaClient, 'getTextContent'>;

function configObject(
  raw: string,
  defaultPath: string,
): { path: string; options: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('release-please config file contains invalid JSON.', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('release-please config file must contain a JSON object.');
  }
  const root = parsed as Record<string, unknown>;
  if (root.packages !== undefined) {
    if (!root.packages || typeof root.packages !== 'object' || Array.isArray(root.packages)) {
      throw new Error('release-please config packages must be an object.');
    }
    const packages = root.packages as Record<string, unknown>;
    const paths = Object.keys(packages);
    if (paths.length !== 1 || !paths[0]) {
      throw new Error('Exactly one package is supported.');
    }
    const packagePath = normalizePackagePath(paths[0]);
    const packageConfig = packages[paths[0]];
    if (!packageConfig || typeof packageConfig !== 'object' || Array.isArray(packageConfig)) {
      throw new Error(`packages["${paths[0]}"] must be an object.`);
    }
    const globalConfig = { ...root };
    delete globalConfig.packages;
    return {
      path: packagePath,
      options: { ...globalConfig, ...(packageConfig as Record<string, unknown>) },
    };
  }
  return { path: defaultPath, options: root };
}

function stringOption(
  raw: Record<string, unknown>,
  name: string,
  fallback: string,
): string {
  const value = raw[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  return value;
}

export function applyRepositoryConfig(
  base: ActionConfig,
  rawContent: string,
): ActionConfig {
  const parsed = configObject(rawContent, base.path);
  const raw = parsed.options;
  const releaseType = raw['release-type'] ?? base.releaseType;
  if (releaseType !== 'simple') {
    throw new Error('Only release-type simple is supported by this Gitea-compatible build.');
  }
  if (raw.plugins !== undefined) {
    throw new Error('plugins are not supported in single-package mode.');
  }
  if (raw['include-component-in-tag'] === true || raw['separate-pull-requests'] === true) {
    throw new Error('Component and multi-package release options are not supported.');
  }
  if (raw['changelog-type'] !== undefined && raw['changelog-type'] !== 'default') {
    throw new Error('Only changelog-type default is supported on Gitea.');
  }
  if (raw['version-file'] !== undefined) {
    throw new Error(
      'version-file is no longer supported; use manifest-file and extra-files.',
    );
  }

  const tagPrefix =
    raw['tag-prefix'] !== undefined
      ? stringOption(raw, 'tag-prefix', base.tagPrefix)
      : raw['include-v-in-tag'] !== undefined
        ? booleanValue('include-v-in-tag', raw['include-v-in-tag'], true)
          ? 'v'
          : ''
        : base.tagPrefix;
  const config: ActionConfig = {
    ...base,
    path: parsed.path,
    releaseType: 'simple',
    initialVersion: validateVersion(
      'initial-version',
      raw['initial-version'] ?? base.initialVersion,
    ),
    tagPrefix,
    includeVInReleaseName: booleanValue(
      'include-v-in-release-name',
      raw['include-v-in-release-name'],
      base.includeVInReleaseName,
    ),
    changelogPath: validatePath(
      'changelog-path',
      raw['changelog-path'] ?? base.changelogPath,
    ),
    changelogHost: stringOption(raw, 'changelog-host', base.changelogHost),
    releaseNotesPath: validatePath(
      'release-notes-path',
      raw['release-notes-path'] ?? base.releaseNotesPath,
    ),
    extraFiles:
      raw['extra-files'] === undefined
        ? base.extraFiles
        : parseExtraFiles(JSON.stringify(raw['extra-files'])),
    excludePaths: parsePaths('exclude-paths', raw['exclude-paths'], base.excludePaths),
    versioningStrategy: validateVersioning(
      raw.versioning ?? base.versioningStrategy,
    ),
    bumpMinorPreMajor: booleanValue(
      'bump-minor-pre-major',
      raw['bump-minor-pre-major'],
      base.bumpMinorPreMajor,
    ),
    bumpPatchForMinorPreMajor: booleanValue(
      'bump-patch-for-minor-pre-major',
      raw['bump-patch-for-minor-pre-major'],
      base.bumpPatchForMinorPreMajor,
    ),
    draft: booleanValue('draft', raw.draft, base.draft),
    prerelease: booleanValue('prerelease', raw.prerelease, base.prerelease),
    draftPullRequest: booleanValue(
      'draft-pull-request',
      raw['draft-pull-request'],
      base.draftPullRequest,
    ),
    skipGiteaRelease: booleanValue(
      'skip-gitea-release',
      raw['skip-gitea-release'] ?? raw['skip-github-release'],
      base.skipGiteaRelease,
    ),
    skipGiteaPullRequest: booleanValue(
      'skip-gitea-pull-request',
      raw['skip-gitea-pull-request'] ?? raw['skip-github-pull-request'],
      base.skipGiteaPullRequest,
    ),
    skipLabeling: booleanValue('skip-labeling', raw['skip-labeling'], base.skipLabeling),
    skipChangelog: booleanValue('skip-changelog', raw['skip-changelog'], base.skipChangelog),
    labels: parseLabels('label', raw.label, base.labels),
    releaseLabels: parseLabels('release-label', raw['release-label'], base.releaseLabels),
    extraLabels: parseLabels('extra-label', raw['extra-label'], base.extraLabels),
    pullRequestTitlePattern: stringOption(
      raw,
      'pull-request-title-pattern',
      base.pullRequestTitlePattern,
    ),
    pullRequestHeader: stringOption(raw, 'pull-request-header', base.pullRequestHeader),
    pullRequestFooter: stringOption(raw, 'pull-request-footer', base.pullRequestFooter),
    changelogSections: parseChangelogSections(
      raw['changelog-sections'] ?? base.changelogSections,
    ),
    includeCommitAuthors: booleanValue(
      'include-commit-authors',
      raw['include-commit-authors'],
      base.includeCommitAuthors,
    ),
    dateFormat: stringOption(raw, 'date-format', base.dateFormat),
    alwaysUpdate: booleanValue('always-update', raw['always-update'], base.alwaysUpdate),
  };

  const bootstrapSha = validateSha('bootstrap-sha', raw['bootstrap-sha'] ?? base.bootstrapSha);
  const lastReleaseSha = validateSha(
    'last-release-sha',
    raw['last-release-sha'] ?? base.lastReleaseSha,
  );
  const releaseAs = raw['release-as'] ?? base.releaseAs;
  const prereleaseType = raw['prerelease-type'] ?? base.prereleaseType;
  const signoff = raw.signoff ?? base.signoff;
  const targetBranch = raw['target-branch'];
  if (releaseAs !== undefined) config.releaseAs = validateVersion('release-as', releaseAs);
  if (prereleaseType !== undefined) {
    if (typeof prereleaseType !== 'string' || prereleaseType.trim() === '') {
      throw new Error('prerelease-type must be a non-empty string.');
    }
    config.prereleaseType = prereleaseType.trim();
  }
  if (signoff !== undefined) {
    if (typeof signoff !== 'string' || !/^.+\s<[^<>\s]+@[^<>\s]+>$/.test(signoff)) {
      throw new Error('signoff must use the format Name <email@example.com>.');
    }
    config.signoff = signoff;
  }
  if (targetBranch !== undefined) {
    if (typeof targetBranch !== 'string' || targetBranch.trim() === '') {
      throw new Error('target-branch must be a non-empty string.');
    }
    config.targetBranch = targetBranch.trim();
  }
  if (bootstrapSha) config.bootstrapSha = bootstrapSha;
  if (lastReleaseSha) config.lastReleaseSha = lastReleaseSha;
  if (config.prerelease && config.versioningStrategy !== 'prerelease') {
    throw new Error('prerelease: true requires versioning prerelease.');
  }
  checkConfig(config);
  return config;
}

export async function loadRepositoryConfig(
  client: RepositoryConfigApi,
  base: ActionConfig,
  ref: string,
): Promise<ActionConfig> {
  if (!base.configFile) return base;
  const content = await client.getTextContent(base.configFile, ref);
  if (content === null) {
    throw new Error(`Config file ${base.configFile} does not exist on ${ref}.`);
  }
  return applyRepositoryConfig(base, content);
}

export function initializeOutputs(): void {
  for (const name of OUTPUT_NAMES) core.setOutput(name, '');
  core.setOutput('release_created', 'false');
  core.setOutput('releases_created', 'false');
  core.setOutput('paths_released', '[]');
  core.setOutput('prs_created', 'false');
  core.setOutput('pr_created', 'false');
  core.setOutput('pr_updated', 'false');
}

export function writeOutputs(
  release: PublishResult | null,
  prepare: PrepareResult,
): void {
  if (release) {
    const version = semver.parse(release.version);
    if (!version) throw new Error(`Internal error: invalid release version ${release.version}`);
    const output = (name: string, value: unknown): void => {
      core.setOutput(release.path === ROOT_PROJECT_PATH ? name : `${release.path}--${name}`, value);
    };
    output('release_created', String(release.releaseCreated));
    core.setOutput('releases_created', String(release.releaseCreated));
    core.setOutput(
      'paths_released',
      release.releaseCreated ? JSON.stringify([release.path]) : '[]',
    );
    output('upload_url', release.uploadUrl);
    output('html_url', release.releaseUrl);
    output('tag_name', release.tagName);
    output('version', release.version);
    output('major', String(version.major));
    output('minor', String(version.minor));
    output('patch', String(version.patch));
    output('sha', release.sha);
    output('body', release.body);
    output('id', String(release.releaseId));
    output('name', release.releaseName);
    output('path', release.path);
    output('prNumber', String(release.prNumber));
    output('draft', String(release.draft));
  }

  const prsCreated = prepare.prCreated || prepare.prUpdated;
  core.setOutput('prs_created', String(prsCreated));
  core.setOutput('pr_created', String(prepare.prCreated));
  core.setOutput('pr_updated', String(prepare.prUpdated));
  if (prepare.prNumber !== undefined) core.setOutput('pr_number', String(prepare.prNumber));
  if (prepare.pullRequest) {
    core.setOutput('pr', prepare.pullRequest);
    core.setOutput('prs', JSON.stringify([prepare.pullRequest]));
  }
}
