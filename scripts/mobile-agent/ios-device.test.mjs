import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StaleObservationError } from './device.mjs';
import { createDevice } from './device-factory.mjs';
import { candidatesFor } from './actions.mjs';
import { IosDevice, loadBinding, summarizeIosState, wdaRequest } from './ios-device.mjs';

const UDID = '00008030-001234567890002E';
const VENDOR = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const SESSION = '11111111-2222-3333-4444-555555555555';
const REVISION = '381e75ce6ad1afb97b46cc3aa72e758193af1353';
const URL_BASE = 'http://127.0.0.1:18100';
const FIELD_ID = 'FIELD-0001-ELEMENT';

const node = (type, rect, extra = {}) => ({
  type,
  rawIdentifier: null,
  name: extra.label ?? null,
  value: null,
  label: null,
  rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] },
  customActions: null,
  traits: '',
  isVisible: '1',
  isEnabled: '1',
  isAccessible: '0',
  isFocused: '0',
  ...extra,
});

function tree(state) {
  const fieldValue = state.field.value || null;
  const children = [
    node('Button', [20, 100, 100, 40], { label: state.buttonLabel, traits: 'Button' }),
    node('TextField', [20, 200, 300, 40], {
      name: 'search',
      label: 'Search field',
      rawIdentifier: 'search',
      value: fieldValue ?? 'Search',
      placeholderValue: 'Search',
    }),
    node('ScrollView', [0, 300, 414, 400], {
      children: [node('StaticText', [20, 310, 200, 20], { label: state.heading })],
    }),
  ];
  if (state.switchCount)
    children.push(
      node('Switch', [20, 150, 300, 40], {
        name: 'dark',
        label: 'Dark',
        rawIdentifier: 'dark',
        value: state.switchValue ?? '0',
      }),
    );
  if (state.password)
    children.push(
      node('SecureTextField', [20, 250, 300, 40], {
        name: 'pw',
        label: 'Password',
        value: '••••••',
        placeholderValue: 'Password',
      }),
    );
  if (state.keyboard)
    children.push(
      node('Keyboard', [0, 650, 414, 246], {
        children: [node('Key', [0, 650, 40, 40], { label: 'q' })],
      }),
    );
  return node('Application', [0, 0, 414, 896], { label: 'Fixture', children });
}

