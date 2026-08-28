import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpMethod } from '../client/types';
import type { RouteEntry } from './types';

/**
 * Static route-table extractor (FR15 input).
 *
 * Reads `@Controller({ path, version })` + `@Get/@Post/@Patch/@Put/@Delete('…')`
 * decorators the way `apps/gateway/src/main.ts` actually mounts them
 * (`app.enableVersioning({ type: URI, prefix: 'api/v', defaultVersion: '1' })`).
 *
 * Scoped **per class**, not per file (the AXI-1369 fix): the dev-epic-context
 * flags `GET .../merge-runs` as "declared twice" in `merge-run.controller.ts`,
 * which holds TWO `@Controller` classes. A per-file extractor that uses "the
 * file's @Controller path" for every `@Get/@Post` in the file would misattribute
 * `ConsolidatedNodeProxyController`'s route onto `MergeRunProxyController`'s base
 * path, producing exactly that false duplicate. Scoping to the nearest
 * preceding `@Controller` — matched to its own class body — avoids it. See
 * `routeExtractor.spec.ts` for the fixture that proves this.
 */

const HTTP_DECORATORS: HttpMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

interface ParsedControllerClass {
  className: string;
  basePath: string;
  bodyStart: number;
  bodyEnd: number;
}

/** Balance parens/braces from `openIdx` (which must point at the opening char) and return the close index. */
function findMatchingClose(source: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${open}${close} starting at ${openIdx}`);
}

/** Extract the `path` prop (default `''`) from a `@Controller(...)` argument string. */
function basePathFromControllerArgs(argsText: string): string {
  const objectMatch = argsText.match(/path\s*:\s*'([^']*)'/);
  if (objectMatch) return objectMatch[1];
  const stringMatch = argsText.match(/^\s*'([^']*)'\s*$/);
  return stringMatch ? stringMatch[1] : '';
}

/** Find every `@Controller(...)` in the file, each paired with its class's body span. */
function findControllerClasses(source: string): ParsedControllerClass[] {
  const classes: ParsedControllerClass[] = [];
  const decoratorRe = /@Controller\(/g;
  let match: RegExpExecArray | null;
  while ((match = decoratorRe.exec(source))) {
    classes.push(parseOneControllerClass(source, match.index, match.index + match[0].length - 1));
  }
  return classes;
}

function parseOneControllerClass(source: string, decoratorStart: number, openParenIdx: number): ParsedControllerClass {
  const closeParenIdx = findMatchingClose(source, openParenIdx, '(', ')');
  const argsText = source.slice(openParenIdx + 1, closeParenIdx);
  const classDeclMatch = /export class (\w+)/.exec(source.slice(closeParenIdx));
  const className = classDeclMatch ? classDeclMatch[1] : `<unknown-at-${decoratorStart}>`;
  const bodyOpenIdx = source.indexOf('{', closeParenIdx + (classDeclMatch?.index ?? 0));
  const bodyCloseIdx = findMatchingClose(source, bodyOpenIdx, '{', '}');
  return { className, basePath: basePathFromControllerArgs(argsText), bodyStart: bodyOpenIdx, bodyEnd: bodyCloseIdx };
}

/** Extract `@Get/@Post/.../('sub-path')` decorators found strictly within one class's body. */
function routesInClassBody(source: string, cls: ParsedControllerClass, sourceFile: string): RouteEntry[] {
  const body = source.slice(cls.bodyStart, cls.bodyEnd);
  const routes: RouteEntry[] = [];
  for (const method of HTTP_DECORATORS) {
    routes.push(...matchMethodDecorators(body, method, cls, sourceFile));
  }
  return routes;
}

function matchMethodDecorators(body: string, method: HttpMethod, cls: ParsedControllerClass, sourceFile: string): RouteEntry[] {
  const label = method[0] + method.slice(1).toLowerCase();
  const re = new RegExp(`@${label}\\(([^)]*)\\)`, 'g');
  const routes: RouteEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const sub = (m[1].match(/'([^']*)'/) ?? [, ''])[1];
    routes.push({ method, path: joinRoutePath(cls.basePath, sub), controllerClass: cls.className, sourceFile });
  }
  return routes;
}

function joinRoutePath(basePath: string, subPath: string): string {
  const segments = [basePath, subPath].filter((s) => s.length > 0);
  return `/api/v1/${segments.join('/')}`;
}

/** Parse one controller source file's text into its route table. Pure — no filesystem I/O (unit-testable). */
export function parseControllerSource(source: string, sourceFile: string): RouteEntry[] {
  return findControllerClasses(source).flatMap((cls) => routesInClassBody(source, cls, sourceFile));
}

function listControllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) return listControllerFiles(full);
    return full.endsWith('.controller.ts') ? [full] : [];
  });
}

/** Walk `gatewaySrcRoot` and extract the full route table — the `apps/gateway/src` walk step of FR15. */
export function extractRouteTable(gatewaySrcRoot: string): RouteEntry[] {
  return listControllerFiles(gatewaySrcRoot).flatMap((file) => parseControllerSource(readFileSync(file, 'utf8'), file));
}

/** Group routes by `METHOD path` to surface any genuine duplicate declaration (the AXI-1369 duplicate check). */
export function findDuplicateRoutes(routes: RouteEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([key]) => key);
}
