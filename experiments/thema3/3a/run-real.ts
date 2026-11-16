/** Own REAL runtime observations. No fake completions; token never written. */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetOpenWeightLlmClientForTests } from '../../../apps/backend/src/lib/openWeightLlmClient';
import { resolveOpenWeightLlmConfig } from '../../../apps/backend/src/lib/openWeightLlmConfig';
import { TYPES, requests, invoke, type Task } from './fixtures';
import {
  OpenWeightLlmRequestSchema,
  OpenWeightLlmOutputSchema,
  hasOnlyAllowedOpenWeightLlmReferences,
} from '@arsnova/shared-types';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const directory = resolve(process.argv[2] ?? 'experiment-results/real');
  mkdirSync(directory, { recursive: true });
  const config = resolveOpenWeightLlmConfig();
  if (!config.enabled || !config.transport || !config.token)
    throw new Error(
      'Set OPEN_WEIGHT_LLM_ENABLED=true, private URL or socket and TOKEN; no synthetic fallback is used.',
    );
  const target = config.transport;
  const directTransport = process.env.REFERAT_DIRECT_TRANSPORT === 'true';
  const repetitions = Number(process.env.REFERAT_REPETITIONS ?? 3);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error('REFERAT_REPETITIONS must be1..10');
  const selectedTypes = process.env.REFERAT_TASKS
    ? (process.env.REFERAT_TASKS.split(',') as Task[])
    : [...TYPES];
  if (!selectedTypes.length || selectedTypes.some((type) => !TYPES.includes(type)))
    throw new Error('Invalid REFERAT_TASKS');
  const phases = new Set(
    (process.env.REFERAT_PHASES ?? 'warmup,baseline,concurrency,abort').split(','),
  );
  if ([...phases].some((phase) => !['warmup', 'baseline', 'concurrency', 'abort'].includes(phase)))
    throw new Error('Invalid REFERAT_PHASES');
  if (process.env.REFERAT_SUMMARY_REQUEST_FILE) {
    const supplied = OpenWeightLlmRequestSchema.parse(
      JSON.parse(readFileSync(process.env.REFERAT_SUMMARY_REQUEST_FILE, 'utf8')),
    );
    if (supplied.taskType !== 'qa_summary' || supplied.schemaVersion !== 2)
      throw new Error('Summary fixture must be V2');
    requests.qa_summary = supplied;
  }
  const rows: any[] = [];
  const runtimeResponses: any[] = [];
  const samples: any[] = [];
  let scenario = '';
  let sampleStop = false;
  function direct(method: string, path: string, body?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = target.kind === 'http' ? new URL(target.baseUrl) : null;
      const send = u?.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        {
          ...(u
            ? { hostname: u.hostname, port: u.port, protocol: u.protocol }
            : { socketPath: (target as any).socketPath }),
          method,
          path,
          headers: {
            authorization: `Bearer ${config.token}`,
            ...(body
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
              : {}),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(text) });
            } catch {
              resolve({ status: res.statusCode, data: text.slice(0, 200) });
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('observer timeout')));
      if (body) req.write(body);
      req.end();
    });
  }
  const relay = createServer((req, res) => {
    const start = performance.now();
    const observedScenario = scenario;
    const u = target.kind === 'http' ? new URL(target.baseUrl) : null;
    const send = u?.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = send(
      {
        ...(u
          ? { hostname: u.hostname, port: u.port, protocol: u.protocol }
          : { socketPath: (target as any).socketPath }),
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: u?.host ?? 'localhost' },
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        const chunks: Buffer[] = [];
        reply.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
          res.write(chunk);
        });
        reply.on('end', () => {
          if (req.url === '/v1/chat/completions') {
            let data: any = {};
            try {
              data = JSON.parse(Buffer.concat(chunks).toString());
            } catch {}
            const content = data.choices?.[0]?.message?.content ?? null;
            let outputValidation: any = { jsonValid: false };
            try {
              const decoded = JSON.parse(content);
              const parsed = OpenWeightLlmOutputSchema.safeParse(decoded);
              const expectedType = observedScenario.split(':')[1] as Task;
              outputValidation = {
                jsonValid: true,
                schemaValid: parsed.success,
                ...(parsed.success
                  ? {
                      referencesValid: hasOnlyAllowedOpenWeightLlmReferences(
                        requests[expectedType] as any,
                        parsed.data,
                      ),
                    }
                  : { issues: parsed.error.issues }),
              };
            } catch (error) {
              outputValidation = { jsonValid: false, error: String(error) };
            }
            runtimeResponses.push({
              scenario: observedScenario,
              elapsedMs: performance.now() - start,
              httpStatus: reply.statusCode,
              model: data.model ?? null,
              usage: data.usage ?? null,
              timings: data.timings ?? null,
              finishReason: data.choices?.[0]?.finish_reason ?? null,
              syntheticModelContent: content,
              outputValidation,
            });
          }
          res.end();
        });
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  const port = (relay.address() as any).port;
  resetOpenWeightLlmClientForTests({
    config: () =>
      directTransport
        ? config
        : { ...config, transport: { kind: 'http', baseUrl: `http://127.0.0.1:${port}` } },
  });
  const observer = (async () => {
    while (!sampleStop) {
      const sampleScenario = scenario;
      try {
        const snapshot = await direct('GET', '/slots');
        samples.push({
          at: new Date().toISOString(),
          timeMs: performance.now(),
          scenario: sampleScenario,
          ...snapshot,
        });
      } catch (error) {
        samples.push({
          at: new Date().toISOString(),
          timeMs: performance.now(),
          scenario: sampleScenario,
          error: String(error),
        });
      }
      await pause(100);
    }
  })();
  async function waitFree() {
    for (let i = 0; i < 600; i++) {
      const s = await direct('GET', '/slots?fail_on_no_slot=1');
      if (s.status === 200) return;
      await pause(100);
    }
    throw new Error('Runtime not free within60s after job; stop to preserve evidence');
  }
  function persist(error?: string) {
    writeFileSync(
      resolve(directory, 'real-results.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          evidence:
            'REAL private runtime through unchanged release client; module boundaries isolated',
          baseCommit: '87c39334619fbcb0c5782b061da1ba0df0ba3142',
          createdAt: new Date().toISOString(),
          node: process.version,
          timeoutsMs: config.timeoutsMs,
          phases: [...phases],
          selectedTypes,
          directTransport,
          maxOutputTokens: config.maxOutputTokens,
          summaryPath: 'V2 direct client (90s default); NOT outer8s app queue',
          observer: directTransport
            ? '100ms GET /slots sampling; direct unchanged release HTTP to runtime, no recording relay in client path'
            : '100ms GET /slots sampling with is_processing counts; cannot exclude events between samples; loopback relay captures usage/timings and forwards abort',
          maxObservedProcessingSlots: Math.max(
            0,
            ...samples
              .filter((sample) => Array.isArray(sample.data))
              .map(
                (sample) => sample.data.filter((slot: any) => slot.is_processing === true).length,
              ),
          ),
          boundary: 'DB context acquisition and session-purge registration stubbed; no UI/DB tests',
          rows,
          runtimeResponses,
          samples,
          error,
        },
        null,
        2,
      ) + '\n',
    );
    const samplesByType = Object.fromEntries(
      TYPES.map((type) => [
        type,
        rows
          .filter((row) => row.type === type && row.scenario.startsWith('baseline:'))
          .map((row) => {
            const response = runtimeResponses.find((item) => item.scenario === row.scenario);
            return {
              duration_ms: row.occupiedUntilObservedFreeMs,
              client_elapsed_ms: row.elapsedMs,
              success: row.result.status === 'completed',
              status: row.result.reason ?? row.result.status,
              input_tokens:
                row.result.telemetry?.promptTokens ?? response?.usage?.prompt_tokens ?? null,
              output_tokens:
                row.result.telemetry?.completionTokens ??
                response?.usage?.completion_tokens ??
                null,
              cached_input_tokens: response?.usage?.prompt_tokens_details?.cached_tokens ?? null,
              processed_prompt_tokens: response?.timings?.prompt_n ?? null,
              prefill_ms: response?.timings?.prompt_ms ?? null,
              decode_ms: response?.timings?.predicted_ms ?? null,
            };
          }),
      ]),
    );
    writeFileSync(
      resolve(directory, 'calibration.json'),
      JSON.stringify(
        {
          schema_version: 1,
          evidence: 'real_private_runtime',
          baseline_commit: '87c39334619fbcb0c5782b061da1ba0df0ba3142',
          environment_manifest:
            process.env.REFERAT_ENVIRONMENT_MANIFEST ??
            'environment manifest pending; see real-results.json and runtime manifest',
          scope:
            'direct client V2 Summary90s; duration measured from client start through first free-slot observation after return, conservative occupancy proxy incl HTTP overhead; excludes outer8s queue, warmups and immediate busy rejections. Repeated fixed fixtures may have nearly complete runtime KV reuse: inspect cached_input_tokens and processed_prompt_tokens. Application-cache hit probability0 in a simulation does NOT disable runtime KV caching; these durations do not establish cold new-context capacity.',
          samples: samplesByType,
        },
        null,
        2,
      ) + '\n',
    );
  }
  try {
    const health = await direct('GET', '/health');
    if (health.status !== 200) throw new Error('Real model runtime not healthy');
    writeFileSync(
      resolve(directory, 'synthetic-requests.json'),
      JSON.stringify(requests, null, 2) + '\n',
    );
    if (phases.has('warmup'))
      for (const type of selectedTypes) {
        await waitFree();
        scenario = `warmup:${type}`;
        const start = performance.now();
        const result = await invoke(type);
        rows.push({ scenario, type, elapsedMs: performance.now() - start, result });
        persist();
      }
    if (phases.has('baseline'))
      for (let repeat = 1; repeat <= repetitions; repeat++)
        for (const type of selectedTypes) {
          await waitFree();
          scenario = `baseline:${type}:r${repeat}`;
          const start = performance.now();
          const result = await invoke(type);
          const elapsedMs = performance.now() - start;
          await waitFree();
          rows.push({
            scenario,
            type,
            elapsedMs,
            occupiedUntilObservedFreeMs: performance.now() - start,
            result,
          });
          persist();
        }
    // Same-process simultaneous calls; actual runtime is observed independently.
    if (phases.has('concurrency'))
      for (const first of selectedTypes) {
        await waitFree();
        scenario = `real-triple:${first}`;
        const order = [first, ...TYPES.filter((x) => x !== first)];
        const start = performance.now();
        const results = await Promise.all(order.map((type) => invoke(type)));
        rows.push({ scenario, order, elapsedMs: performance.now() - start, results });
        persist();
      }
    // Controlled caller-abort variant for each type; exact runtime slot recovery measured.
    if (phases.has('abort'))
      for (const type of selectedTypes) {
        await waitFree();
        scenario = `real-caller-abort:${type}`;
        const controller = new AbortController();
        const start = performance.now();
        const timer = setTimeout(() => controller.abort(), type === 'qa_summary' ? 8000 : 1000);
        const result = await invoke(type, controller.signal);
        clearTimeout(timer);
        const returnedAt = performance.now();
        const firstSlot = await direct('GET', '/slots?fail_on_no_slot=1');
        await waitFree();
        const observedRemoteFreeAfterReturnMs = performance.now() - returnedAt;
        const processingObservedBeforeReturn = samples.some(
          (sample) =>
            sample.scenario === scenario &&
            sample.timeMs <= returnedAt &&
            (sample.status === 503 ||
              (Array.isArray(sample.data) &&
                sample.data.some((slot: any) => slot.is_processing === true))),
        );
        const abortedScenario = scenario;
        scenario = `reuse-after-abort:topic_label:after-${type}`;
        const reuseStartedAt = performance.now();
        const reuseProbe = await invoke('topic_label');
        const reuseElapsedMs = performance.now() - reuseStartedAt;
        await waitFree();
        rows.push({
          scenario: abortedScenario,
          type,
          abortBudgetMs: type === 'qa_summary' ? 8000 : 1000,
          result,
          elapsedMs: returnedAt - start,
          firstSlotAfterReturn: firstSlot,
          observedRemoteFreeAfterReturnMs,
          processingObservedBeforeReturn,
          reuseProbe: { task: 'topic_label', elapsedMs: reuseElapsedMs, result: reuseProbe },
          meaning:
            type === 'qa_summary'
              ? '8s caller-abort variant inspired by queue deadline, NOT execution of the app queue'
              : 'caller-abort variant',
        });
        persist();
      }
    console.log(
      JSON.stringify({
        rows: rows.length,
        completed: rows.filter((x) => x.result?.status === 'completed').length,
        output: directory,
      }),
    );
  } catch (error) {
    persist(String(error));
    throw error;
  } finally {
    sampleStop = true;
    await observer;
    relay.closeAllConnections();
    await new Promise<void>((r) => relay.close(() => r()));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
