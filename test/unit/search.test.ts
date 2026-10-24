import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../support/electron';
import { spotlightQuery as realQuery } from '../../src/main/search';

// The tests give only the fields they set, which the query reads the same
// as empty ones.
type Query = Parameters<typeof realQuery>[0];
const spotlightQuery = (q: Partial<Query>) => realQuery(q as Query);

test('an empty search finds everything', () => {
  assert.equal(spotlightQuery({}), 'kMDItemFSName == "*"');
});

test('names and words match anywhere, ignoring case and accents', () => {
  assert.equal(spotlightQuery({ name: 'report' }), 'kMDItemFSName == "*report*"cd');
  assert.equal(spotlightQuery({ word: 'budget' }), 'kMDItemTextContent == "*budget*"cd');
  assert.equal(spotlightQuery({ name: 'a', word: 'b' }), 'kMDItemFSName == "*a*"cd && kMDItemTextContent == "*b*"cd');
});

test('quotes, backslashes and stars in the text are escaped', () => {
  assert.equal(spotlightQuery({ name: 'say "hi" \\ *now' }), 'kMDItemFSName == "*say \\"hi\\" \\\\ \\*now*"cd');
});

test('age and size narrow it down', () => {
  assert.equal(spotlightQuery({ age: 'week' }), 'kMDItemFSContentChangeDate >= $time.today(-7)');
  assert.equal(spotlightQuery({ size: 'small' }), 'kMDItemFSSize >= 0 && kMDItemFSSize < 100000');
  assert.equal(spotlightQuery({ size: 'large' }), 'kMDItemFSSize >= 1000000');
  assert.equal(spotlightQuery({ age: 'decade', size: 'huge' }), 'kMDItemFSName == "*"', 'unknown choices are left out');
});
