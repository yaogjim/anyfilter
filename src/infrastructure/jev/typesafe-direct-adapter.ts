import { inputTokensFrom, questionsAs, scoresFrom } from './jev-payload';
import { readModel, readUsage, type ProviderAdapter } from './provider-adapter';

export const typesafeDirectAdapter: ProviderAdapter = {
  id: 'typesafe',
  model: 'jev-latest',
  buildRequest: (key, state, questions) => ({
    url: 'https://api.typesafe.ai/v1/systemone',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: { model: 'jev-latest', state, questions: questionsAs(questions, 'noul') },
  }),
  parseScores: (json) => scoresFrom(json, 'noul'),
  inputTokens: (json) => inputTokensFrom(json, 'input_tokens'),
  // TypeSafe direct reports the versioned model it actually ran (e.g.
  // "jev-1.13.0"), plus `usage.input_tokens` / `usage.output_tokens`. It reports
  // no cost of its own, so `cost` stays unknown rather than being guessed.
  readMetadata: (json) => ({
    model: readModel(json),
    ...readUsage(json, { inputTokens: 'input_tokens', outputTokens: 'output_tokens' }),
    cost: undefined,
  }),
};