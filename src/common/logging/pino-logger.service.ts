import { Injectable, type LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import { safeErrorDetails } from './safe-error-details.js';

@Injectable()
export class PinoLoggerService implements LoggerService {
  readonly instance: Logger = pino({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    serializers: { err: safeErrorDetails },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'accessToken', 'refreshToken', 'DATABASE_URL', 'R2_SECRET_ACCESS_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
      censor: '[REDACTED]',
    },
  });

  log(message: unknown, context?: string): void { this.instance.info({ context }, String(message)); }
  error(message: unknown, trace?: string, context?: string): void {
    if (message && typeof message === 'object') {
      // Pino otherwise copies the raw err.message into msg before serializing err.
      this.instance.error({ ...(message instanceof Error ? { err: message } : message), context, trace }, 'server error');
    } else {
      this.instance.error({ context, trace }, String(message));
    }
  }
  warn(message: unknown, context?: string): void { this.instance.warn({ context }, String(message)); }
  debug(message: unknown, context?: string): void { this.instance.debug({ context }, String(message)); }
  verbose(message: unknown, context?: string): void { this.instance.trace({ context }, String(message)); }
}
