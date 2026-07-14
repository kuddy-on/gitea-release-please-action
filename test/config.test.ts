import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyRepositoryConfig, loadConfig } from '../src/config.js';

const INPUT_NAMES = [
  'INPUT_TOKEN',
  'INPUT_GITEA-URL',
  'INPUT_REPOSITORY',
  'INPUT_PATH',
  'INPUT_PROXY-SERVER',
  'INPUT_TAG-PREFIX',
  'INPUT_INCLUDE-V-IN-TAG',
  'INPUT_EXTRA-FILES',
  'INPUT_EXCLUDE-PATHS',
  'INPUT_SKIP-GITHUB-RELEASE',
  'INPUT_SKIP-GITHUB-PULL-REQUEST',
];
const originalInputs = new Map(INPUT_NAMES.map((name) => [name, process.env[name]]));

describe('action configuration', () => {
  beforeEach(() => {
    process.env.INPUT_TOKEN = 'test-token';
    process.env['INPUT_GITEA-URL'] = 'https://gitea.example';
    process.env.INPUT_REPOSITORY = 'acme/demo';
    delete process.env['INPUT_TAG-PREFIX'];
    delete process.env.INPUT_PATH;
    delete process.env['INPUT_PROXY-SERVER'];
    delete process.env['INPUT_INCLUDE-V-IN-TAG'];
    delete process.env['INPUT_EXTRA-FILES'];
    delete process.env['INPUT_EXCLUDE-PATHS'];
    delete process.env['INPUT_SKIP-GITHUB-RELEASE'];
    delete process.env['INPUT_SKIP-GITHUB-PULL-REQUEST'];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of originalInputs) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('uses Google-compatible single-package defaults', () => {
    expect(loadConfig()).toMatchObject({
      releaseType: 'simple',
      path: '.',
      initialVersion: '1.0.0',
      tagPrefix: 'v',
      versionFile: 'version.txt',
      labels: ['autorelease: pending'],
      releaseLabels: ['autorelease: tagged'],
    });
  });

  it('accepts a single package path from the action input', () => {
    process.env.INPUT_PATH = 'packages/api/';
    expect(loadConfig().path).toBe('packages/api');

    process.env.INPUT_PATH = '../api';
    expect(() => loadConfig()).toThrow('repository-relative directory');
  });

  it('supports both include-v-in-tag false and an explicitly empty tag prefix', () => {
    process.env['INPUT_INCLUDE-V-IN-TAG'] = 'false';
    expect(loadConfig().tagPrefix).toBe('');

    process.env['INPUT_TAG-PREFIX'] = '';
    expect(loadConfig().tagPrefix).toBe('');
  });

  it('normalizes Google-compatible proxy-server input', () => {
    process.env['INPUT_PROXY-SERVER'] = 'proxy.example:8080';
    expect(loadConfig().proxyServer).toBe('http://proxy.example:8080/');

    process.env['INPUT_PROXY-SERVER'] = 'socks://proxy.example:1080';
    expect(() => loadConfig()).toThrow('must use http or https');
  });

  it('parses extra file configurations including globs', () => {
    process.env['INPUT_EXTRA-FILES'] = JSON.stringify([
      { type: 'toml', path: 'pyproject.toml', jsonpath: '$.project.version' },
      { type: 'json', path: 'packages/*.json', jsonpath: '$.version', glob: true },
    ]);

    expect(loadConfig().extraFiles).toEqual([
      { type: 'toml', path: 'pyproject.toml', jsonpath: '$.project.version' },
      { type: 'json', path: 'packages/*.json', jsonpath: '$.version', glob: true },
    ]);
  });

  it('parses commit exclusion paths', () => {
    process.env['INPUT_EXCLUDE-PATHS'] = JSON.stringify(['docs/', 'examples']);
    expect(loadConfig().excludePaths).toEqual(['docs', 'examples']);
  });

  it('rejects extra files that conflict with generated release files', () => {
    process.env['INPUT_EXTRA-FILES'] = JSON.stringify(['CHANGELOG.md']);
    expect(() => loadConfig()).toThrow('conflicts with a release file');
  });

  it('loads official root package configuration while retaining action defaults', () => {
    const configured = applyRepositoryConfig(
      loadConfig(),
      JSON.stringify({
        'include-v-in-tag': false,
        'pull-request-header': 'Custom header',
        packages: {
          '.': {
            'release-type': 'simple',
            'initial-version': '2.0.0',
            'extra-files': [
              { type: 'json', path: 'package.json', jsonpath: '$.version' },
            ],
            'exclude-paths': ['docs'],
          },
        },
      }),
    );

    expect(configured).toMatchObject({
      initialVersion: '2.0.0',
      tagPrefix: '',
      pullRequestHeader: 'Custom header',
      extraFiles: [{ type: 'json', path: 'package.json', jsonpath: '$.version' }],
      excludePaths: ['docs'],
    });
  });

  it('loads one non-root package without treating it as a monorepo', () => {
    const configured = applyRepositoryConfig(
      loadConfig(),
      JSON.stringify({
        'include-v-in-tag': false,
        packages: {
          'packages/api': {
            'release-type': 'simple',
            'version-file': 'VERSION',
          },
        },
      }),
    );

    expect(configured).toMatchObject({
      path: 'packages/api',
      versionFile: 'VERSION',
      tagPrefix: '',
    });
  });

  it('rejects monorepo and non-simple release configuration', () => {
    const base = loadConfig();
    expect(() =>
      applyRepositoryConfig(
        base,
        JSON.stringify({ packages: { '.': {}, 'packages/api': {} } }),
      ),
    ).toThrow('Exactly one package');
    expect(() =>
      applyRepositoryConfig(base, JSON.stringify({ 'release-type': 'node' })),
    ).toThrow('Only release-type simple');
  });
});
