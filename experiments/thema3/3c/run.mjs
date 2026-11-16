import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import {
  MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
  MODERATION_PROMPT_CONTEXT_REFERENCE_FIXTURE_V1,
  MODERATION_PROMPT_CONTEXT_MINIMAL_FIXTURE_V1,
  MODERATION_PROMPT_REFERENCE_TEXT_FIXTURE_V1,
  ModerationAnalysisContextV1Schema,
  calculateModerationQaBestScoreV1,
  calculateModerationQaControversyScoreV1,
} from '@arsnova/shared-types';
import {
  packModerationPromptContext,
  hashModerationAnalysisForPacking,
  ModerationPromptPackingCache,
} from '../../../apps/backend/src/lib/moderationPromptContextPacking.ts';
import {
  QA_SUMMARY_MODERATION_PACKING_PROFILE as profile,
  prepareModerationSummaryContextFromAnalysis,
  prepareFreshModerationSummaryContext,
} from '../../../apps/backend/src/lib/moderationSummaryContext.ts';
import * as llmConfig from '../../../apps/backend/src/lib/openWeightLlmConfig.ts';
import * as summaryConfig from '../../../apps/backend/src/lib/qaSummaryConfig.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baselineCommit = '87c39334619fbcb0c5782b061da1ba0df0ba3142';
execFileSync(
  'git',
  ['diff', '--exit-code', baselineCommit, '--', 'apps/backend/src', 'libs/shared-types/src'],
  { cwd: root, stdio: 'pipe' },
);
const out = path.resolve(process.argv[2] ?? 'experiment-results/3c');
fs.mkdirSync(out, { recursive: true });
const raw = [];
const checks = [];
const clone = structuredClone;
const packedAt = new Date('2026-11-16T10:00:00.000Z');
function check(name, condition, detail) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, detail });
}
function analysis(fixture = MODERATION_PROMPT_CONTEXT_REFERENCE_FIXTURE_V1) {
  const value = clone(fixture);
  return ModerationAnalysisContextV1Schema.parse({
    schemaVersion: value.schemaVersion,
    contractVersion: MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
    assembledAt: packedAt.toISOString(),
    context: { ...value.context, representation: 'analysis-candidates' },
  });
}
function fixture(total, candidates) {
  const a = analysis(MODERATION_PROMPT_CONTEXT_MINIMAL_FIXTURE_V1);
  const prototype = clone(a.context.questions.items[0]);
  a.context.scope.selectionLimits.questions = candidates;
  a.context.questions.participantBasis = {
    state: 'available',
    kind: 'session-participant-record-count',
    value: 5000,
    calculationVersion: 'qa-ranking-v1',
  };
  a.context.questions.corpus = {
    total,
    eligible: total,
    analyzed: candidates,
    deduplicated: candidates,
    represented: candidates,
  };
  a.context.questions.items = [];
  a.context.sources = [];
  for (let i = 0; i < candidates; i++) {
    const id = `qa-question:${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`;
    a.context.questions.items.push({ ...clone(prototype), sourceId: id });
    a.context.sources.push({
      id,
      kind: 'qa-question',
      content: {
        state: 'included',
        text: MODERATION_PROMPT_REFERENCE_TEXT_FIXTURE_V1[i % 6].text + ` Variante ${i + 1}.`,
        truncated: false,
      },
    });
  }
  return ModerationAnalysisContextV1Schema.parse(a);
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
function packedInfo(p) {
  return {
    hash: p.snapshotHash,
    questions: p.context.questions.state === 'available' ? p.context.questions.items.length : 0,
    textSources: p.context.sources.filter(
      (s) => s.kind === 'qa-question' && s.content.state === 'included',
    ).length,
    packedInputUpperBound: p.budget.packedInputTokens,
    contextWindow: p.budget.contextWindowTokens,
    truncations: p.budget.truncations,
    selectedSourceIds: p.context.sources.map((s) => s.id),
  };
}

// Own execution of the six-question didactic reference, without changing it.
const anchor = analysis();
let directFailure = null;
try {
  packModerationPromptContext({ analysis: anchor, profile, packedAt });
} catch (e) {
  directFailure = String(e.message);
}
const prepared = prepareModerationSummaryContextFromAnalysis({ analysis: anchor, packedAt });
check(
  'rich six-question metadata exceeds fixed budget',
  directFailure === 'Moderation prompt base metadata exceeds the configured context budget.',
  directFailure,
);
check(
  'release fallback retains exactly one question text',
  packedInfo(prepared.request.promptContext).textSources === 1,
  packedInfo(prepared.request.promptContext),
);
fs.writeFileSync(
  path.join(out, 'anchor-summary-request.json'),
  JSON.stringify(prepared.request, null, 2),
);

// Scale is a synthetic bounded projection; no DB scan or 25,000 HTTP requests.
for (const total of [6, 50, 500, 5000, 25000]) {
  for (const cap of [40, 200]) {
    const candidates = Math.min(total, cap);
    const a = fixture(total, candidates);
    // Warm up the real exported preparation path before collecting 15 runs.
    for (let i = 0; i < 3; i++)
      prepareModerationSummaryContextFromAnalysis({ analysis: a, packedAt });
    const timings = [];
    let last;
    for (let repeat = 0; repeat < 15; repeat++) {
      const start = performance.now();
      last = prepareModerationSummaryContextFromAnalysis({ analysis: a, packedAt }).request
        .promptContext;
      const ms = performance.now() - start;
      timings.push(ms);
      raw.push({
        experiment: 'prepare',
        total,
        candidateCap: cap,
        candidates,
        repeat,
        ms,
        ...packedInfo(last),
      });
    }
    check(
      `fixed budget ${total}/${cap}`,
      last.budget.packedInputTokens + 640 + 128 <= 4096,
      packedInfo(last),
    );
  }
}

// Semantic invalidation using the real fresh-context wrapper and global cache.
globalThis.__thema3AuthorizedAnalysis = clone(anchor);
globalThis.__thema3ContextReads = 0;
const fresh = () =>
  prepareFreshModerationSummaryContext({
    sessionId: 'synthetic-six-question-session',
    locale: 'de',
    access: {},
    packedAt,
  });
const cold = await fresh();
const warm = await fresh();
check(
  'identical fresh snapshot gives cache hit',
  cold.preview.cache === 'miss' && warm.preview.cache === 'hit',
  { cold: cold.preview.cache, warm: warm.preview.cache },
);
check('context acquisition still precedes warm cache', globalThis.__thema3ContextReads === 2, {
  reads: globalThis.__thema3ContextReads,
});

const changedVotes = clone(anchor);
// Change a real vote count and the revision of the underlying vote snapshot.
const v = changedVotes.context.questions.items[0].votes;
v.positive++;
v.net++;
v.total++;
v.bestScore.value = calculateModerationQaBestScoreV1({
  positive: v.positive,
  negative: v.negative,
});
v.controversyScore.value = calculateModerationQaControversyScoreV1({
  positive: v.positive,
  negative: v.negative,
  participantBasis: 200,
});
changedVotes.context.meta.revisions.questionVotes.value = 'question-votes-own-change';
// Individual scores use the released ranking formulas. The topic/compass
// projection stays fixed: this case isolates freshness, not aggregate rebuilding.
globalThis.__thema3AuthorizedAnalysis = ModerationAnalysisContextV1Schema.parse(changedVotes);
const vote = await fresh();
check(
  'vote-only snapshot invalidates cache',
  vote.preview.cache === 'miss' &&
    vote.request.promptContext.snapshotHash !== warm.request.promptContext.snapshotHash,
  { cache: vote.preview.cache },
);

const changedClock = clone(anchor);
changedClock.context.learningContext.objectives[0].confirmation.confirmedAt =
  '2026-11-16T10:05:00.000Z';
check(
  'confirmation clock alone is nonsemantic',
  hashModerationAnalysisForPacking(anchor, profile) ===
    hashModerationAnalysisForPacking(changedClock, profile),
);
const unconfirmed = clone(anchor);
unconfirmed.context.learningContext.objectives[0].confirmation = { state: 'draft' };
unconfirmed.context.meta.revisions.learningObjectives.value = 'objectives-unconfirmed';
globalThis.__thema3AuthorizedAnalysis = ModerationAnalysisContextV1Schema.parse(unconfirmed);
const beforeConfirm = await fresh();
globalThis.__thema3AuthorizedAnalysis = anchor;
const afterConfirm = await fresh();
check(
  'confirmation state changes semantic hash',
  beforeConfirm.request.promptContext.snapshotHash !==
    afterConfirm.request.promptContext.snapshotHash,
  { before: beforeConfirm.preview.cache, after: afterConfirm.preview.cache },
);

// Factorial laboratory policy comparison. Same packing profile in all cells.
// Existing class constructor permits custom TTL; this is not an environment flag.
for (const total of [500, 25000])
  for (const cap of [40, 200])
    for (const ttlMs of [5000, 30000])
      for (const changeEverySeconds of [0, 5, 20]) {
        let clock = 0;
        const cache = new ModerationPromptPackingCache({ ttlMs, now: () => clock });
        const a = fixture(total, Math.min(total, cap));
        // Use the actual release text-only fallback representation obtained through
        // the original wrapper: recreate it by intercepting the authorized input is
        // deliberately avoided here. Minimal Q&A fixture can be packed directly.
        let hits = 0,
          misses = 0;
        const timings = [];
        for (let second = 0; second < 61; second++) {
          clock = second * 1000;
          a.context.meta.revisions.questionVotes.value =
            'votes-' + (changeEverySeconds ? Math.floor(second / changeEverySeconds) : 0);
          const start = performance.now();
          let result;
          try {
            result = cache.getOrPackFreshlyAuthorized({
              sessionId: 'ttl-lab',
              analysis: a,
              profile,
              packedAt,
            });
          } catch (e) {
            throw new Error('Minimal fixture must pack directly for TTL experiment: ' + e.message);
          }
          const ms = performance.now() - start;
          timings.push(ms);
          if (result.cache === 'hit') hits++;
          else misses++;
          raw.push({
            experiment: 'cache',
            total,
            candidateCap: cap,
            ttlMs,
            changeEverySeconds,
            second,
            cache: result.cache,
            ms,
            hash: result.promptContext.snapshotHash,
          });
        }
        raw.push({
          experiment: 'cache-summary',
          total,
          candidateCap: cap,
          ttlMs,
          changeEverySeconds,
          hits,
          misses,
          hitRate: hits / 61,
          timing: stats(timings),
        });
      }

const config = {
  profile,
  labelTimeoutMs: llmConfig.OPEN_WEIGHT_LLM_LABEL_TIMEOUT_DEFAULT_MS,
  summaryClientTimeoutMs: llmConfig.OPEN_WEIGHT_LLM_SUMMARY_TIMEOUT_DEFAULT_MS,
  learningClientTimeoutMs: llmConfig.OPEN_WEIGHT_LLM_LEARNING_TIMEOUT_DEFAULT_MS,
  summaryProcessorTimeoutMs: summaryConfig.QA_SUMMARY_TIMEOUT_DEFAULT_MS,
};
// Controlled fixed-budget sensitivity: votes are either present or explicitly
// unavailable; removing them is information loss, not a transparent speedup.
const sensitivity = [];
for (const textLength of [20, 80, 200, 500])
  for (const voteMetadata of ['available', 'unavailable']) {
    const a = fixture(25000, 200);
    for (let i = 0; i < a.context.sources.length; i++) {
      a.context.sources[i].content.text = (
        `Frage ${String(i + 1).padStart(3, '0')}: ` + 'x'.repeat(textLength)
      ).slice(0, textLength);
      if (voteMetadata === 'unavailable')
        a.context.questions.items[i].votes = { state: 'unavailable', reason: 'not-collected' };
    }
    const valid = ModerationAnalysisContextV1Schema.parse(a);
    const result = prepareModerationSummaryContextFromAnalysis({ analysis: valid, packedAt })
      .request.promptContext;
    const row = { textLength, voteMetadata, ...packedInfo(result) };
    sensitivity.push(row);
    check(
      `sensitivity budget ${textLength}/${voteMetadata}`,
      result.budget.packedInputTokens + 640 + 128 <= 4096,
      row,
    );
  }
check(
  'scaled nonempty context exists without vote metadata',
  sensitivity.some((r) => r.voteMetadata === 'unavailable' && r.textSources > 0),
);
fs.writeFileSync(path.join(out, 'baseline-config.json'), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(out, 'raw.json'), JSON.stringify(raw, null, 2));
fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
const groups = [];
for (const total of [6, 50, 500, 5000, 25000])
  for (const cap of [40, 200]) {
    const rows = raw.filter(
      (r) => r.experiment === 'prepare' && r.total === total && r.candidateCap === cap,
    );
    groups.push({
      total,
      candidateCap: cap,
      candidates: rows[0].candidates,
      textSources: rows[0].textSources,
      inputUpperBound: rows[0].packedInputUpperBound,
      ms: stats(rows.map((r) => r.ms)),
    });
  }
const summary = {
  generatedAt: new Date().toISOString(),
  baselineCommit,
  experimentCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  applicationCodeUnchanged: true,
  node: process.version,
  evidence:
    'Executed release component code with synthetic authorized analysis; no DB, HTTP authorization, real tokenizer or model runtime.',
  checksPassed: checks.length,
  boundaries: [
    'Synthetic projected candidate graph; total forum sizes are metadata, not scanned DB rows.',
    '5,000 participants is a modeled room basis, not 5,000 connected clients.',
    'UTF-8 upper bound is not actual tokenizer count.',
    'Cache input adapter does not test authorization, access revocation or purge propagation.',
    'No real prefill, generative latency, analysis quality or complete display-age measurement.',
  ],
  preparation: groups,
  cache: raw.filter((r) => r.experiment === 'cache-summary'),
  sensitivity,
  anchor: packedInfo(prepared.request.promptContext),
  config,
};
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
