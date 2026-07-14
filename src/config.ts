import * as core from '@actions/core';
import semver from 'semver';

import type { ActionConfig, ActionResult } from './types.js';

const OUTPUT_NAMES = [
  'pr_created',
  'pr_updated',
  'pr_number',
  'release_created',
  'tag_name',
  'version',
  'major',
  'minor',
  'patch',
  'sha',
  'release_url',
  'body',
] as const;

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
  const environmentName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return env[environmentName]?.trim() ?? defaultValue;
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

function parseRepository(value: string): { owner: string; repo: string } {
  const parts = value.split('/').filter(Boolean);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository ${value}; expected owner/name.`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function validatePath(name: string, value: string): string {
  const normalized = value.replace(/^\.\//, '');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`${name} must be a repository-relative path.`);
  }
  return normalized;
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
    optionalInput('repository') ?? env.GITEA_REPOSITORY ?? env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error(
      'Missing repository. Set repository or run inside Gitea Actions with GITEA_REPOSITORY.',
    );
  }

  const initialVersionInput = optionalInput('initial-version') ?? '0.1.0';
  const initialVersion = semver.valid(initialVersionInput);
  if (!initialVersion || initialVersion !== initialVersionInput) {
    throw new Error(`initial-version must be a full stable SemVer: ${initialVersionInput}`);
  }

  const bootstrapSha = optionalInput('bootstrap-sha');
  if (bootstrapSha && !/^[0-9a-f]{7,64}$/i.test(bootstrapSha)) {
    throw new Error('bootstrap-sha must be a 7-64 character hexadecimal commit SHA.');
  }

  const urls = normalizeUrls(serverUrl);
  const parsedRepository = parseRepository(repository);
  const config: ActionConfig = {
    token,
    ...urls,
    ...parsedRepository,
    initialVersion,
    tagPrefix: inputWithDefault('tag-prefix', 'v', env),
    changelogPath: validatePath(
      'changelog-path',
      optionalInput('changelog-path') ?? 'CHANGELOG.md',
    ),
    releaseNotesPath: validatePath(
      'release-notes-path',
      optionalInput('release-notes-path') ?? 'RELEASE.md',
    ),
  };

  if (config.changelogPath === config.releaseNotesPath) {
    throw new Error('changelog-path and release-notes-path must be different files.');
  }

  const targetBranch = optionalInput('target-branch');
  if (targetBranch) config.targetBranch = targetBranch;
  if (bootstrapSha) config.bootstrapSha = bootstrapSha;
  return config;
}

export function initializeOutputs(): void {
  for (const name of OUTPUT_NAMES) core.setOutput(name, '');
  core.setOutput('pr_created', 'false');
  core.setOutput('pr_updated', 'false');
  core.setOutput('release_created', 'false');
}

export function writeOutputs(result: ActionResult): void {
  core.setOutput('pr_created', String(result.prCreated));
  core.setOutput('pr_updated', String(result.prUpdated));
  core.setOutput('release_created', String(result.releaseCreated));

  if (result.prNumber !== undefined) core.setOutput('pr_number', String(result.prNumber));
  if (result.tagName) core.setOutput('tag_name', result.tagName);
  if (result.sha) core.setOutput('sha', result.sha);
  if (result.releaseUrl) core.setOutput('release_url', result.releaseUrl);
  if (result.body) core.setOutput('body', result.body);
  if (result.version) {
    const version = semver.parse(result.version);
    if (!version) throw new Error(`Internal error: invalid release version ${result.version}`);
    core.setOutput('version', result.version);
    core.setOutput('major', String(version.major));
    core.setOutput('minor', String(version.minor));
    core.setOutput('patch', String(version.patch));
  }
}
