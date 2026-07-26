import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the suites need different runtimes:
 *
 * - `unit` runs in Node, so it can read repo files for the structural invariants.
 * - `integration` runs in workerd with Miniflare-backed D1 and KV, so the aggregation query
 *   executes against real SQLite with the real migrations applied. Every correctness bug that
 *   suite covers lives in SQL, and a mock-backed test would only ever exercise the mock.
 *
 * Running the unit suite through Vite rather than `node --experimental-strip-types` also
 * removes a constraint that had started to distort the source: Node's ESM loader cannot
 * resolve this project's extensionless imports, so any module under test had to stay free of
 * runtime imports.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts']
        }
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              // Applying these in beforeAll also means a typo in a migration fails the suite.
              bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') }
            }
          }))
        ],
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          setupFiles: ['./test/integration/apply-migrations.ts']
        }
      }
    ]
  }
});
