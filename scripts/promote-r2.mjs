#!/usr/bin/env node
/**
 * Promotes a tested unstable release to stable, server side, without rebuilding:
 *
 *   npm run promote:r2 -- 0.2.0
 *
 * Reads cli/unstable/<version>/manifest.json, re-checks every binary in cli/unstable/<version>/
 * against its sha256, copies them to cli/<version>/, writes the stable manifest (URLs under
 * CHARTNAUT_RELEASE_BASE, default https://desktop-updates.chartnaut.com/cli) to
 * cli/<version>/manifest.json, and cli/latest.json last. Nothing is written unless every binary
 * checks out. Run it only after the release gate passed against the unstable channel.
 *
 * Needs R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.
 */
import { DEFAULT_RELEASE_BASE, promoteRelease, r2Store } from './release-lib.mjs';

const version = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!version || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: npm run promote:r2 -- <version>   (e.g. 0.2.0)');
  process.exit(2);
}
const stableBase = (process.env.CHARTNAUT_RELEASE_BASE ?? DEFAULT_RELEASE_BASE).replace(/\/+$/, '');
const store = await r2Store(process.env);
await promoteRelease(store, version, { stableBase, log: (key) => console.log(`[promote] ${key}`) });
console.log(`[promote] done: chartnaut ${version} is live on the stable channel`);
