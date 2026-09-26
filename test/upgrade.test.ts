import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isStandalone, platformKey } from '../src/commands/upgrade.js';

test('compareVersions orders dotted versions numerically', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v0.1.0', '0.1.1'), -1);
});

test('platformKey matches the install scripts', () => {
  assert.equal(platformKey('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(platformKey('darwin', 'x64', false), 'darwin-x64');
  assert.equal(platformKey('linux', 'x64', false), 'linux-x64');
  assert.equal(platformKey('linux', 'arm64', true), 'linux-arm64-musl');
  assert.equal(platformKey('win32', 'x64', false), 'windows-x64');
  assert.equal(platformKey('freebsd', 'x64', false), null);
});

test('isStandalone tells the binary from an npm install', () => {
  assert.equal(isStandalone('/Users/a/.chartnaut/bin/chartnaut'), true);
  assert.equal(isStandalone('C:/Users/a/AppData/Local/Chartnaut/bin/chartnaut.exe'), true);
  assert.equal(isStandalone('/usr/local/bin/node'), false);
});
