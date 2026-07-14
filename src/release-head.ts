import { GiteaApiError, GiteaClient } from './gitea-client.js';
import type { ActionConfig, Logger, Repository } from './types.js';

export interface ReleaseHead {
  client: GiteaClient;
  fullName: string;
  owner: string;
  fork: boolean;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function isExpectedFork(
  repository: Repository,
  fullName: string,
  upstream: string,
): boolean {
  return (
    repository.full_name === fullName &&
    (repository.parent?.full_name === undefined || repository.parent.full_name === upstream)
  );
}

export async function resolveReleaseHead(
  upstreamClient: GiteaClient,
  config: ActionConfig,
  logger: Logger,
  pause: (milliseconds: number) => Promise<void> = wait,
): Promise<ReleaseHead> {
  const upstream = `${config.owner}/${config.repo}`;
  if (!config.fork) {
    return {
      client: upstreamClient,
      fullName: upstream,
      owner: config.owner,
      fork: false,
    };
  }

  const user = await upstreamClient.getAuthenticatedUser();
  if (user.login === config.owner) {
    throw new Error(`fork: true cannot fork ${upstream} into the same owner.`);
  }
  const fullName = `${user.login}/${config.repo}`;
  let fork = (await upstreamClient.listForks()).find((repository) =>
    isExpectedFork(repository, fullName, upstream),
  );
  if (!fork) {
    logger.info(`Creating release pull request fork ${fullName}.`);
    try {
      const created = await upstreamClient.createFork();
      if (isExpectedFork(created, fullName, upstream)) fork = created;
    } catch (error) {
      if (!(error instanceof GiteaApiError) || error.status !== 409) throw error;
      fork = (await upstreamClient.listForks()).find((repository) =>
        isExpectedFork(repository, fullName, upstream),
      );
    }
  }
  if (!fork) {
    throw new Error(
      `Unable to create fork ${fullName}; a repository with that name may already exist.`,
    );
  }

  const forkClient = new GiteaClient(
    config.apiUrl,
    config.token,
    user.login,
    config.repo,
    config.proxyServer,
  );
  const targetBranch = config.targetBranch;
  if (!targetBranch) throw new Error('Internal error: target branch was not resolved.');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await forkClient.getBranch(targetBranch)) {
      return { client: forkClient, fullName, owner: user.login, fork: true };
    }
    await pause(1_000);
  }
  throw new Error(`Fork ${fullName} did not finish initializing within 30 seconds.`);
}
