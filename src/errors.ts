/** Fixed exit codes (docs: CLI › Errors and exit codes). Agents branch on these. */
export const EXIT = {
  OK: 0,
  SCRIPT_INVALID: 1,
  RUN_FAILED: 2,
  AUTH: 3,
  USAGE: 4,
  RETRYABLE: 5,
} as const;

export interface Diagnostic {
  severity: 'error' | 'warning' | string;
  code?: string;
  message: string;
  path?: string;
  line?: number;
  setting?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  docs_url?: string;
  request_id?: string;
}

/** An error response from the API (or a transport failure mapped onto one). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody,
    public diagnostics: Diagnostic[] = [],
  ) {
    super(`${body.code}: ${body.message}`);
  }
  get code(): string {
    return this.body.code;
  }
}

/** An error raised by the CLI itself (bad flags, missing files, …). */
export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number = EXIT.USAGE,
  ) {
    super(message);
  }
}

export function exitCodeForErrorCode(code: string, status = 0): number {
  switch (code) {
    case 'script_invalid':
      return EXIT.SCRIPT_INVALID;
    case 'unauthorized':
    case 'forbidden_scope':
    case 'plan_limit':
      return EXIT.AUTH;
    case 'busy':
    case 'rate_limited':
    case 'data_not_ready':
    case 'run_not_finished':
    case 'internal':
    case 'network':
      return EXIT.RETRYABLE;
    case 'not_found':
    case 'invalid_request':
    case 'version_conflict':
    case 'in_use':
    case 'out_of_coverage':
    case 'unknown_instrument':
    case 'unsupported_timeframe':
      return EXIT.USAGE;
  }
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 429 || status >= 500) return EXIT.RETRYABLE;
  if (status === 422) return EXIT.SCRIPT_INVALID;
  return EXIT.USAGE;
}

/** Exit code for a finished run: 0 succeeded, else by failure kind. */
export function exitCodeForRun(run: { status?: string; failure?: { kind?: string; retryable?: boolean } | null }): number {
  if (run.status === 'succeeded') return EXIT.OK;
  if (run.status === 'queued' || run.status === 'running') return EXIT.OK;
  const kind = run.failure?.kind;
  if (kind === 'plan_limit') return EXIT.AUTH;
  if (kind !== undefined && RETRYABLE_RUN_FAILURES.has(kind)) return EXIT.RETRYABLE;
  if (run.failure?.retryable === true && kind !== 'script' && kind !== 'cancelled') return EXIT.RETRYABLE;
  return EXIT.RUN_FAILED;
}

/**
 * failure.kind values that mean "try again later", as the server sets them on runs and
 * collections: the same outcome as an HTTP busy / data_not_ready / internal, so the same
 * exit code.
 */
export const RETRYABLE_RUN_FAILURES = new Set(['busy', 'data_not_ready', 'timeout', 'internal']);

export function formatDiagnostic(d: Diagnostic): string {
  const where = `${d.path ?? '-'}:${d.line ?? 0}`;
  const code = d.code ? ` [${d.code}]` : '';
  return `${where}: ${d.severity ?? 'error'}: ${d.message}${code}`;
}

/** Renders an ApiError the way every command prints it. */
export function formatApiError(e: ApiError): string[] {
  const lines = [`error: ${e.body.code}: ${e.body.message}`];
  for (const d of e.diagnostics) lines.push(formatDiagnostic(d));
  if (e.body.request_id) lines.push(`request_id: ${e.body.request_id}`);
  return lines;
}
