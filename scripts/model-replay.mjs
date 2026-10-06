import { readFile, writeFile } from 'node:fs/promises';
import { decisionRequest, providerConfig } from './mobile-agent/providers.mjs';
import { validateChoice } from './mobile-agent/policy.mjs';
import { decodeJson } from './mobile-agent/http.mjs';
const [input, output] = process.argv.slice(2);
const source = (await readFile(input, 'utf8'))
  .trim()
  .split('\n')
  .map((x) => JSON.parse(x));
const requests = source
  .filter((x) => x.event === 'model_request')
  .map((x) => x.body)
  .slice(0, 12);
const reports = [];
for (const state of requests)
  for (const backend of ['jev', 'rizzo', 'tev1']) {
    const config = providerConfig(backend),
      started = performance.now();
    try {
      const answer = decodeJson(
        await decisionRequest({
          url: config.url,
          apiKey: process.env.TYPESAFE_API_KEY,
          method: 'POST',
          body: { ...state, model: config.model },
        }),
      );
      for (const [key, q] of Object.entries(state.questions))
        validateChoice(answer.answers[key], q.criteria);
      reports.push({
        packet: requests.indexOf(state),
        backend,
        model: answer.model,
        latencyMs: performance.now() - started,
        answers: answer.answers,
        usage: answer.usage,
        adapterCalls: answer.adapterCalls,
        probabilitySource: answer.probabilitySource || 'backend-reported',
      });
    } catch (error) {
      reports.push({
        packet: requests.indexOf(state),
        backend,
        error: error.message,
        latencyMs: performance.now() - started,
      });
    }
  }
await writeFile(output, JSON.stringify({ kind: 'saved-packet-replay', reports }, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.log(
  JSON.stringify(
    reports.map((x) => ({
      backend: x.backend,
      model: x.model,
      error: x.error,
      latencyMs: Math.round(x.latencyMs),
    })),
  ),
);
