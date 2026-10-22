// The .env loader: local secrets must actually reach the app, and an environment variable that
// is already set must win over the file.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadEnv } from '../src/env.js';

let dir;
before(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'equidron-env-')); });
after(() => {});

const file = (name, text) => {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  return p;
};

test('reads KEY=value lines, ignores comments and blank lines, and strips quotes', () => {
  const p = file('a.env', [
    '# a comment',
    '',
    'EQUIDRON_TEST_ONE=first',
    'EQUIDRON_TEST_TWO="two words"',
    "EQUIDRON_TEST_THREE='three'",
    '  EQUIDRON_TEST_FOUR = spaced  ',
  ].join('\n'));
  const saved = { ...process.env };
  try {
    assert.equal(loadEnv(p), 4);
    assert.equal(process.env.EQUIDRON_TEST_ONE, 'first');
    assert.equal(process.env.EQUIDRON_TEST_TWO, 'two words');
    assert.equal(process.env.EQUIDRON_TEST_THREE, 'three');
    assert.equal(process.env.EQUIDRON_TEST_FOUR, 'spaced');
  } finally {
    for (const k of ['EQUIDRON_TEST_ONE', 'EQUIDRON_TEST_TWO', 'EQUIDRON_TEST_THREE', 'EQUIDRON_TEST_FOUR']) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('a variable already in the environment wins over the file', () => {
  const p = file('b.env', 'EQUIDRON_TEST_WINS=from-file\n');
  process.env.EQUIDRON_TEST_WINS = 'from-shell';
  try {
    assert.equal(loadEnv(p), 0);
    assert.equal(process.env.EQUIDRON_TEST_WINS, 'from-shell');
  } finally {
    delete process.env.EQUIDRON_TEST_WINS;
  }
});

test('a missing file is not an error', () => {
  assert.equal(loadEnv(path.join(dir, 'nope.env')), 0);
});
