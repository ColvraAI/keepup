import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { allowsVersion, compareVersions, lowestVersionIn, majorsBehind, specKind } from '../src/semver.ts';

describe('allowsVersion', () => {
  const cases: [string, 'npm' | 'crates' | 'pypi', string, boolean][] = [
    ['^1.24.3', 'npm', '1.32.2', true],
    ['^1.24.3', 'npm', '2.0.0', false],
    ['~5.4.0', 'npm', '5.4.9', true],
    ['~5.4.0', 'npm', '5.5.0', false],
    ['^2.14.0', 'npm', '2.17.2', true],
    ['^0.2.3', 'npm', '0.2.9', true],
    ['^0.2.3', 'npm', '0.3.0', false],
    ['1.2.3', 'npm', '1.2.3', true],
    ['1.2.3', 'npm', '1.2.4', false],
    ['>=1.0.0 <2.0.0', 'npm', '1.9.0', true],
    ['>=1.0.0 <2.0.0', 'npm', '2.0.0', false],
    ['1.x', 'npm', '1.9.0', true],
    ['*', 'npm', '9.0.0', true],
    ['latest', 'npm', '9.0.0', true],
    ['^1.0.0 || ^2.0.0', 'npm', '2.5.0', true],
    // Cargo reads a bare version as a caret range.
    ['0.12.0', 'crates', '0.12.5', true],
    ['0.12.0', 'crates', '3.8.0', false],
    ['1.0', 'crates', '1.40.0', true],
    ['=1.0.0', 'crates', '1.0.1', false],
    ['>=1, <2', 'crates', '1.5.0', true],
    // Python
    ['==1.40.0', 'pypi', '1.40.0', true],
    ['==1.40.0', 'pypi', '1.41.0', false],
    ['>=0.30,<1', 'pypi', '0.99.0', true],
    ['>=0.30,<1', 'pypi', '1.0.0', false],
    ['~=0.2.0', 'pypi', '0.2.9', true],
    ['~=0.2.0', 'pypi', '0.3.0', false],
    ['', 'pypi', '1.0.0', true],
  ];
  for (const [spec, ecosystem, version, want] of cases) {
    it(`${ecosystem} ${JSON.stringify(spec)} ${want ? 'allows' : 'does not allow'} ${version}`, () => {
      assert.equal(allowsVersion(spec, version, ecosystem), want);
    });
  }
});

describe('the rest', () => {
  it('compares versions, with a prerelease below its release', () => {
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
    assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
  });

  it('reads the lowest version a spec names', () => {
    assert.equal(lowestVersionIn('^1.24.3'), '1.24.3');
    assert.equal(lowestVersionIn('>=0.30,<1'), '0.30');
    assert.equal(lowestVersionIn('*'), null);
  });

  it('counts majors behind: rmcp 0.12.0 to 3.8.0 is three', () => {
    assert.equal(majorsBehind('0.12.0', '3.8.0'), 3);
    assert.equal(majorsBehind('2.17.2', '2.17.2'), 0);
  });

  it('calls a spec exact, a range or open', () => {
    assert.equal(specKind('1.2.3', 'npm'), 'exact');
    assert.equal(specKind('^1.2.3', 'npm'), 'range');
    assert.equal(specKind('==1.2.3', 'pypi'), 'exact');
    assert.equal(specKind('0.12.0', 'crates'), 'range');
    assert.equal(specKind('=0.12.0', 'crates'), 'exact');
    assert.equal(specKind('*', 'npm'), 'open');
    assert.equal(specKind('', 'pypi'), 'open');
  });
});
