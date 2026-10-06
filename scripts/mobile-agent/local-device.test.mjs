import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContent, parseMutationResult, LocalAndroidDevice } from './local-device.mjs';
import { acquireDeviceLock } from './device-lock.mjs';
import { TypeSafePolicy } from './policy.mjs';

test('Portal parsing rejects errors and malformed responses', () => {
  assert.deepEqual(parseContent('Row: 0 result={"status":"success","result":{"x":1}}'), { x: 1 });
  assert.throws(() => parseContent('No result found.'));
  assert.throws(() => parseContent('{"status":"error","result":"secret error"}'));
});
test('ADB text binds are exact base64 and never interpreted as shell syntax', async () => {
  const calls = [];
  const device = new LocalAndroidDevice({
    deviceId: 'test',
    runner: async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout:
          'Inserted content://com.mobilerun.portal/result?status=success&message=Text%20entered',
      };
    },
  });
  await device.api('/devices/test/keyboard', 'POST', {
    text: 'Hello café; $(touch BAD)',
    clear: true,
  });
  assert.match(calls[0].args[3], /base64_text:s:SGVsbG8gY2Fmw6k7ICQodG91Y2ggQkFEKQ==/);
  assert.ok(!calls[0].args[3].includes('touch BAD'));
});
test('local actions fail once on uncertain ADB transport', async () => {
  let calls = 0;
  const device = new LocalAndroidDevice({
    deviceId: 'test',
    runner: async () => {
      calls++;
      throw new Error('lost');
    },
  });
  await assert.rejects(device.api('/devices/test/tap', 'POST', { x: 1, y: 2 }), /not retried/);
  assert.equal(calls, 1);
});
test('device lock excludes another executor and releases only its own lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'device-lock-'));
  try {
    const release = await acquireDeviceLock('test', { root });
    await assert.rejects(acquireDeviceLock('test', { root }), /busy/);
    await release();
    const again = await acquireDeviceLock('test', { root });
    await again();
  } finally {
    await rm(root, { recursive: true });
  }
});
test('provider selection pins explicit models without requiring hosted credentials locally', () => {
  for (const [backend, model] of [
    ['jev', 'jev-1.13.0'],
    ['rizzo', 'rizzo-flow-4b-q8_0'],
    ['tev1', 'tev1:4b-q4_K_M'],
  ])
    assert.equal(new TypeSafePolicy({ backend }).model, model);
  assert.throws(() => new TypeSafePolicy({ backend: 'unknown' }));
});

test('Portal mutation receipts accept official result URIs and reject uncertainty without message leakage', () => {
  assert.deepEqual(
    parseMutationResult(
      'Inserted content://com.mobilerun.portal/result?status=success&message=caf%C3%A9',
    ),
    { accepted: true },
  );
  for (const output of [
    'Inserted content://com.mobilerun.portal/result?status=error&message=private',
    'Inserted content://other/result?status=success',
    'Inserted content://com.mobilerun.portal/state_full?status=success',
    'Inserted content://com.mobilerun.portal/result?status=success&status=error',
    'Inserted content://com.mobilerun.portal/result',
    'No result found.',
  ])
    assert.throws(
      () => parseMutationResult(output),
      (error) => !error.message.includes('private') && /Do not replay/.test(error.message),
    );
});

test('Android 16 empty mutation output supplies transport evidence only', () => {
  assert.deepEqual(parseMutationResult(''), { accepted: true, verified: false });
});
test('local replacement verifies exact field without replay on mismatch', async () => {
  for (const correct of [true, false]) {
    let writes = 0;
    const device = new LocalAndroidDevice({ deviceId: 'test' });
    device.assertReady = async () => {};
    device.assertIdentity = async () => {};
    const before = {
      deviceId: 'test',
      observedAt: Date.now(),
      screen: { width: 100, height: 100 },
      phone: { packageName: 'fixture', isEditable: true, inputElementId: 'input' },
      elements: [
        {
          id: 'input',
          resourceId: 'name',
          editable: true,
          enabled: true,
          text: '',
          bounds: { left: 0, top: 0, right: 100, bottom: 30 },
        },
      ],
    };
    device.observe = async () =>
      writes && correct
        ? { ...before, elements: [{ ...before.elements[0], text: 'exact' }] }
        : before;
    device.api = async () => {
      writes++;
    };
    const run = device.act({ type: 'type', text: 'exact', clear: true }, { expected: before });
    if (correct) assert.equal((await run).verified, true);
    else await assert.rejects(run, /Do not replay/);
    assert.equal(writes, 1);
  }
});

test('physical tablet identity mismatch rejects an action before mutation', async () => {
  const old = process.env.AGENT_DEVICE_IDENTITY;
  process.env.AGENT_DEVICE_IDENTITY = 'pinned';
  let mutations = 0;
  try {
    const d = new LocalAndroidDevice({
      deviceId: 'endpoint',
      runner: async () => ({ stdout: 'another' }),
    });
    d.api = async () => {
      mutations++;
    };
    await assert.rejects(d.act({ type: 'global', name: 'home' }), /pinned physical tablet/);
    assert.equal(mutations, 0);
  } finally {
    if (old === undefined) delete process.env.AGENT_DEVICE_IDENTITY;
    else process.env.AGENT_DEVICE_IDENTITY = old;
  }
});
