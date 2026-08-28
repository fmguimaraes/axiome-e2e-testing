import { test, expect } from '@playwright/test';
import { scanSource, scanDirectory } from '../../staging/checks/noBackdoor';

/**
 * AXI-1369 — no-privileged-back-door check (NFR3, AC2). Manual-E2E §AXI-1368
 * §5.3. API-level, no browser.
 *
 * @SI-044.
 */

test.describe('NFR3 AC2 — the toolkit contains no database, message-bus or seed-script access path', () => {
  test('AC2 — flags a Prisma client import', () => {
    const hits = scanSource('fake.ts', `import { PrismaClient } from '@prisma/client';\n`);
    expect(hits).toHaveLength(1);
  });

  test('AC2 — flags a raw pg import', () => {
    const hits = scanSource('fake.ts', `import { Client } from 'pg';\n`);
    expect(hits).toHaveLength(1);
  });

  test('AC2 — flags an amqplib import', () => {
    const hits = scanSource('fake.ts', `import amqp from 'amqplib';\n`);
    expect(hits).toHaveLength(1);
  });

  test('AC2 — flags an ioredis import', () => {
    const hits = scanSource('fake.ts', `import Redis from 'ioredis';\n`);
    expect(hits).toHaveLength(1);
  });

  test('AC2 — a plain REST client import is not flagged', () => {
    const hits = scanSource('fake.ts', `import { RestClient } from '../client/RestClient';\n`);
    expect(hits).toHaveLength(0);
  });

  test('NFR3 AC2 — scanning the actual staging/ tree finds zero forbidden imports', () => {
    const hits = scanDirectory('staging');
    expect(hits, JSON.stringify(hits, null, 2)).toHaveLength(0);
  });
});
