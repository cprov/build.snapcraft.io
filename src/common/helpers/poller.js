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
  const gh_parts = parts.filter(function (p) {
    return (p.source || '').startsWith(gh_repo_prefix);
  });
  const repo_urls = gh_parts.map(function (p) { return p.source; });
  return Array.from(new Set(repo_urls));
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
// Consider changes in the repository itself any of the (GitHub) parts source.
export const checkSnapRepository = async (owner, name, last_updated_at, token) => {
  const repo_url = getGitHubRepoUrl(owner, name);
  if (await hasRepoChanged(repo_url, last_updated_at, token)) {
    return true;
  }
  logger.info(`${owner}/${name}: unchanged, checking parts ...`);

  let snapcraft_yaml;
  try {
    snapcraft_yaml = await internalGetSnapcraftYaml(owner, name, token);
  } catch (e) {
    return false;
  }
  for (const repo_url of extractPartsToPoll(snapcraft_yaml.contents)) {
    if (await hasRepoChanged(repo_url, last_updated_at, token)) {
      logger.info(`${owner}/${name}: ${repo_url} changed.`);
      return true;
    }
  }
  return false;
};
