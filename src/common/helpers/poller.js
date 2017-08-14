import moment from 'moment';

import logging from '../../server/logging';
import { conf } from '../../server/helpers/config';
import {
  getGitHubRepoUrl,
  parseGitHubRepoUrl
} from './github-url';
import requestGitHub from '../../server/helpers/github';
import { internalGetSnapcraftYaml } from '../../server/handlers/launchpad';

const gh_repo_prefix = conf.get('GITHUB_REPOSITORY_PREFIX');
const logger = logging.getLogger('poller');


// Extracts unique GH repository URLs from a given (parsed) snapcraft.yaml
export function extractPartsToPoll(snapcraft_yaml) {
  const parts = Object.values(snapcraft_yaml.parts || {});
  const sourceParts = parts.map(GitSourcePart.fromSnapcraftPart).filter(part => part != undefined);
  return Array.from(new Set(sourceParts));
}


// Whether a given (GitHub) repository has new commits since 'last_updated_at'.
export const hasRepoChanged = async (repositoryUrl, last_updated_at, token) => {
  if (last_updated_at === undefined || !last_updated_at) {
    throw new Error('`last_updated_at` must be given.');
  }
  const last_updated = moment(last_updated_at);
  const since = last_updated.toISOString();
  const { owner, name } = parseGitHubRepoUrl(repositoryUrl);
  const uri = `/repos/${owner}/${name}/commits?since=${since}`;
  const options = {
    token,
    headers: {
      'If-Modified-Since': last_updated.format('ddd, MM MMM YYYY HH:mm:ss [GMT]')
    },
    json: true
  };

  const response = await requestGitHub.get(uri, options);

  switch (response.statusCode) {
    case 200:
      // If the (JSON encoded) body is not an empty list.
      return response.body.length > 0;
    case 304:
      // `If-Modified-Since` in action, cache hit, no changes.
      return false;
    default:
      // Bail, unexpected response.
      throw new Error(
        `${repositoryUrl} (${response.statusCode}): ${response.body.message}`);
  }
};


// Whether a given snap (GitHub) repository has changed since 'last_updated_at'.
// Consider changes in the repository itself as well as any of the (GitHub)
// parts source.
export const checkSnapRepository = async (owner, name, last_updated_at) => {
  const token = conf.get('GITHUB_AUTH_CLIENT_TOKEN');
  const repo_url = getGitHubRepoUrl(owner, name);
  if (await hasRepoChanged(repo_url, last_updated_at, token)) {
    logger.info(`The ${owner}/${name} repository has changed.`);
    return true;
  }
  logger.info(`${owner}/${name}: unchanged, checking parts ...`);

  let snapcraft_yaml;
  try {
    snapcraft_yaml = await internalGetSnapcraftYaml(owner, name, token);
  } catch (e) {
    return false;
  }
  for (const source_part of extractPartsToPoll(snapcraft_yaml.contents)) {
    logger.info(`${owner}/${name}: Checking whether $${source_part.repoUrl} part has changed.`);
    if (await source_part.hasRepoChangedSince(last_updated_at, token)) {
      logger.info(`${owner}/${name}: ${source_part.repoUrl} changed.`);
      return true;
    }
  }
  return false;
};


// XXX: meh no ES6 import support, great library :-/
let AsyncLock = require('async-lock');
let processRepoLock = new AsyncLock();

// Process a given Repository (DB) model. Check for changes using
// `checkSnapRepository` and if changed request a LP snap build and mark
// it as 'updated'.
export const processRepository = (repo) => {
  processRepoLock.acquire('PROCESS-REPO-SYNC', async () => {
    const owner = repo.get('owner');
    const name = repo.get('name');
    const last_updated_at = repo.get('updated_at');

    logger.info(`${owner}/${name}: Polling ...`);
    try {
      if (await checkSnapRepository(owner, name, last_updated_at)) {
        logger.info(`${owner}/${name}: NEEDSBUILD`);
        // XXX request build and reset repo.updated_at.
      } else {
        logger.info(`${owner}/${name}: UNCHANGED`);
      }
    } catch (e) {
      logger.error(`${owner}/${name}: FAILED (${e.message})`);
    }
    logger.info('==========');
  });
};


