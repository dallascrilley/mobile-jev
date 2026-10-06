import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import { createDeviceServer } from './device-service.mjs';
import { createStore } from '../apps/jev-studio/server/store.mjs';
import { TypeSafePolicy } from './mobile-agent/policy.mjs';
import { assertReadyWithRetry, runWebTask } from './mobile-agent/web-runner.mjs';

const servers = new Set();

test('service rejects another device identity before observation or mutation', async () => {
  const fixture = await startServer();
  assert.equal((await fetch(`${fixture.base}/observe?deviceId=other`)).status, 409);
  const response = await fetch(`${fixture.base}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'other',
      action: { type: 'open-app', packageName: 'example.app' },
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(fixture.calls.length, 0);
  for (const path of ['/recover', '/runs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/stop', '/runs']) {
    const rejected = await fetch(`${fixture.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'other', goal: 'Open Settings', backend: 'rizzo' }),
    });
    assert.equal(rejected.status, 409, `${path} refuses another device before dispatch`);
  }
});

async function startServer(options = {}) {
  let screen = 1;
  const calls = [];
  const device = {
    deviceId: 'fixture-device',
    backend: 'local',
    async assertReady() {
      return { id: this.deviceId, name: 'Test tablet', state: 'ready' };
    },
    async listDevices() {
      return [{ id: this.deviceId, name: 'Test tablet', state: 'device' }];
    },
    async listApps() {
      return [{ packageName: 'example.app', label: 'Example' }];
    },
    async observe() {
      return { deviceId: this.deviceId, screen: { revision: screen }, observedAt: Date.now() };
    },
    async screenshot() {
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    },
    async act(action, { expected } = {}) {
      calls.push({ action, expected });
      if (expected && expected.screen.revision !== screen) {
        const error = new Error('Screen changed.');
        error.name = 'StaleObservationError';
        throw error;
      }
      screen++;
      return { executed: true };
    },
  };
  const server = createDeviceServer({ device, ...options });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  servers.add(server);
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    device,
    calls,
    changeScreen: () => screen++,
  };
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

