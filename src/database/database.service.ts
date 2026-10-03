import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { safeErrorDetails } from '../common/logging/safe-error-details.js';
import * as schema from './schema/index.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    this.pool.on('error', (error: Error) => {
      this.logger.error({ event: 'database.pool.error', err: safeErrorDetails(error), pool: this.getPoolState() });
    });
    this.db = drizzle(this.pool, { schema });
  }

  getPoolState() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      ending: this.pool.ending,
      ended: this.pool.ended,
    };
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
