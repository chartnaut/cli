#!/usr/bin/env node
import { main } from './cli.js';
import { realCtx } from './context.js';

main(process.argv.slice(2), realCtx()).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`error: internal: ${e?.message ?? e}\n`);
    process.exitCode = 5;
  },
);