/// GitSourcePart encapsulates the relevant information from a snapcraft
/// source part, and contains the methods to determine whether it's up to
/// date.
export class GitSourcePart {

  constructor(repoUrl, branch, tag) {
    if (repoUrl === undefined) {
      throw new Error('Required parameter: repoUrl');
    }
    if (branch === undefined) {
      branch = 'master';
    }
    this.repoUrl = repoUrl;
    this.branch = branch;
    this.tag = tag;
  }

  /** Extract a GitSourcePart from a snapcraft part definition.
   *
   * Returns a GitSourcePart instance if the source part meets the following
   * criteria:
   *
   * - The source part has a source repository listed, and it's a github
   *   hosted repository
   */
  static fromSnapcraftPart(part) {
    // TODO: Warn if source-commit or source-subdir are set, since we don't
    //       support these.
    // TODO: Not sure if we can support setting tags _and_ branch in the same
    //       part.
    if (part.source == undefined) {
      logger.info('Skipping part with no source set.');
    } else if (part.source.startsWith(gh_repo_prefix)) {
      var sourceUrl = part['source'];
      var sourceBranch = part['source-branch'];
      var sourceTag = part['source-tag'];
      // TODO: figure out tag support:
      if (sourceTag) {
        logger.info(
          `Not checking ${sourceUrl} with tag ${sourceTag} since tags are not supported`);
        return;
      }
      return new GitSourcePart(sourceUrl, sourceBranch, sourceTag);
    } else {
      logger.info(
        `Not checking ${part.source} as only github repos are supported`);
    }
  }

  /** Determine if the source part has changed since `last_updated_at`
   *
   */
  async hasRepoChangedSince(last_updated_at, token) {
    if (last_updated_at === undefined || !last_updated_at) {
      throw new Error('`last_updated_at` must be given.');
    }
    const last_updated = moment(last_updated_at);
    const since = last_updated.toISOString();
    const { owner, name } = parseGitHubRepoUrl(this.repoUrl);

    const options = {
      token,
      headers: {
        'If-Modified-Since': last_updated.format('ddd, MM MMM YYYY HH:mm:ss [GMT]')
      },
      json: true
    };

    if (this.branch === 'master' && this.tag == undefined) {
      // check master branch, no tag.
      const uri = `/repos/${owner}/${name}/commits?since=${since}`;
      const response = await requestGitHub.get(uri, options);

      switch (response.statusCode) {
        case 200:
          // If the (JSON encoded) body is not an empty list.
          return response.body.length > 0;
        case 304:
          // `If-Modified-Since` in action, cache hit, no changes.
          return false;
        default:
          // Bail, unexpected response.
          throw new Error(
            `${this.repoUrl} (${response.statusCode}): ${response.body.message}`);
      }
    }
    else if (this.tag == undefined) {
      // check custom branch, no tag.
      const uri = `/repos/${owner}/${name}/branches/${this.branch}`;
      const response = await requestGitHub.get(uri, options);

      switch (response.statusCode) {
        case 200: {
          // Check the branch modification time. The GH API is kind of crazy
          // here:
          const date_string = response.body.commit.commit.committer.date;
          const branch_date = moment(date_string);
          return branch_date.isAfter(last_updated);
        }
        case 304:
          // `If-Modified-Since` in action, cache hit, no changes.
          // TODO: This doesn't seem to work with the branches API.
          return false;
        default:
          // Bail, unexpected response.
          throw new Error(
            `${this.repoUrl} (${response.statusCode}): ${response.body.message}`);
      }
    } else {
      // check tag:
      // TODO: How the hell do we support tags?
    }
  }

}
