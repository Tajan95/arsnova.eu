import {
  MODERATION_PROMPT_CONTEXT_MINIMAL_FIXTURE_V1,
  MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
  ModerationAnalysisContextV1Schema,
  OpenWeightLlmRequestSchema,
} from '@arsnova/shared-types';
import {
  QA_SUMMARY_ADAPTER_CAPABILITIES,
  prepareModerationSummaryContextFromAnalysis,
} from '../../../apps/backend/src/lib/moderationSummaryContext';
import {
  runOpenWeightLlmTopicLabel,
  runOpenWeightLlmSummaryV2,
  runOpenWeightLlmLearningObjectives,
} from '../../../apps/backend/src/lib/openWeightLlmClient';

export const TYPES = ['topic_label', 'qa_summary', 'learning_objectives'] as const;
export type Task = (typeof TYPES)[number];
export const SOURCE = 'qa-question:11111111-1111-4111-8111-111111111111';
export const QUESTION = '22222222-2222-4222-8222-222222222222';
const fixture = structuredClone(MODERATION_PROMPT_CONTEXT_MINIMAL_FIXTURE_V1);
const analysis = ModerationAnalysisContextV1Schema.parse({
  schemaVersion: fixture.schemaVersion,
  contractVersion: MODERATION_ANALYSIS_CONTEXT_CONTRACT_VERSION,
  assembledAt: '2026-11-16T12:00:00.000Z',
  context: { ...fixture.context, representation: 'analysis-candidates' },
});
const prepared = prepareModerationSummaryContextFromAnalysis({
  analysis,
  plan: {
    capabilities: QA_SUMMARY_ADAPTER_CAPABILITIES,
    selectedMode: 'full-context',
    fallback: null,
    inferenceConfigured: true,
  },
  packedAt: new Date('2026-11-16T12:00:01.000Z'),
});
export const requests = {
  topic_label: {
    schemaVersion: 1,
    taskType: 'topic_label',
    locale: 'de',
    clusterId: 'referat-regression',
    sources: [
      { id: SOURCE, text: 'Können wir mehr Beispiele zur linearen Regression bearbeiten?' },
    ],
  },
  qa_summary: prepared.request,
  learning_objectives: {
    schemaVersion: 1,
    taskType: 'learning_objectives',
    locale: 'de',
    requestId: '33333333-3333-4333-8333-333333333333',
    questions: [
      {
        id: QUESTION,
        text: 'Welche Gerade beschreibt y = 2x + 1?',
        answerOptions: [
          { text: 'Steigung 2, Achsenabschnitt 1', isCorrect: true },
          { text: 'Steigung 1, Achsenabschnitt 2', isCorrect: false },
        ],
      },
    ],
  },
};
for (const type of TYPES) OpenWeightLlmRequestSchema.parse(requests[type]);
export const outputs = {
  topic_label: {
    schemaVersion: 1,
    taskType: 'topic_label',
    label: 'Regression: Beispiele',
    sourceIds: [SOURCE],
  },
  qa_summary: {
    schemaVersion: 2,
    taskType: 'qa_summary',
    outputContract: 'qa-summary-model-output-v2',
    output: {
      status: 'ready',
      statements: [
        {
          text: 'Es werden weitere Regressionsbeispiele gewünscht.',
          sourceIds: [prepared.request.promptContext.context.sources[0].id],
        },
      ],
      suggestedNextSteps: [],
      limitations: [],
    },
  },
  learning_objectives: {
    schemaVersion: 1,
    taskType: 'learning_objectives',
    objectives: [
      {
        text: 'Die Studierenden können Steigung und Achsenabschnitt einer linearen Funktion bestimmen.',
        questionIds: [QUESTION],
      },
    ],
    limitations: [],
  },
};
export function invoke(type: Task, signal?: AbortSignal) {
  if (type === 'topic_label')
    return runOpenWeightLlmTopicLabel(requests.topic_label as any, outputs.topic_label as any, {
      signal,
    });
  if (type === 'qa_summary') return runOpenWeightLlmSummaryV2(requests.qa_summary, { signal });
  return runOpenWeightLlmLearningObjectives(requests.learning_objectives as any, { signal });
}