function makeWda(overrides = {}) {
  const state = {
    bundleId: 'com.example.app',
    pid: 42,
    locked: false,
    heading: 'Welcome',
    buttonLabel: 'Continue',
    password: false,
    keyboard: false,
    focus: null, // 'text' | 'password' | null
    field: { value: '' },
    window: { width: 414, height: 896 },
    info: { name: 'iPhone', uuid: VENDOR, model: 'iPhone', isSimulator: false },
    session: SESSION,
    calls: [],
    posts: [],
    failPost: null,
    dropNextPostResponse: false,
    typeIgnored: false,
    ...overrides,
  };
  const reply = (value, sessionId = state.session) =>
    Buffer.from(JSON.stringify({ value, sessionId }));
  const reject = (status, wdaError) =>
    Promise.reject(Object.assign(new Error('wda'), { status, wdaError }));
  const activeRect = () =>
    state.focus === 'password'
      ? { x: 20, y: 250, width: 300, height: 40 }
      : { x: 20, y: 200, width: 300, height: 40 };
  state.request = async ({ url, method = 'GET', body }) => {
    const path = url.replace(URL_BASE, '');
    state.calls.push(`${method} ${path}`);
    if (method === 'POST') {
      state.posts.push({ path, body });
      if (state.failPost) return Promise.reject(new Error('socket hang up'));
    }
    const inSession = path.startsWith(`/session/${SESSION}`);
    const route = inSession ? path.slice(`/session/${SESSION}`.length) : path;
    if (path.startsWith('/session/') && !inSession) return reject(404, 'invalid session id');
    if (method === 'GET') {
      if (route === '/status')
        return reply({ ready: true, os: { name: 'iOS' }, build: { version: '12.2.0' } });
      if (route === '/wda/device/info') return reply(state.info);
      if (route === '/wda/locked') return reply(state.locked);
      if (route === '/wda/activeAppInfo')
        return reply({ pid: state.pid, bundleId: state.bundleId, name: state.bundleId });
      if (route === '/window/size') return reply(state.window);
      if (route.startsWith('/source?format=json')) return reply(tree(state));
      if (route === '/element/active')
        return state.focus
          ? reply({ ELEMENT: FIELD_ID, 'element-6066-11e4-a52e-4f735466cecf': FIELD_ID })
          : reject(404, 'no such element');
      if (/^\/element\/SWITCH-[0-9]+-ELEMENT\/rect$/.test(route))
        return reply({ x: 20, y: 150, width: 300, height: 40 });
      if (/^\/element\/SWITCH-[0-9]+-ELEMENT\/attribute\/name$/.test(route))
        return reply(state.switchName ?? 'dark');
      if (route === `/element/${FIELD_ID}/rect`) return reply(activeRect());
      if (route === `/element/${FIELD_ID}/attribute/type`)
        return reply(
          state.focus === 'password'
            ? 'XCUIElementTypeSecureTextField'
            : 'XCUIElementTypeTextField',
        );
      if (route === `/element/${FIELD_ID}/attribute/name`)
        return reply(state.focus === 'password' ? 'pw' : 'search');
      if (route === `/element/${FIELD_ID}/attribute/value`)
        return reply(state.field.value || 'Search');
    } else {
      if (state.dropNextPostResponse) return Buffer.from('not json');
      if (route === '/elements')
        return reply(
          Array.from({ length: state.switchCount ?? 0 }, (_, i) => ({
            ELEMENT: `SWITCH-${i}-ELEMENT`,
          })),
        );
      if (/^\/element\/SWITCH-[0-9]+-ELEMENT\/click$/.test(route)) {
        state.switchClicks = (state.switchClicks ?? 0) + 1;
        if (state.dropClickResponse) return Buffer.from('not json');
        return reply(null);
      }
      if (route === '/actions') return reply(null);
      if (route === '/wda/homescreen') {
        state.bundleId = 'com.apple.springboard';
        return reply(null, state.session);
      }
      if (route === '/wda/apps/launch') {
        state.bundleId = body.bundleId;
        return reply(null);
      }
      if (route === `/element/${FIELD_ID}/clear`) {
        state.field.value = '';
        return reply(null);
      }
      if (route === `/element/${FIELD_ID}/value`) {
        if (state.typeIgnored || body.text === '\n') return reply(null);
        state.field.value =
          body.text === '\u0008' ? state.field.value.slice(0, -1) : state.field.value + body.text;
        return reply(null);
      }
    }
    return reject(404, 'unknown command');
  };
  return state;
}

function devicectl({ details = {}, apps } = {}) {
  const calls = [];
  const runner = async (bin, args) => {
    calls.push([bin, ...args]);
    const out = args[args.indexOf('--json-output') + 1];
    const kind = args[args.indexOf('info') + 1] ?? args[0];
    const { writeFileSync } = await import('node:fs');
    let result;
    if (kind === 'apps') result = { apps: apps ?? [], defaultAppsIncluded: true };
    else
      result = {
        hardwareProperties: { udid: UDID, platform: 'iOS' },
        connectionProperties: { tunnelState: 'connected', pairingState: 'paired' },
        deviceProperties: {
          name: 'DeviPhone',
          bootState: 'booted',
          developerModeStatus: 'enabled',
          ddiServicesAvailable: true,
          ...details.deviceProperties,
        },
        ...(details.override ?? {}),
      };
    if (details.fail) throw new Error('boom');
    writeFileSync(out, JSON.stringify({ info: { outcome: 'success' }, result }));
    return { stdout: '' };
  };
  return { runner, calls };
}

