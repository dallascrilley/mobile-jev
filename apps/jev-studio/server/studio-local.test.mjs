import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendObservedLocalAction } from '../app/components/local-device.mjs';

test('local studio observes before navigation and sends the same observation ID with the action', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/observe'))
      return Response.json({ observationId: 'fresh-observation', observation: { screen: 1 } });
    return Response.json({ ok: true });
  };
  const result = await sendObservedLocalAction({ type: 'global', name: 'back' }, fetcher);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.map(({ url }) => url),
    ['/api/studio/local/observe', '/api/studio/local/actions'],
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: { type: 'global', name: 'back' },
    observationId: 'fresh-observation',
  });
});

test('local studio does not dispatch navigation if its observation fails', async () => {
  let calls = 0;
  await assert.rejects(
    sendObservedLocalAction({ type: 'global', name: 'home' }, async () => {
      calls++;
      return Response.json({ error: 'device busy' }, { status: 409 });
    }),
    /device busy/,
  );
  assert.equal(calls, 1);
});
