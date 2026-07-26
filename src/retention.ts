import { logEvent } from './observability';
import type { Env } from './types';

/**
 * Aggregation only ever reads a 24-hour window, but nothing used to prune the tables it reads
 * from. dns_updates was the worst case: a row per DNS attempt carrying up to 4000 chars of raw
 * Cloudflare response, scanned in full by listActiveDnsTargets on every rebuild — so every
 * reconciliation got monotonically slower for the life of the deployment.
 */
const NODE_RESULTS_RETENTION_HOURS = 72;
const UPLOADS_RETENTION_DAYS = 30;
const DNS_UPDATES_RETENTION_DAYS = 7;
const DNS_RESPONSE_BODY_RETENTION_HOURS = 24;

const BATCH_SIZE = 2000;
const MAX_BATCHES = 10;
/** Shared across every table so one cron tick cannot blow its CPU budget. */
const RETENTION_BUDGET_MS = 8000;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * D1 does not guarantee SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so `DELETE ... LIMIT` is unsafe.
 * The subquery form is portable and uses the created_at indexes added in migration 0005.
 */
async function pruneBatched(db: D1Database, sql: string, cutoff: string, deadline: number): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    if (Date.now() > deadline) {
      break;
    }
    const result = await db.prepare(sql).bind(cutoff, BATCH_SIZE).run();
    const changed = result.meta?.changes ?? 0;
    total += changed;
    if (changed < BATCH_SIZE) {
      // Caught up; in steady state this exits after one cheap indexed delete.
      break;
    }
  }
  return total;
}

export async function runRetention(env: Env): Promise<Record<string, number>> {
  const deadline = Date.now() + RETENTION_BUDGET_MS;
  const summary: Record<string, number> = {};

  // node_results first: it holds the FK to uploads, so deleting the parent first would strand
  // or reject the children.
  summary.node_results = await pruneBatched(
    env.DB,
    `DELETE FROM node_results WHERE id IN (
       SELECT id FROM node_results WHERE created_at < ?1 ORDER BY created_at ASC LIMIT ?2
     )`,
    isoAgo(NODE_RESULTS_RETENTION_HOURS * 60 * 60 * 1000),
    deadline
  );

  summary.uploads = await pruneBatched(
    env.DB,
    `DELETE FROM uploads WHERE id IN (
       SELECT uploads.id FROM uploads
       WHERE uploads.created_at < ?1
         AND NOT EXISTS (SELECT 1 FROM node_results WHERE node_results.upload_id = uploads.id)
       ORDER BY uploads.created_at ASC LIMIT ?2
     )`,
    isoAgo(UPLOADS_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    deadline
  );

  // The raw Cloudflare response body is only useful while diagnosing a recent failure, but it
  // is by far the bulkiest column in the table.
  const blanked = await pruneBatched(
    env.DB,
    `UPDATE dns_updates SET response_json = '' WHERE id IN (
       SELECT id FROM dns_updates
       WHERE created_at < ?1 AND response_json != ''
       ORDER BY created_at ASC LIMIT ?2
     )`,
    isoAgo(DNS_RESPONSE_BODY_RETENTION_HOURS * 60 * 60 * 1000),
    deadline
  );
  summary.dns_responses_blanked = blanked;

  summary.dns_updates = await pruneBatched(
    env.DB,
    `DELETE FROM dns_updates WHERE id IN (
       SELECT id FROM dns_updates WHERE created_at < ?1 ORDER BY created_at ASC LIMIT ?2
     )`,
    isoAgo(DNS_UPDATES_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    deadline
  );

  // admin_events is deliberately never pruned: it is the moderation audit trail and tiny.
  const truncated = Date.now() > deadline;
  logEvent(truncated ? 'warn' : 'info', 'retention_complete', { ...summary, budget_exhausted: truncated });
  return summary;
}
