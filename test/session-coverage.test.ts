// What the session log may call coverage. Bundles the program built and the session read are real coverage, so nobody runs
// searches to satisfy a counter, and a saved run or an older session keeps the words it was written with.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { coverageFacts, coverageHolds, coverageShortfall, logEvent, readLog, resetLog } from '../src/session.ts';

describe('the session log', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'keepup-log-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const built = () => logEvent(dir, 'bundles', 'keepup bundles', { jobs: 2, job_total: 3, patterns: 1, candidates: 30 });

  it('with no bundles, searches and reads count as they always did', () => {
    resetLog(dir);
    logEvent(dir, 'search', '{}');
    logEvent(dir, 'search', '{}');
    logEvent(dir, 'read', 'a.ts:1');
    const log = readLog(dir);
    assert.deepEqual(log, { searches: 2, reads: 1 });
    assert.equal(coverageHolds(log, 1), true);
    assert.equal(coverageHolds(log, 2), false);
    assert.deepEqual(coverageFacts(log), { searches: 2, reads: 1 });
    assert.equal(coverageShortfall(log, 2), '2 searches ran for 2 jobs, and it takes 2 for each, with at least one read');
  });

  it('holds once every job and pattern bundle was read, with no search at all', () => {
    resetLog(dir);
    built();
    logEvent(dir, 'read', 'bundles.patterns.0');
    logEvent(dir, 'read', 'bundles.jobs.0', { candidates: 10 });
    assert.equal(coverageHolds(readLog(dir), 3), false);
    assert.equal(coverageShortfall(readLog(dir), 3), '1 of 2 job bundles and 1 of 1 pattern bundles read, and it takes all of them');
    logEvent(dir, 'read', 'bundles.jobs.1', { candidates: 20 });
    const log = readLog(dir);
    assert.equal(log.searches, 0);
    assert.equal(coverageHolds(log, 3), true);
    assert.deepEqual(coverageFacts(log), { searches: 0, reads: 3, candidates: 30, jobs: 3 });
  });

  it('a pattern left unread means it does not hold, however many searches ran', () => {
    resetLog(dir);
    built();
    logEvent(dir, 'read', 'bundles.jobs.0', { candidates: 10 });
    logEvent(dir, 'read', 'bundles.jobs.1', { candidates: 20 });
    for (const _ of [1, 2, 3, 4, 5, 6, 7]) logEvent(dir, 'search', '{}');
    assert.equal(coverageHolds(readLog(dir), 3), false);
  });

  it('counts a bundle read twice once, and only what was really read as shown', () => {
    resetLog(dir);
    built();
    logEvent(dir, 'read', 'bundles.jobs.0', { candidates: 10 });
    logEvent(dir, 'read', 'bundles.jobs.0', { candidates: 10 });
    const log = readLog(dir);
    assert.equal(log.reads, 1);
    assert.equal(coverageFacts(log).candidates, 10);
  });

  it('a second keepup bundles makes new job bundles, so the old reads of them no longer count', () => {
    resetLog(dir);
    built();
    logEvent(dir, 'read', 'bundles.patterns.0');
    logEvent(dir, 'read', 'bundles.jobs.0', { candidates: 10 });
    logEvent(dir, 'read', 'bundles.jobs.1', { candidates: 20 });
    built();
    assert.equal(coverageHolds(readLog(dir), 3), false);
    assert.equal(coverageShortfall(readLog(dir), 3), '0 of 2 job bundles and 1 of 1 pattern bundles read, and it takes all of them');
  });

  it('a profile whose jobs all matched nothing compared nothing, whatever else was read', () => {
    resetLog(dir);
    logEvent(dir, 'bundles', 'keepup bundles', { jobs: 0, job_total: 2, patterns: 1, candidates: 0, unmatched: ['Write replies', 'Sort tickets'] });
    logEvent(dir, 'read', 'a.ts:1');
    logEvent(dir, 'read', 'bundles.patterns.0');
    const log = readLog(dir);
    assert.equal(coverageHolds(log, 2), false);
    assert.equal(coverageShortfall(log, 2), 'nothing in the database matched Write replies, Sort tickets, so no job bundle was built, and 1 of 1 pattern bundles read');
    assert.deepEqual(coverageFacts(log), { searches: 0, reads: 2, candidates: 0, jobs: 2 });
  });

  it('a log with no names still says no job bundle was built', () => {
    resetLog(dir);
    logEvent(dir, 'bundles', 'keepup bundles', { jobs: 0, job_total: 1, patterns: 0, candidates: 0 });
    logEvent(dir, 'read', 'a.ts:1');
    assert.equal(coverageShortfall(readLog(dir), 1), 'no job bundle was built, and 0 of 0 pattern bundles read');
  });

  it('one job matching nothing beside others that did still holds, once those are read', () => {
    resetLog(dir);
    logEvent(dir, 'bundles', 'keepup bundles', { jobs: 1, job_total: 2, patterns: 0, candidates: 5, unmatched: ['Sort tickets'] });
    logEvent(dir, 'read', 'bundles.jobs.0', { candidates: 5 });
    assert.equal(coverageHolds(readLog(dir), 2), true);
  });
});