async function fixture(t, { wda = {}, ctl = {}, manifest = {}, device = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ios-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bindingFile = join(dir, 'binding.json');
  await writeFile(
    bindingFile,
    JSON.stringify({
      deviceId: UDID,
      deviceName: 'DeviPhone',
      expectedWdaName: 'iPhone',
      wdaUrl: URL_BASE,
      runnerPid: process.pid,
      proxyPid: process.pid,
      sourceRevision: REVISION,
      expectedVendorUuid: VENDOR,
      ...manifest,
    }),
  );
  await chmod(bindingFile, 0o600);
  const state = makeWda(wda);
  const ctlState = devicectl(ctl);
  const ios = new IosDevice({
    deviceId: UDID,
    wdaUrl: URL_BASE,
    sessionId: SESSION,
    bindingFile,
    request: state.request,
    runner: ctlState.runner,
    ...device,
  });
  return { dir, bindingFile, state, ctl: ctlState, ios };
}

const noPosts = (state) => assert.deepEqual(state.posts, [], 'no input may reach the device');

test('observation uses points, masks passwords, freezes geometry and reports capabilities', async (t) => {
  const { ios, state } = await fixture(t, { wda: { password: true, keyboard: true } });
  const o = await ios.observe();
  assert.equal(o.platform, 'ios');
  assert.deepEqual(o.screen, { width: 414, height: 896 });
  assert.ok(Object.isFrozen(o.screen) && Object.isFrozen(o.capabilities));
  assert.deepEqual(o.capabilities.globalActions, ['home']);
  assert.deepEqual(o.capabilities.keys, ['enter', 'delete']);
  const button = o.elements.find((e) => e.text === 'Continue');
  assert.deepEqual(button.bounds, { left: 20, top: 100, right: 120, bottom: 140 });
  assert.equal(button.clickable, true);
  assert.ok(Object.isFrozen(button.bounds));
  const secret = o.elements.find((e) => e.password);
  assert.equal(secret.text, '[password]');
  assert.ok(!JSON.stringify(o).includes('••'));
  assert.ok(!o.elements.some((e) => e.kind === 'Key'), 'keyboard keys are not targets');
  assert.equal(o.phone.keyboardVisible, true);
  noPosts(state);
});

test('placeholder text is not a field value, only for editable nodes', async (t) => {
  const { ios, state } = await fixture(t);
  let o = await ios.observe();
  const field = o.elements.find((e) => e.editable);
  assert.equal(field.text, '');
  assert.equal(field.hint, 'Search');
  state.field.value = 'hello';
  o = await ios.observe();
  assert.equal(o.elements.find((e) => e.editable).text, 'hello');
  state.heading = 'Search'; // static text equal to the placeholder keeps its text
  o = await ios.observe();
  assert.ok(o.elements.some((e) => e.kind === 'StaticText' && e.text === 'Search'));
});

test('focus comes from the WDA active element, never from isFocused or a visible keyboard', async (t) => {
  const { ios, state } = await fixture(t, { wda: { keyboard: true } });
  let o = await ios.observe();
  assert.equal(o.phone.isEditable, false, 'sole editable plus keyboard must not imply focus');
  assert.equal(o.phone.inputElementId, undefined);
  state.focus = 'text';
  o = await ios.observe();
  assert.equal(o.phone.isEditable, true);
  assert.equal(o.elements.find((e) => e.id === o.phone.inputElementId).resourceId, 'search');
  assert.equal(o.phone.focusEvidence, 'wda-active-element');
  assert.ok(candidatesFor(o, ['hi']).text_0);
  // An ambiguous match marks nothing.
  const duplicate = tree(state);
  duplicate.children.push(structuredClone(duplicate.children[1]));
  const ambiguous = summarizeIosState({
    tree: duplicate,
    size: state.window,
    bundleId: 'x',
    deviceId: UDID,
    focus: {
      kind: 'TextField',
      name: 'search',
      bounds: { left: 20, top: 200, right: 320, bottom: 240 },
    },
  });
  assert.equal(ambiguous.phone.isEditable, false);
});

test('malformed responses are rejected without input', async (t) => {
  const bad = [
    (s) => (s.window = { width: 414.5, height: 896 }),
    (s) => (s.window = { width: 0, height: 896 }),
    (s) => (s.badTree = true),
  ];
  for (const mutate of bad) {
    const { ios, state } = await fixture(t);
    mutate(state);
    if (state.badTree) {
      const request = state.request;
      ios.request = async (input) =>
        input.url.includes('/source')
          ? Buffer.from(JSON.stringify({ value: { type: 'Application', rect: { x: 'a' } } }))
          : request(input);
    }
    await assert.rejects(ios.observe());
    noPosts(state);
  }
  const { ios } = await fixture(t);
  ios.request = async () => Buffer.from('<html>');
  await assert.rejects(ios.observe());
  ios.request = async () => Buffer.from(JSON.stringify({ nope: 1 }));
  await assert.rejects(ios.read('/status'), /malformed/);
});

test('unsupported Android actions are rejected before any device I/O', async (t) => {
  const { ios, state } = await fixture(t);
  for (const action of [
    { type: 'global', name: 'back' },
    { type: 'global', name: 'recent' },
    { type: 'key', key: 'tab' },
    { type: 'key', key: 'back' },
    { type: 'key', key: 'forward_delete' },
    { type: 'wat' },
    { type: 'type', text: 'x'.repeat(4001) },
    { type: 'swipe', startX: 1, startY: 1, endX: 2, endY: 2, duration: 3 },
    { type: 'tap', x: 1.5, y: 2 },
  ])
    await assert.rejects(ios.act(action), /not supported|Unsupported|must be|Text must/);
  assert.deepEqual(state.calls, []);
});

test('tap-element resolves a fresh point and sends one W3C pointer sequence', async (t) => {
  const { ios, state } = await fixture(t);
  const expected = await ios.observe();
  const target = expected.elements.find((e) => e.text === 'Continue');
  const receipt = await ios.act({ type: 'tap-element', elementId: target.id }, { expected });
  assert.deepEqual(receipt, { accepted: true, verified: false, verification: 'transport-only' });
  assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].path, `/session/${SESSION}/actions`);
  const [move, down, , up] = state.posts[0].body.actions[0].actions;
  assert.deepEqual([move.x, move.y, move.origin], [70, 120, 'viewport']);
  assert.equal(down.type, 'pointerDown');
  assert.equal(up.type, 'pointerUp');
});

