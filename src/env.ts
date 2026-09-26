import type { Command } from 'commander';
import { Client } from './client.js';
import type { Ctx } from './context.js';

/** Shared state for one CLI invocation. Commands set `code` to choose the exit code. */
export class Env {
  code = 0;
  readonly client: Client;
  constructor(public ctx: Ctx) {
    this.client = new Client(ctx);
  }
  isJson(cmd: Command): boolean {
    return Boolean(cmd.optsWithGlobals().json);
  }
  out(s: string): void {
    this.ctx.out(s);
  }
  err(s: string): void {
    this.ctx.err(s);
  }
  printJson(v: unknown): void {
    this.ctx.out(JSON.stringify(v, null, 2));
  }
  /** Keeps the highest exit code seen. */
  fail(code: number): void {
    if (code > this.code) this.code = code;
  }
}
