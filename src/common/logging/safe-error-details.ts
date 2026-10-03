type ErrorDetails = {
  name?: string;
  message?: string;
  code?: string;
  stack?: string;
  cause?: ErrorDetails;
};

function diagnosticRedactor(env: NodeJS.ProcessEnv): (value: string) => string {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value && /DATABASE_URL|PASSWORD|TOKEN|SECRET|CREDENTIAL|(?:^|_)KEY(?:_|$)/i.test(key)) secrets.add(value);
  }
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      for (const value of [url.username, url.password]) {
        if (value) {
          secrets.add(value);
          secrets.add(decodeURIComponent(value));
        }
      }
    } catch { /* Invalid connection strings are still redacted as complete values. */ }
  }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return (value) => {
    let redacted = value
      .replace(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi, '[REDACTED]')
      .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
      .replace(/\b([\w.-]*(?:password|token|secret|credential|api[_-]?key|access[_-]?key)[\w.-]*)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]');
    for (const secret of values) redacted = redacted.replaceAll(secret, '[REDACTED]');
    return redacted;
  };
}

// Copy only diagnostic fields; never serialize query params, clients or pool options.
export function safeErrorDetails(error: unknown, env: NodeJS.ProcessEnv = process.env): ErrorDetails | undefined {
  const redact = diagnosticRedactor(env);
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): ErrorDetails | undefined => {
    if (!current || typeof current !== 'object' || seen.has(current)) return undefined;
    seen.add(current);
    const source = current as Record<string, unknown>;
    const field = (value: unknown) => typeof value === 'string' ? redact(value) : undefined;
    const rawMessage = typeof source.message === 'string' ? source.message : undefined;
    // Drizzle embeds every SQL parameter in its message (and therefore in its stack).
    const message = rawMessage?.startsWith('Failed query:')
      ? 'Failed query: [SQL and params redacted]'
      : field(rawMessage);
    const rawStack = typeof source.stack === 'string' ? source.stack : undefined;
    const stack = rawStack && rawMessage && message
      ? rawStack.replaceAll(rawMessage, message)
      : rawStack;
    return {
      name: field(source.name),
      message,
      code: field(source.code),
      stack: field(stack),
      cause: depth < 3 ? visit(source.cause, depth + 1) : undefined,
    };
  };
  return visit(error, 0);
}
