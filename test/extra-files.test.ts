import * as toml from '@iarna/toml';
import { loadAll as loadAllYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { expandExtraFiles, parseExtraFiles, updateExtraFile } from '../src/extra-files.js';

describe('extra-files configuration', () => {
  it('uses the official generic updater for path strings', () => {
    expect(
      parseExtraFiles(
        JSON.stringify([
          'package.json',
          'pyproject.toml',
          'deployment.yaml',
          'metadata.xml',
          'src/version.ts',
        ]),
      ),
    ).toEqual([
      { type: 'generic', path: 'package.json' },
      { type: 'generic', path: 'pyproject.toml' },
      { type: 'generic', path: 'deployment.yaml' },
      { type: 'generic', path: 'metadata.xml' },
      { type: 'generic', path: 'src/version.ts' },
    ]);
  });

  it('parses explicit JSONPath and XPath configurations', () => {
    expect(
      parseExtraFiles(
        JSON.stringify([
          { type: 'toml', path: 'pyproject.toml', jsonpath: '$.project.version' },
          { type: 'json', path: 'ui/package.json', jsonpath: '$.version' },
          { type: 'xml', path: 'pom.xml', xpath: '/*/version' },
        ]),
      ),
    ).toHaveLength(3);
  });

  it('rejects malformed, duplicate, and unsafe entries', () => {
    expect(() => parseExtraFiles('{bad')).toThrow('valid JSON array');
    expect(() => parseExtraFiles(JSON.stringify(['package.json', './package.json']))).toThrow(
      'duplicate path package.json',
    );
    expect(() => parseExtraFiles(JSON.stringify(['../package.json']))).toThrow(
      'repository-relative path',
    );
    expect(() =>
      parseExtraFiles(JSON.stringify([{ type: 'toml', path: 'pyproject.toml' }])),
    ).toThrow('jsonpath');
    expect(() =>
      parseExtraFiles(
        JSON.stringify([{ type: 'json', path: '*.json', jsonpath: '$.version', glob: 'yes' }]),
      ),
    ).toThrow('glob must be true or false');
  });

  it('expands single and recursive globs without duplicate paths', () => {
    const configured = parseExtraFiles(
      JSON.stringify([
        { type: 'json', path: 'packages/*.json', jsonpath: '$.version', glob: true },
        { type: 'generic', path: 'src/**/version.ts', glob: true },
      ]),
    );
    expect(
      expandExtraFiles(configured, [
        'packages/a.json',
        'packages/nested/b.json',
        'src/version.ts',
        'src/lib/version.ts',
      ]).map((file) => file.path),
    ).toEqual(['packages/a.json', 'src/version.ts', 'src/lib/version.ts']);
    expect(() =>
      expandExtraFiles(configured, ['packages/a.json', 'src/other.ts']),
    ).toThrow('matched no repository files');
  });
});

describe('extra-files updaters', () => {
  it('updates generic inline and block markers', () => {
    const content = [
      "export const VERSION = '1.2.3'; // x-release-please-version",
      '// x-release-please-start-major',
      'export const MAJOR = 1;',
      '// x-release-please-end',
      '',
    ].join('\n');

    expect(
      updateExtraFile({ type: 'generic', path: 'src/version.ts' }, content, '2.4.6', '2026-07-14'),
    ).toBe(
      [
        "export const VERSION = '2.4.6'; // x-release-please-version",
        '// x-release-please-start-major',
        'export const MAJOR = 2;',
        '// x-release-please-end',
        '',
      ].join('\n'),
    );
  });

  it('updates generic dates using the configured format', () => {
    expect(
      updateExtraFile(
        { type: 'generic', path: 'version.txt' },
        'Released 2025/01/02 // x-release-please-date\n',
        '2.4.6',
        '2026/07/14',
        '%Y/%m/%d',
      ),
    ).toBe('Released 2026/07/14 // x-release-please-date\n');
  });

  it('updates every JSONPath match while preserving an embedded prefix', () => {
    const content = '{\n  "packages": [{"version": "v1.2.3"}, {"version": "1.2.3"}]\n}\n';
    const updated = updateExtraFile(
      { type: 'json', path: 'versions.json', jsonpath: '$.packages[*].version' },
      content,
      '2.0.0',
      '2026-07-14',
    );

    expect(JSON.parse(updated)).toEqual({
      packages: [{ version: 'v2.0.0' }, { version: '2.0.0' }],
    });
    expect(updated.endsWith('\n')).toBe(true);
  });

  it('updates a pyproject.toml project version', () => {
    const updated = updateExtraFile(
      { type: 'toml', path: 'pyproject.toml', jsonpath: '$.project.version' },
      '[project]\nname = "demo"\nversion = "1.2.3"\n',
      '1.3.0',
      '2026-07-14',
    );

    expect(toml.parse(updated)).toMatchObject({ project: { name: 'demo', version: '1.3.0' } });
  });

  it('updates all matching YAML documents', () => {
    const updated = updateExtraFile(
      { type: 'yaml', path: 'deployment.yaml', jsonpath: '$.app.version' },
      '---\napp:\n  version: 1.0.0\n---\napp:\n  version: 1.0.0\n',
      '1.1.0',
      '2026-07-14',
    );

    expect(loadAllYaml(updated)).toEqual([
      { app: { version: '1.1.0' } },
      { app: { version: '1.1.0' } },
    ]);
  });

  it('updates every matching XML node', () => {
    const updated = updateExtraFile(
      { type: 'xml', path: 'versions.xml', xpath: '/project/version' },
      '<project><version>1.0.0</version></project>\n',
      '1.1.0',
      '2026-07-14',
    );

    expect(updated).toBe('<project><version>1.1.0</version></project>\n');
  });

  it('fails instead of silently leaving a configured file stale', () => {
    expect(() =>
      updateExtraFile(
        { type: 'generic', path: 'version.txt' },
        'version=1.0.0\n',
        '1.1.0',
        '2026-07-14',
      ),
    ).toThrow('contains no x-release-please');
    expect(() =>
      updateExtraFile(
        { type: 'json', path: 'package.json', jsonpath: '$.missing' },
        '{"version":"1.0.0"}',
        '1.1.0',
        '2026-07-14',
      ),
    ).toThrow('matched no values');
  });
});