test('stale screens are refused before input and may be retried only after observing', async (t) => {
  const { ios, state } = await fixture(t);
  const expected = await ios.observe();
  const id = expected.elements.find((e) => e.text === 'Continue').id;
  state.buttonLabel = 'Changed';
  await assert.rejects(
    ios.act({ type: 'tap-element', elementId: id }, { expected }),
    StaleObservationError,
  );
  noPosts(state);
  state.buttonLabel = 'Continue';
  const old = { ...expected, observedAt: Date.now() - 60_000 };
  await assert.rejects(
    ios.act({ type: 'tap-element', elementId: id }, { expected: old }),
    StaleObservationError,
  );
  state.bundleId = 'com.example.other';
  await assert.rejects(
    ios.act({ type: 'tap-element', elementId: id }, { expected }),
    StaleObservationError,
  );
  noPosts(state);
});

test('geometry bounds: swipes and taps must stay inside the immutable point screen', async (t) => {
  const { ios, state } = await fixture(t);
  const expected = await ios.observe();
  await assert.rejects(ios.act({ type: 'tap', x: 414, y: 10 }), /outside the screen/);
  await assert.rejects(
    ios.act({ type: 'swipe', startX: 10, startY: 10, endX: 10, endY: 896, duration: 300 }),
    /outside the screen/,
  );
  await assert.rejects(ios.act({ type: 'tap', x: -1, y: 10 }), /non-negative/);
  noPosts(state);
  const scroll = expected.elements.find((e) => e.scrollable);
  const swipe = candidatesFor(expected)[`scroll_down_${scroll.id}`];
  state.window = { width: 400, height: 896 };
  await assert.rejects(ios.act(swipe, { expected }), StaleObservationError);
  noPosts(state);
  state.window = { width: 414, height: 896 };
  await ios.act(swipe, { expected });
  assert.equal(state.posts.length, 1);
  const steps = state.posts[0].body.actions[0].actions;
  assert.equal(steps.at(-2).duration, 300);
});

