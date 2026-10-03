import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ConsoleLogger, Logger, type ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter.js';
import { PinoLoggerService } from '../src/common/logging/pino-logger.service.js';
import { safeErrorDetails } from '../src/common/logging/safe-error-details.js';
import { DatabaseService } from '../src/database/database.service.js';
import { HealthController } from '../src/modules/health/health.controller.js';

test('diagnostics preserve three cause levels and terminate cyclic cause chains', () => {
  const fourth = new Error('fourth cause must not be logged');
  const third = Object.assign(new Error('third', { cause: fourth }), { code: '08006' });
  const second = new Error('second', { cause: third });
  const first = new Error('first', { cause: second });
  const root = new Error('root', { cause: first });
  const details = safeErrorDetails(root, {});
  assert.equal(details?.cause?.cause?.cause?.message, 'third');
  assert.equal(details?.cause?.cause?.cause?.code, '08006');
  assert.equal(details?.cause?.cause?.cause?.name, 'Error');
  assert.match(details?.cause?.cause?.cause?.stack ?? '', /third/);
  assert.equal(details?.cause?.cause?.cause?.cause, undefined);
  first.cause = root;
  assert.equal(safeErrorDetails(root, {})?.cause?.cause, undefined);
});

test('diagnostics redact credentials in all fields and omit multiline Drizzle params and client data', () => {
  const databaseUrl = 'postgresql://diagnostic-user:encoded%21password@localhost:6543/db';
  const pgError = Object.assign(new Error(`Connection to ${databaseUrl} failed: encoded!password; diagnostic-user; fixture-token; password="unknown password"; secret='unknown secret'; Bearer opaque-auth`), {
    code: 'ECONNRESET', client: { password: 'client-password' }, token: 'raw-token',
  });
  const query = new Error('Failed query: SELECT secret FROM settings WHERE key = $1\nparams: multiline-query-secret\nsecond-line-secret', { cause: pgError });
  const logged = JSON.stringify(safeErrorDetails(query, { DATABASE_URL: databaseUrl, ACCESS_TOKEN: 'fixture-token' }));
  for (const secret of [databaseUrl, 'encoded%21password', 'encoded!password', 'diagnostic-user', 'fixture-token', 'unknown password', 'unknown secret', 'opaque-auth', 'client-password', 'raw-token', 'multiline-query-secret', 'second-line-secret']) {
    assert.ok(!logged.includes(secret), `Diagnostic output leaked fixture: ${secret}`);
  }
  assert.match(logged, /ECONNRESET/);
  assert.match(logged, /SQL and params redacted/);
});

test('the actual Pino logger preserves cause fields and structured Nest error messages', () => {
  const moduleUrl = new URL('../src/common/logging/pino-logger.service.js', import.meta.url).href;
  const script = `
    import { PinoLoggerService } from ${JSON.stringify(moduleUrl)};
    const logger = new PinoLoggerService();
    const cause = Object.assign(new Error('socket reset fixture-secret'), { code: 'ECONNRESET' });
    logger.error({ event: 'database.pool.error', err: new Error('Failed query: SELECT $1\\nparams: query-token', { cause }), pool: { totalCount: 1, idleCount: 0, waitingCount: 2 } });
    logger.error(Object.assign(new Error('Failed query: SELECT $1\\nparams: raw-error-token', { cause }), { query: 'SELECT raw-query-secret', params: ['raw-param-secret'] }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, DIAGNOSTIC_SECRET: 'fixture-secret' },
  });
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  const logged = records[0];
  assert.equal(logged.event, 'database.pool.error');
  assert.equal(logged.err.name, 'Error');
  assert.equal(logged.err.cause.name, 'Error');
  assert.equal(logged.err.cause.code, 'ECONNRESET');
  assert.match(logged.err.cause.stack, /socket reset/);
  assert.equal(logged.pool.waitingCount, 2);
  assert.ok(!result.stdout.includes('fixture-secret'));
  assert.ok(!result.stdout.includes('query-token'));
  assert.ok(!result.stdout.includes('raw-error-token'));
  assert.ok(!result.stdout.includes('raw-query-secret'));
  assert.ok(!result.stdout.includes('raw-param-secret'));
  assert.equal(records[1].err.cause.code, 'ECONNRESET');
});

test('idle pool errors are handled and log a safe error with the current pool state', async () => {
  const messages: unknown[] = [];
  Logger.overrideLogger({ error: (message: unknown) => { messages.push(message); }, log: () => {}, warn: () => {} });
  const database = new DatabaseService(new ConfigService({ DATABASE_URL: 'postgresql://fixture:fixture@localhost/db' }));
  try {
    const error = Object.assign(new Error('socket reset'), { code: 'ECONNRESET', client: { password: 'client-secret' } });
    assert.equal(database.pool.emit('error', error), true);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { event: 'database.pool.error', err: safeErrorDetails(error), pool: database.getPoolState() });
    assert.ok(!JSON.stringify(messages).includes('client-secret'));
  } finally {
    await database.onModuleDestroy();
    Logger.overrideLogger(new ConsoleLogger());
  }
});

test('HTTP query errors and health failures log root causes and pool state without changing responses', async () => {
  const logs: Record<string, unknown>[] = [];
  const replies: { status?: number; body?: unknown } = {};
  const pool = { totalCount: 1, idleCount: 0, waitingCount: 3, ending: false, ended: false };
  const pgError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const queryError = new Error('Failed query: SELECT $1\nparams: hidden-value', { cause: pgError });
  const database = { getPoolState: () => pool, ping: async () => { throw pgError; } } as unknown as DatabaseService;
  const logger = { instance: { error: (data: Record<string, unknown>) => { logs.push(data); } } } as unknown as PinoLoggerService;
  const reply = { status: (status: number) => { replies.status = status; return reply; }, send: (body: unknown) => { replies.body = body; } };
  const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ id: 'diagnostic-request', method: 'GET', url: '/api/v1/site-settings/thiet-lap-thong-tin?token=hidden' }) }) } as unknown as ArgumentsHost;
  const filter = new ApiExceptionFilter(logger, database);
  filter.catch(queryError, host);
  assert.equal(replies.status, 500);
  assert.equal((replies.body as { message: string }).message, 'Internal server error');
  assert.deepEqual(logs[0].pool, pool);
  assert.deepEqual(logs[0].err, safeErrorDetails(queryError));
  assert.equal(logs[0].path, '/api/v1/site-settings/thiet-lap-thong-tin');
  assert.ok(!JSON.stringify(logs).includes('hidden-value'));
  await assert.rejects(new HealthController(database).check(), (error: unknown) => {
    filter.catch(error, host);
    assert.equal(replies.status, 503);
    assert.equal((replies.body as { message: string }).message, 'Database is unavailable');
    assert.deepEqual(logs[1].err, safeErrorDetails(error));
    assert.equal((logs[1].err as { cause: { code: string } }).cause.code, 'ECONNRESET');
    assert.deepEqual(logs[1].pool, pool);
    return true;
  });
});
