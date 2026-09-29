import { inputTokensFrom, questionsAs, scoresFrom } from './jev-payload';
import {
  asRecord,
  costAmount,
  readModel,
  readUsage,
  type ProviderAdapter,
} from './provider-adapter';

/** Cost the AI Gateway reports for one response, read from
 * `providerMetadata.gateway.cost` (a decimal string such as "0.00001155"). Any
 * other shape, or a missing field, is `undefined`. The separate `marketCost`,
 * `surchargeCost` and `gatewayCost` figures are not substituted here. */
export function readGatewayCost(json: unknown): number | undefined {
  const gateway = asRecord(asRecord(asRecord(json).providerMetadata).gateway);
  return costAmount(gateway.cost);
}

export const vercelGatewayAdapter: ProviderAdapter = {
  id: 'vercel',
  model: 'typesafe-ai/jev',
  buildRequest: (key, state, questions) => ({
    url: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'ai-model-id': 'typesafe-ai/jev',
      'ai-gateway-protocol-version': '0.0.1',
      'ai-gateway-auth-method': 'api-key',
    },
    body: { state, questions: questionsAs(questions, 'boolean') },
  }),
  parseScores: (json) => scoresFrom(json, 'probability'),
  inputTokens: (json) => inputTokensFrom(json, 'inputTokens'),
  // The gateway reports the model that ran (`model`), camelCase token usage
  // (`usage.inputTokens` / `usage.outputTokens`) and its charge in
  // `providerMetadata.gateway.cost`. A missing field stays unknown.
  readMetadata: (json) => ({
    model: readModel(json),
    ...readUsage(json, { inputTokens: 'inputTokens', outputTokens: 'outputTokens' }),
    cost: readGatewayCost(json),
  }),
};