const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../support/electron');
const { spotlightQuery } = require('../../src/main/search');

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
