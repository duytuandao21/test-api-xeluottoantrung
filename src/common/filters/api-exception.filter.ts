import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLoggerService } from '../logging/pino-logger.service.js';

function errorDetails(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const field = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    return value
      .replace(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi, '[REDACTED DATABASE_URL]')
      .replace(/\bpassword\s*=\s*[^\s,;]+/gi, 'password=[REDACTED]');
  };
  const source = error as Record<string, unknown>;
  const cause = source.cause && typeof source.cause === 'object' ? source.cause as Record<string, unknown> : undefined;
  return {
    message: field(source.message),
    name: field(source.name),
    code: field(source.code),
    stack: field(source.stack),
    cause: cause ? {
      message: field(cause.message),
      code: field(cause.code),
      stack: field(cause.stack),
    } : undefined,
  };
}

@Catch()
@Injectable()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(PinoLoggerService) private readonly logger: PinoLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = exception instanceof HttpException ? exception.getResponse() : undefined;
    const body = typeof response === 'object' && response !== null ? response as Record<string, unknown> : {};
    const message = statusCode === 500 ? 'Internal server error' : typeof body.message === 'string' ? body.message : typeof response === 'string' ? response : exception instanceof HttpException ? exception.message : 'Request failed';
    const details = body.details ?? (Array.isArray(body.message) ? body.message : undefined);
    if (statusCode >= 500) this.logger.instance.error({ requestId: request.id, method: request.method, path: request.url.split('?')[0], status: statusCode, err: errorDetails(exception) }, 'server error');
    reply.status(statusCode).send({ statusCode, error: HttpStatus[statusCode] ? String(HttpStatus[statusCode]).replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Error', message, ...(details !== undefined ? { details } : {}) });
  }
}
