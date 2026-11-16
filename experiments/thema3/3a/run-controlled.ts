/** Controlled HTTP fault injection, NOT a model benchmark. Release client unchanged. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetOpenWeightLlmClientForTests } from '../../../apps/backend/src/lib/openWeightLlmClient';
import { resolveOpenWeightLlmConfig } from '../../../apps/backend/src/lib/openWeightLlmConfig';
import { TYPES, outputs, invoke, type Task } from './fixtures';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, timeout = 5000) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) throw new Error('condition timeout');
    await pause(2);
  }
}
const token = 'referat-synthetic-token-not-a-real-secret';
function configure(port: number, timeout = 2000) {
  const config = resolveOpenWeightLlmConfig({
    OPEN_WEIGHT_LLM_ENABLED: 'true',
    OPEN_WEIGHT_LLM_URL: `http://127.0.0.1:${port}`,
    OPEN_WEIGHT_LLM_TOKEN: token,
  });
  resetOpenWeightLlmClientForTests({
    config: () => ({
      ...config,
      timeoutsMs: { topic_label: timeout, qa_summary: timeout, learning_objectives: timeout },
    }),
  });
}
function reason(result: any) {
  return result.status === 'fallback' ? result.reason : result.status;
}

async function main() {
  if (process.argv[2] === 'worker') {
    configure(Number(process.argv[3]));
    process.send?.({ ready: true });
    process.once('message', async () => {
      const result = await invoke(process.argv[4] as Task);
      process.send?.({ result });
      process.disconnect?.();
    });
    return;
  }
  const directory = resolve(process.argv[2] ?? 'experiment-results/3a');
  mkdirSync(directory, { recursive: true });
  const rows: any[] = [];
  const events: any[] = [];
  let scenario = '',
    active = 0,
    maxActive = 0,
    posts = 0,
    hold = 60,
    ignoreAbort = false,
    remoteBusy = false,
    barrier = false;
  let slotWaiters: any[] = [];
  function event(kind: string, extra = {}) {
    events.push({ atMs: performance.now(), scenario, kind, active, ...extra });
  }
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url?.startsWith('/slots')) {
      event('slot_check');
      if (barrier) {
        slotWaiters.push(res);
        if (slotWaiters.length === 2) {
          for (const r of slotWaiters)
            r.writeHead(200, { 'content-type': 'application/json' }).end('[]');
          slotWaiters = [];
        }
        return;
      }
      res
        .writeHead(remoteBusy || active > 0 ? 503 : 200, { 'content-type': 'application/json' })
        .end('[]');
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    const task: Task = payload.response_format.schema.properties.label
      ? 'topic_label'
      : payload.response_format.schema.properties.objectives
        ? 'learning_objectives'
        : 'qa_summary';
    posts++;
    active++;
    maxActive = Math.max(maxActive, active);
    event('job_start', { task });
    let finished = false;
    const finish = (kind: string) => {
      if (finished) return;
      finished = true;
      active--;
      event(kind, { task });
    };
    const timer = setTimeout(() => {
      finish('job_complete');
      if (!res.destroyed)
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'controlled-http-fixture-NOT-LLM',
            choices: [{ message: { content: JSON.stringify(outputs[task]) } }],
          }),
        );
    }, hold);
    res.on('close', () => {
      if (!finished) {
        event('http_disconnect', { task, ignoreAbort });
        if (!ignoreAbort) {
          clearTimeout(timer);
          finish('job_abort');
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  async function begin(name: string, timeout = 2000) {
    await until(() => active === 0);
    scenario = name;
    maxActive = 0;
    posts = 0;
    hold = 60;
    ignoreAbort = false;
    remoteBusy = false;
    barrier = false;
    configure(port, timeout);
  }
  try {
    for (let repeat = 1; repeat <= 3; repeat++) {
      for (const first of TYPES)
        for (const second of TYPES)
          if (first !== second) {
            await begin(`pair:${first}->${second}:r${repeat}`);
            const firstJob = invoke(first);
            await until(() => active === 1);
            const start = performance.now();
            const rejected = await invoke(second);
            const rejectMs = performance.now() - start;
            const completed = await firstJob;
            assert.equal(reason(rejected), 'busy');
            assert.equal(completed.status, 'completed');
            assert.equal(maxActive, 1);
            assert.equal(posts, 1);
            rows.push({
              scenario,
              first,
              second,
              firstStatus: completed.status,
              secondStatus: rejected.status,
              secondReason: reason(rejected),
              rejectMs,
              maxActive,
              posts,
              passed: true,
            });
          }
      for (const first of TYPES) {
        await begin(`triple:${first}:r${repeat}`);
        const ordering = [first, ...TYPES.filter((x) => x !== first)];
        const results = await Promise.all(ordering.map((x) => invoke(x)));
        assert.equal(results.filter((x) => x.status === 'completed').length, 1);
        assert.equal(results.filter((x) => reason(x) === 'busy').length, 2);
        assert.equal(posts, 1);
        assert.equal(maxActive, 1);
        rows.push({
          scenario,
          ordering,
          results: results.map((x) => ({ status: x.status, reason: reason(x) })),
          maxActive,
          posts,
          passed: true,
        });
      }
    }
    for (const type of TYPES)
      for (const mode of ['abort', 'timeout'] as const) {
        await begin(`${mode}:${type}`, mode === 'timeout' ? 1000 : 2000);
        hold = 1500;
        const controller = new AbortController();
        const first = invoke(type, controller.signal);
        await until(() => active === 1);
        if (mode === 'abort') controller.abort();
        const outcome = await first;
        assert.equal(reason(outcome), mode === 'abort' ? 'aborted' : 'timeout');
        await until(() => active === 0);
        hold = 20;
        const reused = await invoke(type);
        assert.equal(reused.status, 'completed');
        assert.equal(maxActive, 1);
        rows.push({
          scenario,
          task: type,
          status: outcome.status,
          reason: reason(outcome),
          reused: reused.status,
          maxActive,
          posts,
          passed: true,
        });
      }
    for (const type of TYPES) {
      await begin(`abort-remote-keeps-working:${type}`);
      hold = 250;
      ignoreAbort = true;
      const controller = new AbortController();
      const first = invoke(type, controller.signal);
      await until(() => active === 1);
      controller.abort();
      const outcome = await first;
      assert.equal(reason(outcome), 'aborted');
      const rejected = await invoke(type);
      assert.equal(reason(rejected), 'busy');
      assert.equal(posts, 1);
      await until(() => active === 0);
      ignoreAbort = false;
      hold = 20;
      const reused = await invoke(type);
      assert.equal(reused.status, 'completed');
      rows.push({
        scenario,
        reason: reason(outcome),
        immediateRetry: reason(rejected),
        retryAfterRemoteFree: reused.status,
        maxActive,
        posts,
        passed: true,
      });
    }
    // Controlled TOCTOU counterexample: two separate Node clients see the same free slot.
    for (let repeat = 1; repeat <= 3; repeat++) {
      await begin(`two-process-slot-check-race:r${repeat}`);
      barrier = true;
      hold = 80;
      const children = TYPES.slice(0, 2).map((type) =>
        fork(fileURLToPath(import.meta.url), ['worker', String(port), type], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        }),
      );
      const ready = children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.on('message', (msg: any) => {
              if (msg.ready) resolve();
            });
            child.on('error', reject);
            child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
          }),
      );
      const done = children.map(
        (child) =>
          new Promise<any>((resolve, reject) => {
            child.on('message', (msg: any) => {
              if (msg.result) resolve(msg.result);
            });
            child.on('error', reject);
            child.on('exit', (code) => {
              if (code) reject(new Error(`child exit ${code}`));
            });
          }),
      );
      await Promise.all(ready);
      children.forEach((x) => x.send('go'));
      const results = await Promise.all(done);
      assert.equal(maxActive, 2);
      assert.equal(posts, 2);
      assert(results.every((x) => x.status === 'completed'));
      rows.push({
        scenario,
        maxActive,
        posts,
        results: results.map((x) => x.status),
        passed: true,
        meaning:
          'controlled counterexample; fixture permits two jobs; NOT measured llama-server behavior',
      });
    }
    const report = {
      schemaVersion: 1,
      evidence: 'controlled HTTP fault injection, no LLM',
      baseCommit: '87c39334619fbcb0c5782b061da1ba0df0ba3142',
      createdAt: new Date().toISOString(),
      node: process.version,
      assertionsPassed: rows.length,
      summaryPath: 'V2 (not legacy SummaryV1)',
      scope:
        'Release client+real Node HTTP+schema validation; session purge registration and DB context acquisition stubbed at module boundary; no UI/DB/runtime inference tested',
      rows,
      events,
    };
    writeFileSync(
      resolve(directory, 'controlled-results.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    const fields = [
      'scenario',
      'first',
      'second',
      'task',
      'firstStatus',
      'secondStatus',
      'secondReason',
      'rejectMs',
      'maxActive',
      'posts',
      'passed',
    ];
    writeFileSync(
      resolve(directory, 'controlled-matrix.csv'),
      fields.join(',') +
        '\n' +
        rows.map((row) => fields.map((k) => JSON.stringify(row[k] ?? '')).join(',')).join('\n') +
        '\n',
    );
    console.log(
      JSON.stringify({ passed: rows.length, raw: resolve(directory, 'controlled-results.json') }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