test('identity: wrong WDA name, vendor UUID, UDID, URL, pid, mode and ownership fail before input', async (t) => {
  const cases = [
    { wda: { info: { name: 'DeviPhone', uuid: VENDOR } }, expect: /does not match/ },
    {
      wda: { info: { name: 'iPhone', uuid: 'FFFFFFFF-BBBB-CCCC-DDDD-EEEEEEEEEEEE' } },
      expect: /does not match/,
    },
    {
      wda: { info: { name: 'iPhone', uuid: VENDOR, isSimulator: true } },
      expect: /does not match/,
    },
    { manifest: { deviceId: '00008030-001234567890002F' }, expect: /different device/ },
    { manifest: { wdaUrl: 'http://127.0.0.1:18101' }, expect: /different WDA URL/ },
    { manifest: { wdaUrl: 'http://example.com:18100' }, expect: /loopback/ },
    { manifest: { expectedVendorUuid: undefined }, expect: /incomplete/ },
    { manifest: { expectedWdaName: undefined }, expect: /incomplete/ },
    { device: { alive: (pid) => pid !== process.pid }, expect: /no longer running/ },
  ];
  for (const c of cases) {
    const { ios, state } = await fixture(t, c);
    await assert.rejects(ios.act({ type: 'global', name: 'home' }), c.expect);
    noPosts(state);
  }
  const { ios, bindingFile, state } = await fixture(t);
  await chmod(bindingFile, 0o644);
  await assert.rejects(ios.observe(), /owner-only/);
  const link = join(bindingFile + '.link');
  await symlink(bindingFile, link);
  await chmod(bindingFile, 0o600);
  await assert.rejects(
    loadBinding({ file: link, udid: UDID, wdaUrl: URL_BASE, alive: () => true }),
    /missing, unreadable or invalid/,
  );
  noPosts(state);
  const none = new IosDevice({ deviceId: UDID, wdaUrl: URL_BASE, request: state.request });
  await assert.rejects(none.observe(), /IOS_WDA_BINDING_FILE/);
});

test('devicectl transport precheck is exact and does not trust metadata alone', async (t) => {
  const failures = [
    [
      { override: { hardwareProperties: { udid: '00008030-001234567890002F', platform: 'iOS' } } },
      /different device/,
    ],
    [{ deviceProperties: { developerModeStatus: 'disabled' } }, /Developer Mode/],
    [{ deviceProperties: { ddiServicesAvailable: false } }, /Developer Mode/],
    [{ deviceProperties: { name: 'Someone Else' } }, /name does not match/],
    [
      {
        override: { connectionProperties: { tunnelState: 'disconnected', pairingState: 'paired' } },
      },
      /not connected/,
    ],
    [{ fail: true }, /devicectl failed/],
  ];
  for (const [details, expect] of failures) {
    const { ios, state } = await fixture(t, { ctl: { details } });
    await assert.rejects(ios.assertReady(), expect);
    await assert.rejects(ios.act({ type: 'global', name: 'home' }), expect);
    noPosts(state);
  }
  const { ios, ctl } = await fixture(t);
  await ios.assertReady();
  assert.deepEqual(ctl.calls[0].slice(0, 6), [
    'xcrun',
    'devicectl',
    'device',
    'info',
    'details',
    '--device',
  ]);
  assert.equal(ctl.calls[0][6], UDID);
});

test('a locked device is not ready even when metadata responds', async (t) => {
  const { ios, state } = await fixture(t, { wda: { locked: true } });
  await assert.rejects(ios.assertReady(), /locked/);
  await assert.rejects(ios.act({ type: 'global', name: 'home' }), /locked/);
  noPosts(state);
});

test('disconnection fails reads cleanly and uncertain mutations are never replayed', async (t) => {
  const { ios, state } = await fixture(t);
  const expected = await ios.observe();
  const id = expected.elements.find((e) => e.text === 'Continue').id;
  state.failPost = true;
  await assert.rejects(
    ios.act({ type: 'tap-element', elementId: id }, { expected }),
    /uncertain.*Do not replay/,
  );
  assert.equal(state.posts.length, 1, 'exactly one dispatch, no replay');
  const dead = new IosDevice({
    deviceId: UDID,
    wdaUrl: URL_BASE,
    sessionId: SESSION,
    bindingFile: ios.bindingFile,
    runner: devicectl().runner,
    request: async () => Promise.reject(new Error('ECONNREFUSED')),
  });
  await assert.rejects(dead.observe(), /disconnected or locked/);
  state.failPost = false;
  state.dropNextPostResponse = true;
  await assert.rejects(
    ios.act({ type: 'tap-element', elementId: id }, { expected }),
    /uncertain.*Do not replay/,
  );
  assert.equal(state.posts.length, 2);
});

