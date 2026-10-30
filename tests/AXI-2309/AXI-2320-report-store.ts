import { createHash, createHmac } from 'node:crypto';
import {
  REPORT_STORE_ACCESS_KEY,
  REPORT_STORE_BUCKET,
  REPORT_STORE_ENDPOINT,
  REPORT_STORE_PREFIX,
  REPORT_STORE_REGION,
  REPORT_STORE_SECRET_KEY,
} from '../../config/env';

/**
 * AXI-2320 (epic AXI-2309 — FR34) — seeds fixture daily-report objects into the
 * report store the organization-service lists, at the EXACT key layout the
 * AXI-2318 publisher writes (`<prefix>/<YYYY-MM-DD>/<runId>/report.json`,
 * `harness/prod-suite/publish.ts:s3KeyFor`). Path-style S3 over a hand-rolled
 * SigV4 signer (no SDK dependency in this repo); the credentials come from
 * `config/env.ts` and are never logged or written anywhere.
 */

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

function signingKey(dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${REPORT_STORE_SECRET_KEY}`, dateStamp);
  return hmac(hmac(hmac(kDate, REPORT_STORE_REGION), 's3'), 'aws4_request');
}

/** SigV4 headers for one path-style request (no query string). */
function signedHeaders(method: string, path: string, body: string): Record<string, string> {
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(REPORT_STORE_ENDPOINT).host;
  const payloadHash = sha256(body);
  const canonical = [method, path, '', `host:${host}`, `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`, '', 'host;x-amz-content-sha256;x-amz-date', payloadHash].join('\n');
  const scope = `${dateStamp}/${REPORT_STORE_REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(dateStamp)).update(toSign).digest('hex');
  return {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${REPORT_STORE_ACCESS_KEY}/${scope}, ` +
      `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
  };
}

const encodePath = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

async function send(method: 'PUT' | 'DELETE', key: string | null, body = ''): Promise<number> {
  const path = `/${encodeURIComponent(REPORT_STORE_BUCKET)}${key ? `/${encodePath(key)}` : ''}`;
  const res = await fetch(`${REPORT_STORE_ENDPOINT}${path}`, {
    method,
    headers: signedHeaders(method, path, body),
    body: method === 'PUT' ? body : undefined,
  });
  return res.status;
}

/** Create the bucket when absent (an already-owned bucket is fine). */
export async function ensureReportBucket(): Promise<void> {
  const status = await send('PUT', null);
  if (status !== 200 && status !== 409) throw new Error(`AXI-2320 seed: bucket create -> ${status}`);
}

export function reportKey(date: string, runId: string, file = 'report.json'): string {
  return `${REPORT_STORE_PREFIX}/${date}/${runId}/${file}`;
}

export async function putReportObject(key: string, text: string): Promise<void> {
  const status = await send('PUT', key, text);
  if (status !== 200) throw new Error(`AXI-2320 seed: put object -> ${status}`);
}

export async function deleteReportObject(key: string): Promise<void> {
  await send('DELETE', key).catch(() => undefined);
}
