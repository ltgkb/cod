import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase } from './database.js';

describe('PostgresDatabase pool lifecycle', () => {
  it('logs idle pool errors instead of letting EventEmitter terminate the service', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const database = new PostgresDatabase('postgresql://cod:test@127.0.0.1:5432/cod');
    const pool = (database as unknown as { pool: EventEmitter }).pool;

    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      level: 'error',
      event: 'postgres.pool.error',
      error: 'terminating connection due to administrator command',
    }));

    log.mockRestore();
    await database.close();
  });
});
