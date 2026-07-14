import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';

const INPUT_NAMES = ['INPUT_TOKEN', 'INPUT_GITEA-URL', 'INPUT_REPOSITORY', 'INPUT_TAG-PREFIX'];
const originalInputs = new Map(INPUT_NAMES.map((name) => [name, process.env[name]]));

describe('action configuration', () => {
  beforeEach(() => {
    process.env.INPUT_TOKEN = 'test-token';
    process.env['INPUT_GITEA-URL'] = 'https://gitea.example';
    process.env.INPUT_REPOSITORY = 'acme/demo';
    delete process.env['INPUT_TAG-PREFIX'];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of originalInputs) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('defaults the tag prefix to v when the input is absent', () => {
    expect(loadConfig().tagPrefix).toBe('v');
  });

  it('preserves an explicitly empty tag prefix', () => {
    process.env['INPUT_TAG-PREFIX'] = '';

    expect(loadConfig().tagPrefix).toBe('');
  });
});
