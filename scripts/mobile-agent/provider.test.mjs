import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderPreflight,
  decisionRequest,
  LOCAL_PROVIDER_PINS,
  PROVIDERS,
} from './providers.mjs';

const pinSet = (backend, changes = {}) => ({
  ...LOCAL_PROVIDER_PINS,
  [backend]: { ...LOCAL_PROVIDER_PINS[backend], ...changes },
});

function choiceResponse(model, key, ids, choice = ids.at(-1), probabilities) {
  return Buffer.from(
    JSON.stringify({
      model,
      answers: {
        [key]: {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities:
            probabilities || Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
        },
      },
    }),
  );
}

function request(backend, criteria, model = PROVIDERS[backend].model) {
  return {
    url: PROVIDERS[backend].url,
    body: { model, questions: { target: { type: 'choice', criteria } } },
  };
}

test('Rizzo preflight validates health fingerprint and serves the pinned model; success caches per process', async () => {
  let healthReads = 0;
  let modelReads = 0;
  const pins = pinSet('rizzo');
  const preflight = createProviderPreflight({
    pins,
    fetcher: async (url) => {
      if (url === pins.rizzo.healthUrl) {
        healthReads++;
        return Response.json({
          status: 'ready',
          model: { ...pins.rizzo.modelFields },
          cold_load_seconds: 0.2,
        });
      }
      if (url === pins.rizzo.modelsUrl) {
        modelReads++;
        return Response.json({ models: [{ name: pins.rizzo.model }] });
      }
      assert.fail(`Unexpected preflight URL: ${url}`);
    },
  });
  await preflight('rizzo');
  await preflight('rizzo');
  assert.deepEqual([healthReads, modelReads], [1, 1]);
});

test('Rizzo preflight fails closed on wrong health fingerprint or missing model', async (t) => {
  await t.test('health fingerprint', async () => {
    const pin = LOCAL_PROVIDER_PINS.rizzo;
    const preflight = createProviderPreflight({
      fetcher: async (url) =>
        url === pin.healthUrl
          ? Response.json({
              status: 'ready',
              model: { ...pin.modelFields, llama_cpp_release: 'different-runtime' },
            })
          : Response.json({ models: [{ name: pin.model }] }),
    });
    await assert.rejects(preflight('rizzo'), /health fingerprint/);
  });
  await t.test('model identity', async () => {
    const pins = pinSet('rizzo');
    const preflight = createProviderPreflight({
      pins,
      fetcher: async (url) =>
        url === pins.rizzo.healthUrl
          ? Response.json({
              status: 'ready',
              model: { ...pins.rizzo.modelFields },
            })
          : Response.json({ models: [{ name: 'other-model' }] }),
    });
    await assert.rejects(preflight('rizzo'), /pinned decision model/);
  });
});

test('TEV-1 preflight checks the pinned model digest and caches a verified identity', async () => {
  let reads = 0;
  const preflight = createProviderPreflight({
    fetcher: async () => {
      reads++;
      return Response.json({
        models: [{ name: LOCAL_PROVIDER_PINS.tev1.model, digest: LOCAL_PROVIDER_PINS.tev1.digest }],
      });
    },
  });
  await preflight('tev1');
  await preflight('tev1');
  assert.equal(reads, 1);

  const mismatch = createProviderPreflight({
    fetcher: async () =>
      Response.json({ models: [{ name: LOCAL_PROVIDER_PINS.tev1.model, digest: 'wrong' }] }),
  });
  await assert.rejects(mismatch('tev1'), /digest/);
});

test('selected local provider is preflighted before any decision request, with no fallback', async () => {
  const events = [];
  const preflight = async (backend) => {
    events.push(`preflight:${backend}`);
    throw new Error('pinned Rizzo runtime unavailable');
  };
  await assert.rejects(
    decisionRequest(
      request('rizzo', { a: 'A', b: 'B' }),
      async () => {
        events.push('decision');
        return choiceResponse(PROVIDERS.rizzo.model, 'target', ['a', 'b']);
      },
      { preflight },
    ),
    /pinned Rizzo runtime unavailable/,
  );
  assert.deepEqual(events, ['preflight:rizzo']);
});

test('responses must identify the requested model and answer only offered choices', async (t) => {
  await t.test('wrong response model', async () => {
    await assert.rejects(
      decisionRequest(
        request('jev', { a: 'A', b: 'B' }),
        async () => choiceResponse('different-model', 'target', ['a', 'b']),
        { preflight: async () => {} },
      ),
      /does not match the requested model/,
    );
  });
  await t.test('unoffered choice', async () => {
    await assert.rejects(
      decisionRequest(
        request('jev', { a: 'A', b: 'B' }),
        async () => choiceResponse(PROVIDERS.jev.model, 'target', ['a', 'b'], 'injected'),
        { preflight: async () => {} },
      ),
      /outside the offered criteria/,
    );
  });
  await t.test('malformed probability distribution', async () => {
    await assert.rejects(
      decisionRequest(
        request('jev', { a: 'A', b: 'B' }),
        async () =>
          choiceResponse(PROVIDERS.jev.model, 'target', ['a', 'b'], 'b', { a: 0.2, b: 0.2 }),
        { preflight: async () => {} },
      ),
      /invalid choice distribution/,
    );
  });
  await t.test('unrequested answer', async () => {
    await assert.rejects(
      decisionRequest(
        request('jev', { a: 'A', b: 'B' }),
        async () =>
          Buffer.from(
            JSON.stringify({
              model: PROVIDERS.jev.model,
              answers: {
                target: {
                  type: 'choice',
                  choice: 'a',
                  confidence: 1,
                  probabilities: { a: 1, b: 0 },
                },
                injected: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1 } },
              },
            }),
          ),
        { preflight: async () => {} },
      ),
      /unrequested question/,
    );
  });
});

test('large local questions validate each bounded tournament distribution before selecting winners', async () => {
  const criteria = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`id${i}`, `Target ${i}`]),
  );
  let calls = 0;
  const transport = async (r) => {
    calls++;
    const [key, q] = Object.entries(r.body.questions)[0];
    const ids = Object.keys(q.criteria);
    assert.ok(ids.length <= 24);
    return choiceResponse(r.body.model, key, ids);
  };
  const bytes = await decisionRequest(request('rizzo', criteria), transport, {
    preflight: async () => {},
  });
  const result = JSON.parse(bytes);
  assert.equal(result.answers.target.choice, 'id49');
  assert.deepEqual(Object.keys(result.answers.target.probabilities), Object.keys(criteria));
  assert.equal(calls, 4);

  await assert.rejects(
    decisionRequest(
      request('rizzo', criteria),
      async (r) => {
        const [key, q] = Object.entries(r.body.questions)[0];
        return choiceResponse(r.body.model, key, Object.keys(q.criteria), 'invalid');
      },
      { preflight: async () => {} },
    ),
    /outside the offered criteria/,
  );
});

test('truncated local answers never become decisions', async () => {
  await assert.rejects(
    decisionRequest(
      request('rizzo', { a: 'A', b: 'B' }),
      async () => Buffer.from('{"truncated":true}'),
      { preflight: async () => {} },
    ),
    /model does not match|truncated/,
  );
});
