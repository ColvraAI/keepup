import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recommendationProblem } from '../src/prose-rules.ts';

describe('recommendationProblem', () => {
  it('reads the word after "adopting" as a sentence when it is a verb, not a product', () => {
    for (const prose of ['Adopting means adding a key.', 'Adopting requires a new key.', 'Installing takes an hour.', 'Moving to it costs a day.', 'Adopting adds a vendor.', 'Adopting would add a vendor.', 'Adopting will add a vendor.']) {
      assert.equal(recommendationProblem(prose, 'TypeSafe Jev'), null, prose);
    }
  });

  it("doesn't take a package manager for a product someone is told to adopt", () => {
    for (const prose of ['You can use npm to install it.', 'Try pnpm here.', 'Install pip first.']) {
      assert.equal(recommendationProblem(prose, 'TypeSafe Jev'), null, prose);
    }
  });

  it('still refuses a product no source names', () => {
    assert.match(recommendationProblem('Adopting evilpkg saves money.', 'TypeSafe Jev') ?? '', /evilpkg/);
    assert.match(recommendationProblem('Switch to evilpkg for this.', 'TypeSafe Jev') ?? '', /evilpkg/);
  });
});
