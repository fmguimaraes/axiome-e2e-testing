import type { APIRequestContext } from '@playwright/test';
import { TEST_MAILBOX_ACCOUNT_ID, TEST_MAILBOX_API_TOKEN, TEST_MAILBOX_INBOX_ID } from './env';

/**
 * Adapter over a dedicated test-mailbox's REST API (AXI-2315 — FR24/NFR8).
 *
 * Deliberately provider-shaped around the Mailtrap Testing-Inbox API (list +
 * fetch-body-by-id, bearer-style `Api-Token` header) — the common choice for
 * "catch every transactional test email without reaching a human inbox,
 * readable over REST." Swap the two HTTP calls below for another provider's
 * shape without touching any spec; nothing outside this file knows the
 * provider.
 *
 * EC11 discipline: every method here either resolves with real content or
 * throws — there is no catch-and-return-null fallback. A spec that calls
 * {@link waitForMessageTo} and gets nothing back after the timeout MUST see
 * that as a failed assertion, never a quietly-skipped step.
 */

interface MailboxMessage {
  id: string;
  to_email: string;
  subject: string;
  created_at: string;
}

function headers(): Record<string, string> {
  return { 'Api-Token': TEST_MAILBOX_API_TOKEN, Accept: 'application/json' };
}

function inboxUrl(path: string): string {
  return `https://mailtrap.io/api/accounts/${TEST_MAILBOX_ACCOUNT_ID}/inboxes/${TEST_MAILBOX_INBOX_ID}${path}`;
}

/** List the inbox's messages, newest first (the provider's own order). */
async function listMessages(api: APIRequestContext): Promise<MailboxMessage[]> {
  const res = await api.get(inboxUrl('/messages'), { headers: headers() });
  if (!res.ok()) {
    throw new Error(`test-mailbox list failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

/** Fetch one message's plain-text body. */
async function messageText(api: APIRequestContext, messageId: string): Promise<string> {
  const res = await api.get(inboxUrl(`/messages/${messageId}/body.txt`), { headers: headers() });
  if (!res.ok()) {
    throw new Error(`test-mailbox body fetch failed: ${res.status()} ${await res.text()}`);
  }
  return res.text();
}

/**
 * Poll the mailbox until a message to `toEmail` created after `sinceIso`
 * appears, or throw naming the timeout — never a silent empty return (EC11).
 */
export async function waitForMessageTo(
  api: APIRequestContext,
  toEmail: string,
  sinceIso: string,
  timeoutMs = 30_000,
): Promise<MailboxMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await listMessages(api);
    const match = messages.find(
      (m) => m.to_email === toEmail && new Date(m.created_at) >= new Date(sinceIso),
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `no message arrived for ${toEmail} within ${timeoutMs}ms — a genuine Mailjet/broker ` +
      'failure stays visible as this failure, never a silent pass (EC11)',
  );
}

/** Extract the reset token from the Mailjet reset-email body's reset link. */
export function extractResetToken(body: string): string {
  const match = body.match(/[?&]token=([^\s&]+)/);
  if (!match) {
    throw new Error('reset email body carried no ?token= link — cannot extract the reset token');
  }
  return decodeURIComponent(match[1]);
}

/** Fetch a message's body and extract its reset token in one call. */
export async function readResetToken(api: APIRequestContext, messageId: string): Promise<string> {
  const body = await messageText(api, messageId);
  return extractResetToken(body);
}
