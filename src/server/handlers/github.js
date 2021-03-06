import url from 'url';
import { normalize } from 'normalizr';

import { repoList } from './schema';
import logging from '../logging';
import requestGitHub from '../helpers/github';
import { conf } from '../helpers/config';
import { getMemcached } from '../helpers/memcached';
import { internalGetSnapcraftYaml } from './launchpad';
import { parseGitHubRepoUrl } from '../../common/helpers/github-url';
import { PreparedError } from '../helpers/prepared-error';
import { getGitHubRootSecret, makeWebhookSecret } from './webhook';

const logger = logging.getLogger('express');
const SNAPCRAFT_INFO_WHITELIST = ['name', 'confinement'];

const RESPONSE_NOT_FOUND = {
  status: 'error',
  payload: {
    code: 'github-repository-not-found',
    message: 'The GitHub repository cannot be found or access not granted to account'
  }
};

const RESPONSE_AUTHENTICATION_FAILED = {
  status: 'error',
  payload: {
    code: 'github-authentication-failed',
    message: 'Authentication with GitHub failed'
  }
};

const RESPONSE_CREATED = {
  status: 'success',
  payload: {
    code: 'github-webhook-created',
    message: 'GitHub webhook successfully created'
  }
};

const RESPONSE_ALREADY_CREATED = {
  status: 'success',
  payload: {
    code: 'github-already-created',
    message: 'A webhook already exists on the given repository'
  }
};

const RESPONSE_OTHER_ERROR = {
  status: 'error',
  payload: {
    code: 'github-error-other',
    message: 'Something went wrong when calling GitHub API'
  }
};

export const checkGitHubStatus = (response, notFoundError = RESPONSE_NOT_FOUND) => {
  if (response.statusCode !== 200) {
    let body = response.body;
    if (typeof body !== 'object') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        logger.error('Invalid JSON received', e, body);
        throw new PreparedError(500, RESPONSE_OTHER_ERROR);
      }
    }
    switch (body.message) {
      case 'Not Found':
      case 'This repository is empty.':
        // repo or snapcraft.yaml not found
        throw new PreparedError(404, notFoundError);
      case 'Bad credentials':
        // Authentication failed
        throw new PreparedError(401, RESPONSE_AUTHENTICATION_FAILED);
      default:
        // Something else
        logger.error('GitHub API error:', response.statusCode, body);
        throw new PreparedError(response.statusCode, RESPONSE_OTHER_ERROR);
    }
  }
  return response;
};

export const requestUser = (token) => {
  return requestGitHub.get('/user', { token, json: true });
};

export const getUser = async (req, res) => {
  if (!req.session || !req.session.token) {
    return res.status(401).send(RESPONSE_AUTHENTICATION_FAILED);
  }

  const response = await requestUser(req.session.token);
  if (response.statusCode !== 200) {
    return res.status(response.statusCode).send({
      status: 'error',
      payload: {
        code: 'github-user-error',
        message: response.body.message
      }
    });
  }

  res.status(response.statusCode).send({
    status: 'success',
    payload: {
      code: 'github-user',
      user: response.body
    }
  });
};

// memcached cache id helper
export const listOrganizationsCacheId = (owner) => `organizations:${owner}`;

export const internalListOrganizations = async (owner, token) => {
  const cacheId = listOrganizationsCacheId(owner);

  try {
    const result = await getMemcached().get(cacheId);
    if (result !== undefined) {
      return result;
    }
  } catch (error) {
    logger.error(`Error getting ${cacheId} from memcached: ${error}`);
  }

  try {
    const response = await requestGitHub.get('/user/orgs', {
      token, json: true
    });
    await checkGitHubStatus(response, {
      status: 'error',
      payload: {
        code: 'github-orgs-not-found',
        message: 'Cannot access user organizations'
      }
    });
    await getMemcached().set(cacheId, response.body, 3600);
    return response.body;
  } catch (error) {
    logger.error(`Error getting list of organizations from GitHub: ${error}`);
    return [];
  }
};

export const refreshOrganizations = async (req, res) => {
  if (!req.session || !req.session.token) {
    return res.status(401).send(RESPONSE_AUTHENTICATION_FAILED);
  }

  const owner = req.query.owner;

  // Make sure organization information is fetched again, since
  // permissions may have changed
  const orgsCacheID = listOrganizationsCacheId(owner);
  await getMemcached().del(orgsCacheID);

  const orgs = await internalListOrganizations(owner, req.session.token);

  // update orgs in session
  if (req.session.user) {
    req.session.user.orgs = orgs;
  }

  return res.status(200).send({
    status: 'success',
    orgs
  });
};

// memcached cache id helper
export const getSnapcraftYamlCacheId = (repositoryUrl) => `snapcraft_data:${repositoryUrl}`;

