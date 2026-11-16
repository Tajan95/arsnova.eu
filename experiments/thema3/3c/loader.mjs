// Component-test boundary: only context acquisition and purge registration are
// replaced. Packing, hashing, cache, fallback and schemas are the release code.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stubs = new Map([
  [
    'sessionPurgeInvalidation.ts',
    'export function registerSessionPurgeInvalidator() { return () => {}; }',
  ],
  [
    'moderationPromptContext.ts',
    `export async function buildModerationPromptContext() {
    if (!globalThis.__thema3AuthorizedAnalysis) throw new Error('No synthetic context supplied');
    globalThis.__thema3ContextReads = (globalThis.__thema3ContextReads || 0) + 1;
    return structuredClone(globalThis.__thema3AuthorizedAnalysis);
  }`,
  ],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@arsnova/shared-types') {
      return {
        url: pathToFileURL(path.join(root, 'libs/shared-types/src/index.ts')).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      const candidate = base.endsWith('.js') ? base.slice(0, -3) + '.ts' : base + '.ts';
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const filename = fileURLToPath(url);
      if (!filename.startsWith(root + path.sep)) return nextLoad(url, context);
      const basename = path.basename(filename);
      if (stubs.has(basename) && filename.includes('/apps/backend/src/lib/')) {
        return { format: 'module', source: stubs.get(basename), shortCircuit: true };
      }
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(filename, 'utf8'), {
          mode: 'transform',
          sourceUrl: url,
        }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
