import type { ExecutionStep } from "./types.js";

export type ErrorCode =
  | "E_VALIDATION"
  | "E_BAD_URL"
  | "E_CONFIG"
  | "E_NOT_FOUND"
  | "E_METHOD"
  | "E_BODY_TOO_LARGE"
  | "E_PROVIDER"
  | "E_PROVIDER_AUTH"
  | "E_RATE_LIMIT"
  | "E_QUOTA"
  | "E_TIMEOUT"
  | "E_ROUTING"
  | "E_EXECUTION_LIMIT"
  | "E_INTERNAL";

const HTTP_STATUS: Record<ErrorCode, number> = {
  E_VALIDATION: 400,
  E_BAD_URL: 400,
  E_CONFIG: 503,
  E_NOT_FOUND: 404,
  E_METHOD: 405,
  E_BODY_TOO_LARGE: 413,
  E_PROVIDER: 502,
  E_PROVIDER_AUTH: 502,
  E_RATE_LIMIT: 429,
  E_QUOTA: 402,
  E_TIMEOUT: 504,
  E_ROUTING: 502,
  E_EXECUTION_LIMIT: 422,
  E_INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  execution?: ExecutionStep[];

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; status?: number; execution?: ExecutionStep[]; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = opts.status ?? HTTP_STATUS[code];
    this.retryable = opts.retryable ?? false;
    this.execution = opts.execution;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  return new AppError("E_INTERNAL", message.slice(0, 200), { cause: err });
}

/** Replace literal secret values in a string. Used before anything reaches logs or responses. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