test('replacement text is verified from the exact field readback', async (t) => {
  const { ios, state } = await fixture(t, { wda: { focus: 'text', keyboard: true } });
  state.field.value = 'old';
  const expected = await ios.observe();
  assert.equal(expected.phone.isEditable, true);
  const receipt = await ios.act({ type: 'type', text: 'new value', clear: true }, { expected });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.verification, 'exact-field-readback');
  assert.deepEqual(
    state.posts.map((p) => p.path.split('/').at(-1)),
    ['clear', 'value'],
  );
  assert.equal(state.field.value, 'new value');
  // Clear verifies the blank (placeholder) state through readback.
  const again = await ios.observe();
  const cleared = await ios.act({ type: 'clear' }, { expected: again });
  assert.equal(cleared.verified, true);
  assert.equal(state.field.value, '');
});

test('text that does not land is reported uncertain and never replayed', async (t) => {
  const { ios, state } = await fixture(t, { wda: { focus: 'text', typeIgnored: true } });
  const expected = await ios.observe();
  await assert.rejects(
    ios.act({ type: 'type', text: 'abc', clear: true }, { expected }),
    /uncertain.*Do not replay/,
  );
  assert.equal(state.posts.length, 2, 'one clear and one value, no second attempt');
});

test('text equal to the placeholder cannot be verified and is refused before input', async (t) => {
  const { ios, state } = await fixture(t, { wda: { focus: 'text' } });
  const expected = await ios.observe();
  await assert.rejects(
    ios.act({ type: 'type', text: 'Search', clear: true }, { expected }),
    /placeholder/,
  );
  noPosts(state);
});

test('password fields are never typed into, cleared or deleted', async (t) => {
  const { ios, state } = await fixture(t, { wda: { password: true, focus: 'password' } });
  const expected = await ios.observe();
  assert.equal(
    expected.elements.find((e) => e.id === expected.phone.inputElementId).password,
    true,
  );
  assert.equal(candidatesFor(expected, ['secret']).text_0, undefined);
  for (const action of [
    { type: 'type', text: 'secret', clear: true },
    { type: 'type', text: 'secret' },
    { type: 'clear' },
    { type: 'key', key: 'delete' },
  ])
    await assert.rejects(ios.act(action, { expected }), /Password fields/);
  noPosts(state);
  assert.ok(!state.calls.some((c) => c.includes('attribute/value')), 'password value never read');
});

test('focus that moves after observation is refused before mutation', async (t) => {
  const { ios, state } = await fixture(t, { wda: { focus: 'text' } });
  const expected = await ios.observe();
  state.focus = null;
  await assert.rejects(
    ios.act({ type: 'type', text: 'abc', clear: true }, { expected }),
    StaleObservationError,
  );
  noPosts(state);
});

test('enter and delete use the verified focused element and report transport only', async (t) => {
  const { ios, state } = await fixture(t, { wda: { focus: 'text' } });
  const expected = await ios.observe();
  const enter = await ios.act({ type: 'key', key: 'enter' }, { expected });
  assert.equal(enter.verified, false);
  assert.deepEqual(state.posts.at(-1).body, { text: '\n' });
  state.field.value = 'ab';
  await ios.act({ type: 'key', key: 'delete' }, { expected: await ios.observe() });
  assert.deepEqual(state.posts.at(-1).body, { text: '\u0008' });
  assert.equal(state.field.value, 'a');
  assert.match(state.posts.at(-1).path, new RegExp(`/element/${FIELD_ID}/value$`));
});

test('home and open-app verify the foreground app', async (t) => {
  const apps = [
    { bundleIdentifier: 'com.apple.mobilesafari', name: 'Safari', hidden: false, appClip: false },
    { bundleIdentifier: 'com.hidden.app', name: 'Hidden', hidden: true },
    { bundleIdentifier: 'com.clip.app', name: 'Clip', appClip: true },
    { bundleIdentifier: 'bad id', name: 'Bad' },
  ];
  const { ios, state, ctl } = await fixture(t, { ctl: { apps } });
  assert.equal(ios.installedApps.length, 0);
  assert.equal(
    (await ios.act({ type: 'open-app', packageName: 'com.apple.mobilesafari' })).verified,
    true,
  );
  state.posts.length = 0;
  assert.deepEqual(await ios.listApps(), [
    { packageName: 'com.apple.mobilesafari', label: 'Safari' },
  ]);
  const call = ctl.calls.find((c) => c.includes('apps'));
  assert.ok(call.includes('--include-default-apps'));
  assert.equal(call[call.indexOf('--device') + 1], UDID);
  await assert.rejects(
    ios.act({ type: 'open-app', packageName: 'com.unknown.app' }),
    /installed-app/,
  );
  noPosts(state);
  const launched = await ios.act({ type: 'open-app', packageName: 'com.apple.mobilesafari' });
  assert.equal(launched.verified, true);
  assert.equal(state.posts[0].path, `/session/${SESSION}/wda/apps/launch`);
  apps.splice(0, 1);
  state.posts.length = 0;
  await assert.rejects(
    ios.act({ type: 'open-app', packageName: 'com.apple.mobilesafari' }),
    /installed-app/,
  );
  noPosts(state);
  const home = await ios.act({ type: 'global', name: 'home' });
  assert.equal(home.verified, true);
});

