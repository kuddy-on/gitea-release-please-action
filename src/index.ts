import * as core from '@actions/core';

import { initializeOutputs, loadConfig, writeOutputs } from './config.js';
import { GiteaClient } from './gitea-client.js';
import { ReleaseManager } from './release-manager.js';

export async function run(): Promise<void> {
  initializeOutputs();
  try {
    const config = loadConfig();
    const client = new GiteaClient(config.apiUrl, config.token, config.owner, config.repo);
    const manager = new ReleaseManager(client, config, {
      debug: core.debug,
      info: core.info,
      warning: core.warning,
    });
    const result = await manager.run();
    writeOutputs(result);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void run();
