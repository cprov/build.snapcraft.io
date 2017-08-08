import 'babel-polyfill';

import logging from '../server/logging';
import db from '../server/db';
import { conf } from '../server/helpers/config';
import { checkSnapRepository } from '../common/helpers/poller';


const logger = logging.getLogger('poller');
logger.info('GitHub Repository Poller ...');

const token = conf.get('GITHUB_AUTH_CLIENT_TOKEN');

const repoDB = db.model('Repository');
repoDB.fetchAll().then(function (results) {
  logger.info(`Iterating over ${results.length} repositories.`);
  results.models.forEach(async (repo) => {
    const owner = repo.get('owner');
    const name = repo.get('name');
    const last_updated_at = repo.get('updated_at');

    logger.info(`Polling ${owner}/${name} ...`);
    try {
      if (await checkSnapRepository(owner, name, last_updated_at, token)) {
        logger.info(`${owner}/${name}: NEEDSBUILD`);
        // XXX request build and reset repo.updated_at.
      } else {
        logger.info(`${owner}/${name}: UNCHANGED`);
      }
    } catch (e) {
      logger.error(`${owner}/${name}: FAILED (${e.message})`);
    }
  });
});