test('observations are cached once and actions require a fresh matching observation', async () => {
  const fixture = await startServer({ acquireDeviceLock: async () => async () => {} });
  const missing = await fetch(`${fixture.base}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: { type: 'global', name: 'home' } }),
  });
  assert.equal(missing.status, 400);

  const observed = await fetch(`${fixture.base}/observe`);
  const { observationId } = await observed.json();
  assert.equal(typeof observationId, 'string');
  const acted = await fetch(`${fixture.base}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: { type: 'global', name: 'home' }, observationId }),
  });
  assert.equal(acted.status, 200);
  assert.equal(fixture.calls.length, 1);

  const replay = await fetch(`${fixture.base}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: { type: 'global', name: 'home' }, observationId }),
  });
  assert.equal(replay.status, 409);
  assert.equal(fixture.calls.length, 1);
});

test('bounded JSON and action shapes reject invalid input before dispatch', async () => {
  const fixture = await startServer({ acquireDeviceLock: async () => async () => {} });
  const oversized = await fetch(`${fixture.base}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: { type: 'type', text: 'x'.repeat(70_000) },
      observationId: 'unused',
    }),
  });
  assert.equal(oversized.status, 413);
  const invalid = await fetch(`${fixture.base}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: { type: 'tap', x: '2', y: 3 }, observationId: 'unused' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(fixture.calls.length, 0);
});

test('expired and adapter-rejected observations fail before a second device mutation', async () => {
  let now = 1000;
  const fixture = await startServer({
    acquireDeviceLock: async () => async () => {},
    now: () => now,
  });
  const expired = await (await fetch(`${fixture.base}/observe`)).json();
  now += 30_001;
  const expiredResponse = await fetch(`${fixture.base}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: { type: 'tap', x: 2, y: 3 },
      observationId: expired.observationId,
    }),
  });
  assert.equal(expiredResponse.status, 409);
  assert.equal(fixture.calls.length, 0);

  now = 2000;
  const stale = await (await fetch(`${fixture.base}/observe`)).json();
  fixture.changeScreen();
  const staleResponse = await fetch(`${fixture.base}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: { type: 'global', name: 'back' },
      observationId: stale.observationId,
    }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal(fixture.calls.length, 1);
});

test('lock contention rejects service actions and recovery without bypassing the shared lock', async () => {
  let lockHeld = false;
  const acquireDeviceLock = async () => {
    if (lockHeld) throw new Error('Device busy: another task owns the tablet.');
    lockHeld = true;
    return async () => {
      lockHeld = false;
    };
  };
  const fixture = await startServer({ acquireDeviceLock, recoverBin: '/fixture/recover' });
  lockHeld = true;
  const observed = await fetch(`${fixture.base}/observe`);
  assert.equal(observed.status, 409);
  const recovery = await fetch(`${fixture.base}/recover`, { method: 'POST' });
  assert.equal(recovery.status, 409);
  lockHeld = false;
});

test('recovery runs its configured binary without a shell while holding the device lock', async () => {
  const child = new EventEmitter();
  const acquired = [];
  let invocation;
  const fixture = await startServer({
    acquireDeviceLock: async (id) => {
      acquired.push(id);
      return async () => acquired.push('released');
    },
    recoverBin: '/usr/local/bin/tablet-recover',
    spawnProcess: (binary, args, options) => {
      invocation = { binary, args, shell: options.shell, stdio: options.stdio };
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  });
  const response = await fetch(`${fixture.base}/recover`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(invocation, {
    binary: '/usr/local/bin/tablet-recover',
    args: [],
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  assert.deepEqual(acquired, ['fixture-device', 'released']);
});

test('loopback origins and origin-free extension requests pass; cross-site and hostile hosts fail', async () => {
  const fixture = await startServer({
    acquireDeviceLock: async () => async () => {},
    policy: new TypeSafePolicy({ backend: 'rizzo', apiKey: undefined }),
  });
  const local = await fetch(`${fixture.base}/health`, {
    headers: { origin: 'http://localhost:3040' },
  });
  assert.equal(local.status, 200);
  assert.deepEqual((await local.json()).decision, {
    backend: 'rizzo',
    model: 'rizzo-flow-4b-q8_0',
  });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:3040');
  assert.equal((await fetch(`${fixture.base}/health`)).status, 200);
  assert.equal(
    (await fetch(`${fixture.base}/health`, { headers: { origin: 'https://evil.example' } })).status,
    403,
  );
  assert.equal(
    (await fetch(`${fixture.base}/health`, { headers: { 'sec-fetch-site': 'cross-site' } })).status,
    403,
  );
  const screenshot = await fetch(`${fixture.base}/screenshot`);
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
  assert.deepEqual(
    [...new Uint8Array(await screenshot.arrayBuffer())],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const { port } = fixture.server.address();
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        headers: { host: 'evil.example' },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end();
  });
  assert.equal(hostileHostStatus, 403);
});

test('worker acquires the physical-device lock before policy creation and forwards every app', async () => {
  const events = [];
  const apps = Array.from({ length: 30 }, (_, index) => ({
    packageName: `example.app${index}`,
    label: index === 28 ? 'Settings' : `App ${index}`,
  }));
  const device = {
    deviceId: 'adapter-id',
    async assertReady() {
      events.push('ready');
      return { state: 'ready' };
    },
    async listApps() {
      events.push('apps');
      return apps;
    },
  };
  await runWebTask({
    device,
    goal: 'Open Settings',
    maxSteps: 1,
    lock: async (identity, fn) => {
      events.push(`lock:${identity}`);
      return fn();
    },
    createPolicy: async () => {
      events.push('policy');
      return { decide() {} };
    },
    run: async ({ device: activeDevice, policy, settleMs }) => {
      assert.ok(policy);
      assert.equal(settleMs, 800);
      await activeDevice.assertReady();
      const provided = await activeDevice.listApps();
      assert.equal(provided.length, 30);
      assert.equal(provided[28].label, 'Settings');
      events.push('run');
      return { status: 'done' };
    },
  });
  assert.deepEqual(events, ['lock:adapter-id', 'policy', 'ready', 'apps', 'run']);
});

test('readiness retries transient Portal reads only, without retrying unrelated failures', async () => {
  let calls = 0;
  const pauses = [];
  const ready = await assertReadyWithRetry(
    {
      async assertReady() {
        calls++;
        if (calls < 3) throw new Error('Portal operation failed after accessibility update');
        return { state: 'ready' };
      },
    },
    { delayMs: 20, sleep: async (ms) => pauses.push(ms) },
  );
  assert.deepEqual(ready, { state: 'ready' });
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [20, 40]);

  calls = 0;
  await assert.rejects(
    assertReadyWithRetry(
      {
        async assertReady() {
          calls++;
          throw new Error('Device disconnected');
        },
      },
      { sleep: async () => assert.fail('Unexpected readiness retry.') },
    ),
    /Device disconnected/,
  );
  assert.equal(calls, 1);
});

test('run creation selects a decision backend and stop cancels its worker process', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null));
  const store = createStore({ spawnTask: () => child, taskTimeoutMs: 60_000 });
  const fixture = await startServer({ acquireDeviceLock: async () => async () => {}, store });
  const createdResponse = await fetch(`${fixture.base}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'Open Settings', maxSteps: 3, backend: 'rizzo' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.backend, 'rizzo');
  assert.match(child.stdin.read()?.toString() || '', /"backend":"rizzo"/);

  const stopResponse = await fetch(`${fixture.base}/runs/${created.id}/stop`, { method: 'POST' });
  assert.equal(stopResponse.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  const detail = await fetch(`${fixture.base}/runs/${created.id}`);
  assert.equal((await detail.json()).status, 'stopped');
});
