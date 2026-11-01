import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { allSources, computeRecordDates, loadRecords, recordDates } from '../src/db.ts';
import { dependencyNewlyApplies, goingAwayLine, modelGoingAway, newRecordCount, newRecordCountFrom, weeklyLine } from '../src/weekly.ts';

const records = [
  { source: 'npm', released: '2026-10-30' },
  { source: 'npm', released: null, updated: '2026-10-25' },
  { source: 'npm', released: '2026-10-24' },
  { source: 'npm', released: '2026-11-01' },
];

describe('newRecordCount', () => {
  it('counts the 7 days up to and including the date, from released or else updated', () => {
    assert.equal(newRecordCount(records, '2026-10-31'), 2);
  });
});

describe('counting by date, so a due check needn\'t read every record', () => {
  it('db/record-dates.json is what the database holds today', () => {
    assert.deepEqual(recordDates(), computeRecordDates());
  });

  it('gives the same count as reading every record, at any date', () => {
    const records = loadRecords(allSources());
    const { dates } = recordDates();
    for (const asOf of ['2026-10-31', '2026-10-01', '2026-09-07', '2026-11-05', '2025-01-01']) assert.equal(newRecordCountFrom(dates, asOf), newRecordCount(records, asOf), asOf);
  });
});

describe('weeklyLine', () => {
  it('says what it knows when nothing applies, and never that the new things were checked', () => {
    assert.equal(weeklyLine(0, 1234), 'keepup: no model you use shuts down in the next 30 days · 1,234 new or updated this week · /keepup to check them');
  });

  it('counts changes and names the command', () => {
    assert.equal(weeklyLine(1, 1234), 'keepup: 1 new change applies · 1,234 new or updated this week · /keepup');
    assert.equal(weeklyLine(2, 7), 'keepup: 2 new changes apply · 7 new or updated this week · /keepup');
  });

  it('names the nearest shutdown when there is one, so a quiet line is never false', () => {
    assert.equal(weeklyLine(0, 5, { model: 'gpt-4o-mini', effective: '2027-01-14' }), 'keepup: gpt-4o-mini shuts down 14 Jan 2027 · 5 new or updated this week · /keepup');
    assert.equal(weeklyLine(0, 5, { model: 'gemini-a', effective: '2027-03-15', earliest: true }), 'keepup: gemini-a shuts down no earlier than 15 Mar 2027 · 5 new or updated this week · /keepup');
  });
});

describe('dependencyNewlyApplies', () => {
  const asOf = '2026-10-31';
  const check = (over: object) => ({ status: 'behind' as const, latest: '4.0.0', latest_date: '2026-10-30', ...over });

  it('counts a new major from this week that the declared range does not allow', () => {
    assert.equal(dependencyNewlyApplies(check({}), asOf), true);
  });

  it('skips a patch, an older release, and a range that already allows it', () => {
    assert.equal(dependencyNewlyApplies(check({ latest: '4.1.2' }), asOf), false);
    assert.equal(dependencyNewlyApplies(check({ latest_date: '2026-10-01' }), asOf), false);
    assert.equal(dependencyNewlyApplies(check({ status: 'allowed-by-range' }), asOf), false);
  });
});

describe('a model going away', () => {
  const live = [{ file: 'a', line: 1, text: 'x', context: 'code' as const, commented: false, route: 'direct' as const }];
  const check = (over: object) => ({ live_places: live, status: 'retiring' as const, effective: '2026-11-30', ...over });

  it('within 30 days, or already gone, counts; further off does not', () => {
    assert.equal(modelGoingAway(check({}), '2026-11-01'), true);
    assert.equal(modelGoingAway(check({ effective: '2027-02-26' }), '2026-11-01'), false);
    assert.equal(modelGoingAway(check({ status: 'retired', effective: '2026-06-01' }), '2026-11-01'), true);
    assert.equal(modelGoingAway(check({ live_places: [] }), '2026-11-01'), false);
    assert.equal(modelGoingAway(check({ status: 'deprecated', effective: null, routed_to: 'x' }), '2026-11-01'), false, 'auto-routed isn\'t going away');
  });

  it('says the date, so someone can act on it', () => {
    assert.equal(goingAwayLine([{ model: 'm', status: 'retiring', effective: '2026-11-30' }]), 'keepup: 1 model you use shuts down 30 Nov · /keepup');
    assert.equal(goingAwayLine([{ model: 'm', status: 'retired', effective: '2026-06-01' }]), 'keepup: 1 model you use is already shut down · /keepup');
    assert.equal(goingAwayLine([{ model: 'a', status: 'retired', effective: '2026-06-01' }, { model: 'b', status: 'retiring', effective: '2026-11-30' }]), 'keepup: 2 models you use are shut down or go by 30 Nov · /keepup');
  });
});
