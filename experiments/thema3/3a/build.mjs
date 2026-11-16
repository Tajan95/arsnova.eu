import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const output = resolve(process.argv[2] ?? 'experiments/thema3/.build');
for (const name of ['run-controlled', 'run-real']) {
  await build({
    entryPoints: [resolve(here, name + '.ts')],
    outfile: resolve(output, name + '.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'explicit-isolated-harness-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^@arsnova\/shared-types$/ }, () => ({
            path: resolve(root, 'libs/shared-types/src/index.ts'),
          }));
          builder.onResolve({ filter: /^\.\/sessionPurgeInvalidation$/ }, () => ({
            path: 'purge-registration',
            namespace: 'harness-boundary',
          }));
          builder.onResolve({ filter: /^\.\/moderationPromptContext$/ }, () => ({
            path: 'db-context-acquisition',
            namespace: 'harness-boundary',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'harness-boundary' }, (args) => ({
            contents:
              args.path === 'purge-registration'
                ? 'export function registerSessionPurgeInvalidator(){return ()=>{}}'
                : 'export async function buildModerationPromptContext(){throw new Error("DB context acquisition is outside this harness; supply fixture through FromAnalysis API")}',
            loader: 'js',
          }));
        },
      },
    ],
  });
}
console.log(`Built isolated release-client harnesses in ${output}`);
