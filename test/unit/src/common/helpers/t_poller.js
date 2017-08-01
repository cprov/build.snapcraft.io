import expect, { assert } from 'expect';
import nock from 'nock';

import {
  checkSnapRepository,
  extractPartsToPoll,
  hasRepoChanged
} from '../../../../../src/common/helpers/poller';
import { conf } from '../../../../../src/server/helpers/config';


describe('Poller helpers', function() {
  afterEach(function() {
    nock.cleanAll();
  });

  describe('hasRepoChanged', function() {
    let ghApi;

    beforeEach(function() {
      ghApi = nock(conf.get('GITHUB_API_ENDPOINT'));
    });

    afterEach(function() {
      ghApi.done();
    });

    context('when there are changes', function() {
      const repositoryUrl = 'https://github.com/anowner/aname';

      beforeEach(function() {
        ghApi
          .get(/\/repos\/anowner\/aname\/commits\?since=2017-08-03T12%3A13%3A20\.000Z.*/)
          .reply(200, [ { sha: 'something' } ]);
      });

      it('returns true', async function() {
        const last_updated_at = 1501762400000;
        const changed = await hasRepoChanged(repositoryUrl, last_updated_at);
        expect(changed).toBe(true);
      });
    });

    context('when there are no changes', function() {
      const repositoryUrl = 'https://github.com/anowner/aname';

      beforeEach(function() {
        ghApi
          .get(/\/repos\/anowner\/aname\/commits\?since=.*/)
          .reply(200, []);
      });

      it('returns false', async function() {
        const last_updated_at = 1501762400000;
        const changed = await hasRepoChanged(repositoryUrl, last_updated_at);
        expect(changed).toBe(false);
      });
    });

    context('when repository lookup fails', function() {
      const repositoryUrl = 'https://github.com/anowner/aname';

      beforeEach(function() {
        ghApi
          .get(/\/repos\/anowner\/aname\/commits\?since=.*/)
          .reply(404, { message: 'Not Found' });
      });

      it('raises an error', async function() {
        try {
          const last_updated_at = 1501762400000;
          const changed = await hasRepoChanged(repositoryUrl, last_updated_at);
          assert(false, 'Expected error; got %s instead', changed);
        } catch (error) {
          expect(error.message).toBe(`${repositoryUrl} (404): Not Found`);
        }
      });
    });

    context('when last_updated_at is missing', function() {
      const repositoryUrl = 'https://github.com/anowner/aname';

      it('raises an error', async function() {
        try {
          const changed = await hasRepoChanged(repositoryUrl);
          assert(false, 'Expected error; got %s instead', changed);
        } catch (error) {
          expect(error.message).toBe('`last_updated_at` must be given.');
        }
      });
    });

    context('when last_updated_at is empty', function() {
      const repositoryUrl = 'https://github.com/anowner/aname';

      it('raises an error', async function() {
        try {
          const changed = await hasRepoChanged(repositoryUrl, '');
          assert(false, 'Expected error; got %s instead', changed);
        } catch (error) {
          expect(error.message).toBe('`last_updated_at` must be given.');
        }
      });
    });

  });

  describe('checkSnapRepository', function() {
    let ghApi;

    beforeEach(function() {
      ghApi = nock(conf.get('GITHUB_API_ENDPOINT'));
    });

    afterEach(function() {
      ghApi.done();
    });

    context('when there are changes in the snap repository', function() {

      beforeEach(function() {
        ghApi
          .get(/\/repos\/anowner\/aname\/commits.*/)
          .reply(200, [ { sha: 'some_sha' } ]);
      });

      it('returns true', async function() {
        const needs_build = await checkSnapRepository('anowner', 'aname', 1501762400000);
        expect(needs_build).toBe(true);
      });
    });

    context('when there are changes only in a part repository', function() {

      beforeEach(function() {
        ghApi
          .get(/\/repos\/anowner\/aname\/commits.*/)
          .reply(200, []);
        ghApi
          .get(/\/repos\/anowner\/aname\/contents.*/)
          .reply(200, 'parts:\n  foo:\n    source-type: git\n    ' +
                      'source: https://github.com/some/part.git');
        ghApi
          .get(/\/repos\/some\/part\/commits.*/)
          .reply(200, [ { sha: 'some-sha' } ]);

      });

      it('returns true', async function() {
        const needs_build = await checkSnapRepository('anowner', 'aname', 1501762400000);
        expect(needs_build).toBe(true);
      });
    });

    context('when there are no changes', function() {

      beforeEach(function() {
        ghApi
          .get(/\/repos\/anowner\/aname\/commits.*/)
          .reply(200, []);
        ghApi
          .get(/\/repos\/anowner\/aname\/contents.*/)
          .reply(200, 'parts:\n  foo:\n    source-type: git\n    ' +
                      'source: https://github.com/some/part.git');
        ghApi
          .get(/\/repos\/some\/part\/commits.*/)
          .reply(200, []);

      });

      it('returns false', async function() {
        const needs_build = await checkSnapRepository('anowner', 'aname', 1501762400000);
        expect(needs_build).toBe(false);
      });
    });

    context('when the snap branch is missing snapcraft.yaml', function() {

      beforeEach(function() {
        ghApi
          .get(/\/repos\/anowner\/aname\/commits.*/)
          .reply(200, []);
        ghApi
          .get(/\/repos\/anowner\/aname\/contents.*/)
          .reply(404, {});
      });

      it('returns false', async function() {
        const needs_build = await checkSnapRepository('anowner', 'aname', 1501762400000);
        expect(needs_build).toBe(false);
      });
    });


  });

  context('extractPartsToPoll', () => {

    it('copes with missing parts', () => {
      const snapcraft_yaml = {};
      const parts = extractPartsToPoll(snapcraft_yaml);
      expect(parts).toEqual([]);
    });

    it('copes with missing source-type', () => {
      const snapcraft_yaml = {
        parts: {
          simple: {
            source: 'https://github.com/foo/bar.git'
          }
        }
      };
      const parts = extractPartsToPoll(snapcraft_yaml);
      expect(parts).toEqual(['https://github.com/foo/bar.git']);
    });

    it('only extracts GH repos', () => {
      const snapcraft_yaml = {
        parts: {
          'gh': {
            'source': 'https://github.com/foo/bar.git'
          },
          'non-gh': {
            'source': 'https://code.launchpad.net/foo/bar.git'
          },
          'non-git': {
            'source': 'https://code.launchpad.net/foo/bar'
          },
          'gh-2': {
            'source': 'https://github.com/foo/zoing.git'
          }
        }
      };
      const parts = extractPartsToPoll(snapcraft_yaml);
      expect(parts).toEqual([
        'https://github.com/foo/bar.git',
        'https://github.com/foo/zoing.git'
      ]);
    });

    it('returns unique repos', () => {
      const snapcraft_yaml = {
        parts: {
          'gh': {
            'source': 'https://github.com/foo/bar.git'
          },
          'gh-2': {
            'source': 'https://github.com/foo/bar.git'
          }
        }
      };
      const parts = extractPartsToPoll(snapcraft_yaml);
      expect(parts).toEqual(['https://github.com/foo/bar.git']);
    });

  });
});
