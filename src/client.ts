import type { Ctx } from './context.js';
import { apiUrl, requireToken } from './config.js';
import { ApiError, type Diagnostic } from './errors.js';
import { VERSION } from './version.js';

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Sent as Idempotency-Key and reused across retries. */
  idempotencyKey?: string;
  /** Response is text (markdown, csv) rather than JSON. */
  text?: boolean;
  /** Override the stored token (login validates a token before saving it). */
  token?: string;
  /** Skip auth entirely. */
  noAuth?: boolean;
  /** Retry budget for busy/rate-limited/network failures (default MAX_RETRIES). */
  retries?: number;
  /**
   * Retry busy/rate-limited/network failures until this much time has been spent waiting
   * (Retry-After when the server sends it, else backoff capped at MAX_BACKOFF_MS), instead of a
   * fixed number of attempts. Overrides `retries`.
   */
  retryBudgetMs?: number;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

export const MAX_RETRIES = 3;
/** With a time budget: the least each retry counts against it, and the most retries in all. */
const MIN_RETRY_COST_MS = 1000;
const MAX_BUDGET_RETRIES = 50;
/** Longest backoff between retries when the server sends no Retry-After. */
export const MAX_BACKOFF_MS = 15_000;

export class Client {
  constructor(private ctx: Ctx) {}

  get baseUrl(): string {
    return apiUrl(this.ctx);
  }

  url(p: string, query?: Query): string {
    const u = new URL(this.baseUrl + (p.startsWith('/') ? p : '/' + p));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async get<T = any>(p: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('GET', p, opts);
  }
  async post<T = any>(p: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('POST', p, opts);
  }
  async put<T = any>(p: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', p, opts);
  }
  async patch<T = any>(p: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', p, opts);
  }
  async delete<T = any>(p: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', p, opts);
  }

  async request<T>(method: string, p: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'User-Agent': `chartnaut-cli/${VERSION}`,
      Accept: opts.text ? 'text/markdown, text/csv, text/plain, */*' : 'application/json',
    };
    if (!opts.noAuth) headers.Authorization = `Bearer ${opts.token ?? requireToken(this.ctx)}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const url = this.url(p, opts.query);
    const maxRetries = opts.retries ?? MAX_RETRIES;
    let waited = 0;
    // Whether another retry fits: by attempts, or by the time budget when one is set. Each retry
    // costs the budget at least MIN_RETRY_COST_MS and there is a hard attempt cap, so a server that
    // keeps answering `Retry-After: 0` cannot keep the CLI retrying forever.
    const cost = (delay: number) => Math.max(delay, MIN_RETRY_COST_MS);
    const mayRetry = (attempt: number, delay: number) =>
      opts.retryBudgetMs !== undefined
        ? attempt < MAX_BUDGET_RETRIES && waited + cost(delay) <= opts.retryBudgetMs
        : attempt < maxRetries;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.ctx.fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (e) {
        const delay = backoffMs(attempt);
        if (mayRetry(attempt, delay)) {
          waited += cost(delay);
          await this.ctx.sleep(delay);
          continue;
        }
        throw new ApiError(0, { code: 'network', message: `cannot reach ${this.baseUrl}: ${(e as Error).message}` });
      }

      const raw = await res.text();
      if (res.ok) {
        if (opts.text) return { status: res.status, data: raw as T };
        return { status: res.status, data: (raw ? safeJson(raw) : null) as T };
      }

      const err = toApiError(res.status, raw);
      const retryable = res.status === 429 || res.status === 503 || err.code === 'busy' || err.code === 'rate_limited';
      if (retryable) {
        const delay = retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt);
        if (mayRetry(attempt, delay)) {
          waited += cost(delay);
          await this.ctx.sleep(delay);
          continue;
        }
      }
      throw err;
    }
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Retry-After as seconds or an HTTP date; undefined if absent/unparseable. Capped at 60s. */
export function retryAfterMs(h: string | null | undefined, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), 60) * 1000;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now, 0), 60_000);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Parses `{error:{code,message,details,request_id}}`. Diagnostics may sit at
 * the top level (the spec's ScriptInvalid response) or in error.details or
 * error itself; all three are accepted.
 */
export function toApiError(status: number, raw: string): ApiError {
  const parsed = safeJson(raw) as any;
  const e = parsed && typeof parsed === 'object' ? parsed.error : undefined;
  if (e && typeof e === 'object' && typeof e.code === 'string') {
    const diags: Diagnostic[] =
      (Array.isArray(parsed.diagnostics) && parsed.diagnostics) ||
      (Array.isArray(e.diagnostics) && e.diagnostics) ||
      (Array.isArray(e.details?.diagnostics) && e.details.diagnostics) ||
      [];
    return new ApiError(status, { code: e.code, message: e.message ?? '', details: e.details, request_id: e.request_id, docs_url: e.docs_url }, diags);
  }
  const code =
    status === 401 ? 'unauthorized' : status === 403 ? 'forbidden_scope' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status === 503 ? 'busy' : status >= 500 ? 'internal' : 'invalid_request';
  const snippet = typeof raw === 'string' ? raw.slice(0, 200).trim() : '';
  return new ApiError(status, { code, message: `HTTP ${status}${snippet ? `: ${snippet}` : ''}` });
}

/** Path-encodes a script ref but keeps `@` so `slug@3` stays readable. */
export function encodeRef(ref: string): string {
  return encodeURIComponent(ref).replace(/%40/g, '@');
}
