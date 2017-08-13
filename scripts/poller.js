import 'babel-polyfill';

import logging from '../server/logging';
import db from '../server/db';
import { processRepository } from '../common/helpers/poller';


const logger = logging.getLogger('poller');
logger.info('GitHub Repository Poller ...');


let repoDB = db.model('Repository');
repoDB.fetchAll().then(function (results) {
  logger.info(`Iterating over ${results.length} repositories.`);
  results.models.forEach(processRepository);
});