export const getSnapcraftData = async (repositoryUrl, token) => {
  const { owner, name } = parseGitHubRepoUrl(repositoryUrl);
  const cacheId = getSnapcraftYamlCacheId(repositoryUrl);

  try {
    const result = await getMemcached().get(cacheId);
    if (result !== undefined) {
      return result;
    }
  } catch (error) {
    logger.error(`Error getting ${cacheId} from memcached: ${error}`);
  }

  const snapcraftYaml = await internalGetSnapcraftYaml(owner, name, token);
  const snapcraftData = {};

  if (snapcraftYaml.contents) {
    for (const index of Object.keys(snapcraftYaml.contents)) {
      if (SNAPCRAFT_INFO_WHITELIST.indexOf(index) >= 0) {
        snapcraftData[index] = snapcraftYaml.contents[index];
      }
    }
  }

  // copy snapcraft.yaml path from repo into snapcraftData
  //
  // XXX we are mixing our custom `path` into data from snapcraft.yaml file
  // currently there is no `path` defined in snapcraft syntax
  // https://snapcraft.io/docs/build-snaps/syntax
  // and also we whitelist only `name`, so no collision should occur
  snapcraftData.path = snapcraftYaml.path;

  // if there was parse error include it as well
  snapcraftData.error = snapcraftYaml.error;
  await getMemcached().set(cacheId, snapcraftData, 3600);
  return snapcraftData;
};

export const listRepositories = async (req, res) => {
  const params = {
    affiliation: 'owner,organization_member'
  };

  if (!req.session || !req.session.token) {
    return res.status(401).send(RESPONSE_AUTHENTICATION_FAILED);
  }

  if (req.query.page) {
    params.page = req.query.page;
  }

  const uri = url.format({ pathname: '/user/repos', query: params });
  const response = await requestGitHub.get(uri, {
    token: req.session.token, json: true
  });
  if (response.statusCode !== 200) {
    return res.status(response.statusCode).send({
      status: 'error',
      payload: {
        code: 'github-list-repositories-error',
        message: response.body.message
      }
    });
  }

  const body = {
    status: 'success',
    code: 'github-list-repositories',
    ...normalize(response.body, repoList)
  };

  if (response.headers.link) {
    body.pageLinks = parseLinkHeader(response.headers.link);
  }

  return res.status(response.statusCode).send(body);
};

export const createWebhook = async (req, res) => {
  const { owner, name } = req.body;
  let secret;

  try {
    secret = makeWebhookSecret(getGitHubRootSecret(), owner, name);
  } catch (e) {
    return res.status(500).send({
      status: 'error',
      payload: {
        code: 'github-unconfigured',
        message: e.message
      }
    });
  }

  const uri = `/repos/${owner}/${name}/hooks`;
  const options = getRequest(owner, name, req.session.token, secret);
  try {
    const response = await requestGitHub.post(uri, options);
    if (response.statusCode !== 201) {
      logger.info(response.body);
      switch (response.body.message) {
        case 'Not Found':
          // Repository does not exist or access not granted
          return res.status(404).send(RESPONSE_NOT_FOUND);
        case 'Bad credentials':
          // Authentication failed
          return res.status(401).send(RESPONSE_AUTHENTICATION_FAILED);
        case 'Validation Failed':
          // Webhook already created
          return res.status(200).send(RESPONSE_ALREADY_CREATED);
        default:
          // Something else
          logger.error('GitHub API error', response.statusCode);
          return res.status(500).send(RESPONSE_OTHER_ERROR);
      }
    }

    return res.status(201).send(RESPONSE_CREATED);
  } catch (error) {
    logger.error('GitHub API error', error);
    return res.status(500).send(error.message);
  }
};

// memcached cache id helper
export const getDefaultBranchCacheId = (repositoryUrl) => `default_branch:${repositoryUrl}`;

export const getDefaultBranch = async (repositoryUrl, token) => {
  const { owner, name } = parseGitHubRepoUrl(repositoryUrl);
  const cacheId = getDefaultBranchCacheId(repositoryUrl);

  try {
    const result = await getMemcached().get(cacheId);
    if (result !== undefined) {
      return result;
    }
  } catch (error) {
    logger.error(`Error getting ${cacheId} from memcached: ${error}`);
  }

  const response = await requestGitHub.get(`/repos/${owner}/${name}`, {
    token, json: true
  });
  await checkGitHubStatus(response);
  await getMemcached().set(cacheId, response.body.default_branch, 3600);
  return response.body.default_branch;
};

const getRequest = (owner, name, token, secret) => {
  return {
    token,
    json: {
      name: 'web',
      active: true,
      events: [
        'push'
      ],
      config: {
        url: `${conf.get('BASE_URL')}/${owner}/${name}/webhook/notify`,
        content_type: 'json',
        secret
      }
    }
  };
};

/*
 * parse_link_header()
 *
 * Parse the Github Link HTTP header used for pageination
 * http://developer.github.com/v3/#pagination
 *
 * Modified by kfenn to return page numbers instead of urls
 */
const parseLinkHeader = (header) => {
  if (header.length == 0) {
    throw new Error('input must not be of zero length');
  }

  // Split parts by comma
  let parts = header.split(',');
  let links = {};
  // Parse each part into a named link
  for (let index=0; index<parts.length; index++) {
    let section = parts[index].split(';');
    if (section.length != 2) {
      throw new Error('section could not be split on ";"');
    }
    let number = parseInt(url.parse(section[0], true).query.page);
    let name = section[1].replace(/rel="(.*)"/, '$1').trim();
    links[name] = number;
  }

  return links;
};
