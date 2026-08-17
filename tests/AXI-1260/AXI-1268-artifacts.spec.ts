import { test, expect } from '@playwright/test';
import config from '../../playwright.config';
import { IS_CI } from '../../config/env';

/**
 * Failure artifacts, reports & retry caps (AXI-1268 — FR26/FR27/FR40, NFR9, AC14/AC19).
 *
 * Asserts the shared config guarantees debuggable failures and visible retries:
 * a trace/screenshot/video is retained for every failing test, JUnit + HTML are
 * emitted every run, and retries are capped at one in CI and zero locally. The
 * real artifact-on-failure behaviour is verified out-of-band (a deliberately
 * failing throwaway run) and recorded in the story; here we pin the contract.
 */
test.describe('AXI-1268 — failure artifacts & retry caps', () => {
  test('AC14 — a trace, screenshot, and video are retained for every failing test', () => {
    expect(config.use?.trace).toBe('retain-on-failure');
    expect(config.use?.screenshot).toBe('only-on-failure');
    expect(config.use?.video).toBe('retain-on-failure');
  });

  test('AC14 — JUnit XML and an HTML report are emitted every run', () => {
    const reporters = (config.reporter as ReadonlyArray<readonly [string, ...unknown[]]>).map((r) => r[0]);
    expect(reporters).toContain('junit');
    expect(reporters).toContain('html');
  });

  test('AC19 — retries are capped at one in CI and zero locally', () => {
    expect(config.retries).toBe(IS_CI ? 1 : 0);
    expect(config.retries).toBeLessThanOrEqual(1);
  });
});
