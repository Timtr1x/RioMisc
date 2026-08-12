import { z } from "zod";

export type ErrorCategory =
  | "CONTEST_API"
  | "MODEL_API"
  | "TOOL"
  | "FILESYSTEM"
  | "DATABASE"
  | "WORKER"
  | "VALIDATION"
  | "RESOURCE";

export class RioError extends Error {
  readonly category: ErrorCategory;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly code: string;
  override readonly cause?: unknown;

  constructor(
    code: string,
    message: string,
    opts: {
      category: ErrorCategory;
      recoverable?: boolean;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "RioError";
    this.code = code;
    this.category = opts.category;
    this.recoverable = opts.recoverable ?? false;
    this.retryable = opts.retryable ?? false;
    this.cause = opts.cause;
  }
}

export const isRioError = (e: unknown): e is RioError => e instanceof RioError;

/** Wrap unknown thrown values into RioError. */
export function asRioError(e: unknown, fallbackCode = "UNKNOWN", category: ErrorCategory = "WORKER"): RioError {
  if (isRioError(e)) return e;
  if (e instanceof Error) return new RioError(fallbackCode, e.message, { category, cause: e });
  return new RioError(fallbackCode, String(e), { category });
}
