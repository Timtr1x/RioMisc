import { pino, type Logger } from "pino";

export type RioLogger = Logger;

export function createLogger(level: string = process.env.RIO_LOG_LEVEL ?? "info"): RioLogger {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

let _logger: RioLogger | null = null;

/** Global default logger for the control plane. */
export function getLogger(): RioLogger {
  if (!_logger) _logger = createLogger();
  return _logger;
}

export function setLogger(l: RioLogger) {
  _logger = l;
}
