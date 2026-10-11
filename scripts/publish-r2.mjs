#!/usr/bin/env node
/**
 * Publishes release/ (from `npm run build:binaries`) to the R2 bucket behind
 * https://desktop-updates.chartnaut.com, next to the desktop app's channel, on one CLI channel:
 *
 *   stable (default)                      unstable (--channel unstable or CHARTNAUT_CHANNEL=unstable)
 *   cli/<version>/chartnaut-<platform>    cli/unstable/<version>/chartnaut-<platform>   immutable
 *   cli/<version>/manifest.json           cli/unstable/<version>/manifest.json          immutable (pinned installs)
 *   cli/latest.json                       cli/unstable/latest.json                      no-cache, uploaded LAST: the switch
 *
 * The build records its channel in the manifest; publishing a build to another channel is refused,
 * as is a manifest whose URLs or hashes do not match the files beside it. Needs R2_ENDPOINT,
 * R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment.
 *
 *   CHARTNAUT_CHANNEL=unstable npm run build:binaries && npm run publish:r2 -- --channel unstable
 *   npm run promote:r2 -- <version>          (after the release gate passes; see RELEASING.md)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelFrom, publishRelease, r2Store } from './release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channel = channelFrom(process.argv.slice(2), process.env);
const store = await r2Store(process.env);
const manifest = await publishRelease(store, path.join(root, 'release'), channel, (key) => console.log(`[publish] ${key}`));
console.log(`[publish] done: chartnaut ${manifest.version} is live on the ${channel} channel`);