test('a session is required for input and must match when configured', async (t) => {
  const { ios, state } = await fixture(t, {
    device: { sessionId: '99999999-2222-3333-4444-555555555555' },
  });
  const expected = await ios.observe().catch((e) => e);
  assert.ok(!(expected instanceof Error) || /session/.test(expected.message));
  await assert.rejects(ios.act({ type: 'tap', x: 5, y: 5 }), /session/);
  noPosts(state);
});

test('backend selection is explicit and identity env must agree', async (t) => {
  const keep = { ...process.env };
  t.after(() => {
    for (const k of [
      'MOBILE_DEVICE_BACKEND',
      'ADB_SERIAL',
      'AGENT_DEVICE_IDENTITY',
      'IOS_DEVICE_UDID',
      'IOS_WDA_URL',
    ])
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
  });
  process.env.IOS_DEVICE_UDID = UDID;
  process.env.IOS_WDA_URL = URL_BASE;
  delete process.env.MOBILE_DEVICE_BACKEND;
  delete process.env.ADB_SERIAL;
  assert.notEqual(createDevice({}).backend, 'ios', 'iOS is never inferred');
  const ios = createDevice({ backend: 'ios' });
  assert.equal(ios.backend, 'ios');
  assert.equal(ios.deviceId, UDID);
  assert.equal(ios.baseUrl, URL_BASE);
  process.env.AGENT_DEVICE_IDENTITY = UDID.toLowerCase();
  assert.equal(createDevice({ backend: 'ios' }).deviceId, UDID);
  process.env.AGENT_DEVICE_IDENTITY = '00008030-001234567890002F';
  assert.throws(() => createDevice({ backend: 'ios' }), /AGENT_DEVICE_IDENTITY/);
  delete process.env.AGENT_DEVICE_IDENTITY;
  assert.throws(() => createDevice({ backend: 'ios', deviceId: 'DeviPhone11' }), /exact physical/);
  process.env.IOS_WDA_URL = 'http://192.168.1.5:18100';
  assert.throws(() => createDevice({ backend: 'ios' }), /loopback/);
  assert.throws(() => createDevice({ backend: 'android' }), /local, mobilerun or ios/);
  delete process.env.IOS_DEVICE_UDID;
  delete process.env.IOS_WDA_URL;
  await assert.rejects(createDevice({ backend: 'ios' }).observe(), /never guess/);
});

test('WDA transport is bounded by size, time, loopback and method', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/big') return res.end('x'.repeat(5000));
    if (req.url === '/slow') return;
    if (req.url === '/err') {
      res.statusCode = 404;
      return res.end(
        JSON.stringify({ value: { error: 'no such element', message: 'secret screen text' } }),
      );
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ value: { echoed: req.method }, sessionId: null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await wdaRequest({ url: `${base}/ok` });
  assert.deepEqual(JSON.parse(ok).value, { echoed: 'GET' });
  assert.ok(ok.timing.wallMs >= 0);
  await assert.rejects(wdaRequest({ url: `${base}/big`, maxBytes: 100 }), /too large/);
  await assert.rejects(wdaRequest({ url: `${base}/slow`, timeoutMs: 50 }), /timed out/);
  const error = await wdaRequest({ url: `${base}/err` }).catch((e) => e);
  assert.equal(error.status, 404);
  assert.equal(error.wdaError, 'no such element');
  assert.ok(!error.message.includes('secret'));
  assert.throws(() => wdaRequest({ url: 'http://192.168.1.2:80/' }), /loopback/);
  assert.throws(() => wdaRequest({ url: `${base}/ok`, method: 'DELETE' }), /Unsupported/);
  assert.throws(
    () => wdaRequest({ url: `${base}/ok`, method: 'POST', body: { t: 'x'.repeat(70_000) } }),
    /too large/,
  );
});

