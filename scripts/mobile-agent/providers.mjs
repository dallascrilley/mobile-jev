import { pooledRequest, decodeJson } from './http.mjs';

export const PROVIDERS = {
  jev: { model: 'jev-1.13.0', url: 'https://api.typesafe.ai/v1/systemone' },
  rizzo: { model: 'rizzo-flow-4b-q8_0', url: 'http://127.0.0.1:18094/v1/systemone' },
  tev1: { model: 'tev1:4b-q4_K_M', url: 'http://127.0.0.1:11434/v1/systemone' },
};

export const LOCAL_PROVIDER_PINS = Object.freeze({
  rizzo: Object.freeze({
    healthUrl: 'http://127.0.0.1:18094/health',
    modelFields: Object.freeze({
      source: 'XHToken/Spark-X2.5-4B',
      requested_revision: '0bcb35678590218655dff3765b9e61c83b35e9c4',
      gguf_source: 'rizzoaiacademy/rizzo-flow',
      gguf_revision: '55633c8cbd2b826bd3eefdeb05310450996649df',
      source_files: Object.freeze({
        'rizzo-flow-4b-q8.gguf': 'dbec3c89d33984772324e65a8ed56b48e958e301b856cb870a7c1b385d01691a',
      }),
      precision: 'q8_0',
      device: 'gpu',
      backend: 'mtl',
      runtime: 'llama.cpp',
      llama_cpp_release: 'b11081',
      llama_cpp_commit: '161755f29e415e2c33efe906e91843c068efd664',
      prompt_version: 'spark-decisions-v3',
      weights: 'flow',
      fingerprint: '5310c906db493b1a2414d9ae25b9fd7f0d15fd28e5b593810ce17f4d87bf7ae8',
    }),
    modelsUrl: 'http://127.0.0.1:18094/v1/models',
    model: PROVIDERS.rizzo.model,
  }),
  tev1: Object.freeze({
    tagsUrl: 'http://127.0.0.1:11434/api/tags',
    model: PROVIDERS.tev1.model,
    digest: '07be32e6e5e3dcc6b2deae7c68b89321e99daeedb08521e92771cc155473cbd9',
  }),
});

export function providerConfig(backend = process.env.DECISION_BACKEND || 'jev') {
  if (!Object.hasOwn(PROVIDERS, backend))
    throw new Error('Decision backend must be jev, rizzo, or tev1.');
  return { backend, ...PROVIDERS[backend] };
}

async function readBounded(response, maxBytes = 1024 * 1024) {
  const declaredLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error('Local provider preflight response is too large.');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Local provider preflight response is too large.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function getPinnedResponse(fetcher, url) {
  let response;
  try {
    response = await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
  } catch {
    throw new Error('Selected local decision provider failed its identity preflight.');
  }
  if (!response?.ok)
    throw new Error('Selected local decision provider failed its identity preflight.');
  return readBounded(response);
}

function parsePinnedJson(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Selected local decision provider returned invalid identity data.');
  }
}

export function createProviderPreflight({
  fetcher = globalThis.fetch,
  pins = LOCAL_PROVIDER_PINS,
  cache = new Map(),
} = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('A fetch implementation is required.');
  return async (backend) => {
    if (backend === 'jev') return;
    if (!Object.hasOwn(pins, backend)) throw new Error('No identity pin exists for this provider.');
    if (cache.has(backend)) return cache.get(backend);
    const pin = pins[backend];
    const verification = (async () => {
      if (backend === 'rizzo') {
        const health = parsePinnedJson(await getPinnedResponse(fetcher, pin.healthUrl));
        const matchesPinnedModel = Object.entries(pin.modelFields).every(
          ([field, expected]) =>
            JSON.stringify(health?.model?.[field]) === JSON.stringify(expected),
        );
        if (health?.status !== 'ready' || !matchesPinnedModel)
          throw new Error('Rizzo health fingerprint does not match the pinned runtime.');
        const models = parsePinnedJson(await getPinnedResponse(fetcher, pin.modelsUrl));
        if (
          !Array.isArray(models?.models) ||
          !models.models.some((entry) => entry?.name === pin.model)
        )
          throw new Error('Rizzo does not serve the pinned decision model.');
        return { backend, model: pin.model, fingerprint: health.model.fingerprint };
      }
      const tags = parsePinnedJson(await getPinnedResponse(fetcher, pin.tagsUrl));
      const model = Array.isArray(tags?.models)
        ? tags.models.find((entry) => entry?.name === pin.model || entry?.model === pin.model)
        : undefined;
      if (!model || model.digest !== pin.digest)
        throw new Error('TEV-1 model digest does not match the pinned model.');
      return { backend, model: pin.model, digest: model.digest };
    })();
    cache.set(backend, verification);
    try {
      return await verification;
    } catch (error) {
      if (cache.get(backend) === verification) cache.delete(backend);
      throw error;
    }
  };
}

const defaultPreflight = createProviderPreflight();

function backendForUrl(url) {
  const match = Object.entries(PROVIDERS).find(([, provider]) => provider.url === url);
  if (!match) throw new Error('Decision provider endpoint is not configured or pinned.');
  return match[0];
}

