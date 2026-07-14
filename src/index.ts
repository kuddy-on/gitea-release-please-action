import * as core from '@actions/core';

import {
  initializeOutputs,
  loadConfig,
  loadRepositoryConfig,
  writeOutputs,
} from './config.js';
import { GiteaClient } from './gitea-client.js';
import { PublishManager } from './publish-manager.js';
import { resolveReleaseHead } from './release-head.js';
import { ReleaseManager } from './release-manager.js';
import type { PrepareResult } from './types.js';

const logger = {
  debug: core.debug,
  info: core.info,
  warning: core.warning,
};

export async function run(): Promise<void> {
  initializeOutputs();
  try {
    const baseConfig = loadConfig();
    const client = new GiteaClient(
      baseConfig.apiUrl,
      baseConfig.token,
      baseConfig.owner,
      baseConfig.repo,
      baseConfig.proxyServer,
    );
    const repository = await client.getRepository();
    const targetBranch = baseConfig.targetBranch ?? repository.default_branch;
    if (!targetBranch) throw new Error('The repository has no default branch.');
    const loadedConfig = await loadRepositoryConfig(client, baseConfig, targetBranch);
    const config = {
      ...loadedConfig,
      targetBranch: loadedConfig.targetBranch ?? targetBranch,
    };
    const head = await resolveReleaseHead(client, config, logger);

    const release = config.skipGiteaRelease
      ? null
      : await new PublishManager(client, config, logger, head).run();
    const prepare: PrepareResult = config.skipGiteaPullRequest
      ? { prCreated: false, prUpdated: false }
      : await new ReleaseManager(client, config, logger, undefined, head).run();
    writeOutputs(release, prepare);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void run();