test('source file stays within its declared dependencies', () => {
  const source = readFileSync(new URL('./ios-device.mjs', import.meta.url), 'utf8');
  assert.ok(!/droidrun/i.test(source));
  assert.ok(!/IOS_WDA_SESSION_ID\s*=\s*['"]/.test(source));
});

test('an error envelope inside a 200 response is an error, with only its code kept', async (t) => {
  const { ios, state } = await fixture(t, { wda: { focus: 'text' } });
  const request = state.request;
  state.envelopeError = true;
  ios.request = async (input) =>
    state.envelopeError && input.url.endsWith('/element/active')
      ? Buffer.from(
          JSON.stringify({
            value: { error: 'no such element', message: 'secret screen text' },
            sessionId: SESSION,
          }),
        )
      : request(input);
  const o = await ios.observe();
  assert.equal(o.phone.isEditable, false, 'no active element means no focused field');
  const error = await ios.read(`/session/${SESSION}/element/active`).catch((e) => e);
  assert.equal(error.wdaError, 'no such element');
  assert.ok(!error.message.includes('secret'));
  state.envelopeError = false;
  assert.equal((await ios.observe()).phone.isEditable, true);
});

test('native switch resolution requires a unique exact fresh target and never replays a click', async (t) => {
  for (const [count, name] of [
    [0, 'dark'],
    [2, 'dark'],
    [1, 'changed'],
  ]) {
    const { ios, state } = await fixture(t, { wda: { switchCount: 1 } });
    const expected = await ios.observe();
    const target = expected.elements.find((e) => e.kind === 'Switch');
    state.switchCount = count;
    state.switchName = name;
    await assert.rejects(
      ios.act({ type: 'tap-element', elementId: target.id }, { expected }),
      StaleObservationError,
    );
    assert.equal(state.switchClicks ?? 0, 0);
  }
  const { ios, state } = await fixture(t, { wda: { switchCount: 1 } });
  const expected = await ios.observe();
  const target = expected.elements.find((e) => e.kind === 'Switch');
  const receipt = await ios.act({ type: 'tap-element', elementId: target.id }, { expected });
  assert.equal(receipt.verified, false);
  assert.equal(state.switchClicks, 1);
  assert.equal(state.posts.filter((p) => p.path.endsWith('/actions')).length, 0);
  state.dropClickResponse = true;
  await assert.rejects(
    ios.act({ type: 'tap-element', elementId: target.id }, { expected }),
    /uncertain|malformed/i,
  );
  assert.equal(
    state.switchClicks,
    2,
    'one failed response causes exactly one further click, never a replay',
  );
});

test('native switches that change or expire during resolution receive no click', async (t) => {
  for (const mode of ['changed', 'expired', 'geometry']) {
    const { ios, state } = await fixture(t, { wda: { switchCount: 1 } });
    const expected = await ios.observe();
    const target = expected.elements.find((e) => e.kind === 'Switch');
    const request = state.request;
    ios.request = async (input) => {
      const result = await request(input);
      if (input.url.endsWith('/elements')) {
        if (mode === 'changed') state.switchValue = '1';
        if (mode === 'expired') await new Promise((resolve) => setTimeout(resolve, 40));
        if (mode === 'geometry') {
          const original = state.request;
          state.request = async (input) => {
            const bytes = await original(input);
            if (!input.url.includes('/source')) return bytes;
            const d = JSON.parse(bytes);
            d.value.children.find((e) => e.type === 'Switch').rect.x += 5;
            return Buffer.from(JSON.stringify(d));
          };
          ios.request = state.request;
        }
      }
      return result;
    };
    await assert.rejects(
      ios.act(
        { type: 'tap-element', elementId: target.id },
        { expected, maxAgeMs: mode === 'expired' ? 25 : 30000 },
      ),
      StaleObservationError,
    );
    assert.equal(state.switchClicks ?? 0, 0);
  }
});