function validateAnswer(answer, criteria) {
  const ids = Object.keys(criteria || {});
  const probabilities = answer?.probabilities;
  if (
    answer?.type !== 'choice' ||
    !ids.length ||
    !Object.hasOwn(criteria, answer.choice) ||
    !probabilities ||
    typeof probabilities !== 'object' ||
    Array.isArray(probabilities) ||
    Object.keys(probabilities).length !== ids.length ||
    !ids.every((id) => Object.hasOwn(probabilities, id))
  )
    throw new Error('Decision provider returned a choice outside the offered criteria.');
  const values = ids.map((id) => probabilities[id]);
  if (
    ![answer.confidence, ...values].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.025 ||
    probabilities[answer.choice] + 1e-6 < Math.max(...values)
  )
    throw new Error('Decision provider returned an invalid choice distribution.');
  return answer;
}

function validateResponse(result, request) {
  const model = request.body?.model;
  if (!model || result?.model !== model)
    throw new Error('Decision provider response model does not match the requested model.');
  const answers = result.answers;
  if (answers === undefined) return result;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers))
    throw new Error('Decision provider returned invalid answers.');
  for (const [key, answer] of Object.entries(answers)) {
    const question = request.body?.questions?.[key];
    if (!question) throw new Error('Decision provider answered an unrequested question.');
    validateAnswer(answer, question.criteria);
  }
  return result;
}

export async function decisionRequest(
  request,
  transport = pooledRequest,
  { preflight = defaultPreflight } = {},
) {
  const provider = backendForUrl(request.url);
  const isLocal = provider !== 'jev';
  if (typeof request.body?.model !== 'string' || !request.body.model)
    throw new Error('A requested decision model is required.');
  await preflight(provider);
  if (isLocal && request.body.model !== PROVIDERS[provider].model)
    throw new Error('Requested model does not match the pinned local provider model.');
  if (
    isLocal &&
    Object.values(request.body?.questions || {}).some(
      (q) => Object.keys(q.criteria || {}).length === 1,
    )
  ) {
    const singleton = {},
      multiple = {};
    for (const [key, q] of Object.entries(request.body.questions)) {
      const ids = Object.keys(q.criteria || {});
      if (ids.length === 1)
        singleton[key] = {
          type: 'choice',
          choice: ids[0],
          confidence: 1,
          probabilities: { [ids[0]]: 1 },
        };
      else multiple[key] = q;
    }
    const result = Object.keys(multiple).length
      ? decodeJson(
          await decisionRequest(
            { ...request, body: { ...request.body, questions: multiple } },
            transport,
            { preflight },
          ),
        )
      : { model: request.body.model, answers: {} };
    const combined = { ...result, answers: { ...result.answers, ...singleton } };
    return Buffer.from(JSON.stringify(validateResponse(combined, request)));
  }
  const oversized =
    isLocal &&
    Object.entries(request.body?.questions || {}).some(
      ([, q]) => Object.keys(q.criteria || {}).length > 24,
    );
  if (oversized) {
    const answers = {};
    let model;
    let calls = 0;
    for (const [key, q] of Object.entries(request.body.questions)) {
      const entries = Object.entries(q.criteria);
      const ask = async (criteria) => {
        const bytes = await decisionRequest(
          { ...request, body: { ...request.body, questions: { [key]: { ...q, criteria } } } },
          transport,
          { preflight },
        );
        const result = decodeJson(bytes);
        model = result.model;
        calls += result.adapterCalls || 1;
        return validateAnswer(result.answers?.[key], criteria);
      };
      let winners = [];
      for (let i = 0; i < entries.length; i += 24) {
        const group = Object.fromEntries(entries.slice(i, i + 24));
        if (Object.keys(group).length === 1) winners.push(Object.keys(group)[0]);
        else winners.push((await ask(group)).choice);
      }
      while (winners.length > 24) {
        const next = [];
        for (let i = 0; i < winners.length; i += 24) {
          const ids = winners.slice(i, i + 24);
          next.push(
            ids.length === 1
              ? ids[0]
              : (await ask(Object.fromEntries(ids.map((id) => [id, q.criteria[id]])))).choice,
          );
        }
        winners = next;
      }
      const final =
        winners.length === 1
          ? {
              type: 'choice',
              choice: winners[0],
              confidence: 1,
              probabilities: { [winners[0]]: 1 },
            }
          : await ask(Object.fromEntries(winners.map((id) => [id, q.criteria[id]])));
      answers[key] = {
        ...final,
        probabilities: Object.fromEntries(
          entries.map(([id]) => [id, final.probabilities[id] || 0]),
        ),
      };
    }
    return Buffer.from(
      JSON.stringify({
        model: model || request.body.model,
        answers,
        adapterCalls: calls,
        probabilitySource:
          'hierarchical selection; zero mass for eliminated candidates, not calibrated over full inventory',
      }),
    );
  }
  const bytes = await transport({
    ...request,
    apiKey: isLocal ? 'local-no-secret' : request.apiKey,
  });
  const result = validateResponse(decodeJson(bytes), request);
  if (
    result?.truncated ||
    result?.usage?.truncated ||
    result?.usage?.truncated_questions ||
    result?.usage?.state_tokens_dropped > 0
  )
    throw new Error('Model truncated the decision evidence; no action executed.');
  return bytes;
}
