import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  CONFIG_FILE_KEYS,
  EXIT,
  ONLY_TESTING,
  SESSION_BODY,
  WDA_BUNDLE_ID,
  loadRuntimeEnv,
  parseIosRuntimeConfig,
  pidAlive,
  runSupervisor,
  verifyRuntime,
} from './ios-runtime.mjs';

// These tests run the real supervisor against fake iproxy/xcodebuild/xcrun/device-service
// programs, real plutil, real local ports, and real process groups. No device is touched.
const darwin = process.platform === 'darwin';
const UDID = '00008110-001A2B3C4D5E6F78';
const VENDOR = 'A1B2C3D4-0000-4000-8000-0123456789AB';
const REVISION = '0123456789abcdef0123456789abcdef01234567';
const SESSION_ID = 'F0F0F0F0-1111-4222-8333-444455556666';
const roots = [];
const launched = [];
after(async () => {
  // A failed assertion must not leave fake runtimes alive: they would hold the test pipes open.
  for (const run of launched) run.sigterm();
  await Promise.race([
    Promise.allSettled(launched.map((run) => run.done)),
    new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
  ]);
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const FAST = {
  readinessMs: 600,
  serviceReadinessMs: 1500,
  pollMs: 40,
  requestMs: 300,
  sessionPostMs: 400,
  proxyStartMs: 3000,
  devicectlMs: 10_000,
  termGraceMs: 400,
  killGraceMs: 2000,
};

const V1 = (extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>__xctestrun_metadata__</key><dict><key>FormatVersion</key><integer>1</integer></dict>
<key>WebDriverAgentRunner</key><dict>
<key>BlueprintName</key><string>WebDriverAgentRunner</string>
<key>TestHostPath</key><string>__TESTROOT__/Debug-iphoneos/WebDriverAgentRunner-Runner.app</string>
<key>DefaultTestExecutionTimeAllowance</key><integer>600</integer>
<key>EnvironmentVariables</key><dict>
<key>USE_PORT</key><string></string>
<key>MJPEG_SERVER_PORT</key><string></string>
<key>TERM</key><string>dumb</string>
${extra}
</dict></dict></dict></plist>`;

const V2 = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>__xctestrun_metadata__</key><dict><key>FormatVersion</key><integer>2</integer></dict>
<key>TestConfigurations</key><array><dict><key>Name</key><string>Test Scheme Action</string>
<key>TestTargets</key><array>
<dict><key>BlueprintName</key><string>OtherTests</string>
<key>TestHostPath</key><string>__TESTROOT__/Debug-iphoneos/WebDriverAgentRunner-Runner.app</string>
<key>EnvironmentVariables</key><dict><key>KEEP</key><string>other</string></dict></dict>
<dict><key>BlueprintName</key><string>WebDriverAgentRunner</string>
<key>TestHostPath</key><string>__TESTROOT__/Debug-iphoneos/WebDriverAgentRunner-Runner.app</string>
<key>EnvironmentVariables</key><dict><key>TERM</key><string>dumb</string></dict></dict>
</array></dict></array></dict></plist>`;

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function script(path, body) {
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
}

async function makeFixture({ xctestrun = V1(), details = {}, lock = {}, wda = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ios-runtime-test-')));
  roots.push(root);
  const products = join(root, 'Build', 'Products');
  mkdirSync(join(products, 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app'), {
    recursive: true,
  });
  writeFileSync(join(products, 'WebDriverAgentRunner_iphoneos27.0-arm64.xctestrun'), xctestrun);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const wdaPort = await freePort();
  const servicePort = await freePort();
  const state = join(root, 'state');
  mkdirSync(state);
  const write = (name, value) => writeFileSync(join(state, name), JSON.stringify(value));
  write('device.json', {
    details: {
      result: {
        deviceProperties: { name: 'DeviPhone11', developerModeStatus: 'enabled', ...details },
        hardwareProperties: { udid: UDID },
        connectionProperties: { tunnelState: 'connected' },
      },
    },
    lock: { result: { passcodeRequired: false, unlockedSinceBoot: true, ...lock } },
  });
  write('wda.json', { ready: true, name: 'iPhone', uuid: VENDOR, ...wda });
  write('xcodebuild-mode.json', {});

  script(
    join(bin, 'xcrun'),
    `
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(state, 'xcrun.log'))}, a.slice(0, 4).join(' ') + '\\n');
const d = JSON.parse(fs.readFileSync(${JSON.stringify(join(state, 'device.json'))}, 'utf8'));
const out = a[a.indexOf('--json-output') + 1];
if (d.fail) process.exit(1);
fs.writeFileSync(out, JSON.stringify(a[3] === 'lockState' ? d.lock : d.details));
`,
  );
  // The fake iproxy is also the fake WDA endpoint: it listens on the local port it is given.
  script(
    join(bin, 'iproxy'),
    `
const fs = require('node:fs');
const http = require('node:http');
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(state, 'iproxy.json'))}, JSON.stringify({ pid: process.pid, argv: a }));
const port = Number(a[a.length - 1].split(':')[0]);
if (JSON.parse(fs.readFileSync(${JSON.stringify(join(state, 'wda.json'))}, 'utf8')).forkListener && !process.env.LISTENER_CHILD) {
  require('node:child_process').spawn(process.execPath, [__filename, ...a], { env: { ...process.env, LISTENER_CHILD: '1' }, stdio: 'ignore' });
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
  return;
}
const cfg = () => JSON.parse(fs.readFileSync(${JSON.stringify(join(state, 'wda.json'))}, 'utf8'));
const runnerAlive = () => {
  try {
    process.kill(JSON.parse(fs.readFileSync(${JSON.stringify(join(state, 'xcodebuild.json'))}, 'utf8')).pid, 0);
    return true;
  } catch { return false; }
};
http.createServer((req, res) => {
  // Like the real stack, nothing answers unless the on-device runner is alive.
  if (!runnerAlive()) return req.socket.destroy();
  const c = cfg();
  fs.appendFileSync(${JSON.stringify(join(state, 'requests.log'))}, req.method + ' ' + req.url + '\\n');
  let body = '';
  req.on('data', (x) => (body += x));
  req.on('end', () => {
    if (c.redirectPath === req.url) { res.writeHead(c.redirectCode, {location: c.redirectUrl}); return res.end(); }
    const json = (v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
    if (req.method === 'GET' && req.url === '/status')
      return json({ value: { ready: c.ready, state: 'success' }, sessionId: c.existingSession || null });
    if (req.method === 'GET' && req.url === '/wda/device/info')
      return json({ value: { name: c.name, uuid: c.uuid, model: 'iPhone' } });
    if (req.method === 'POST' && req.url === '/session') {
      fs.appendFileSync(${JSON.stringify(join(state, 'posts.log'))}, body + '\\n');
      if (c.sessionHang) return;
      return json({ value: { sessionId: ${JSON.stringify(SESSION_ID)}, capabilities: {} } });
    }
    if (req.method === 'GET' && req.url.startsWith('/session/')) return json({ value: {} });
    res.statusCode = 404; res.end('{}');
  });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`,
  );
  script(
    join(bin, 'xcodebuild'),
    `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const a = process.argv.slice(2);
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(join(state, 'xcodebuild-mode.json'))}, 'utf8'));
const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(join(state, 'xcodebuild.json'))}, JSON.stringify({
  pid: process.pid, grandchild: grandchild.pid, argv: a,
  envKeys: Object.keys(process.env).sort(),
  xctestrun: fs.readFileSync(a[a.indexOf('-xctestrun') + 1], 'utf8'),
}));
if (mode.exitImmediately) process.exit(3);
if (!mode.ignoreTerm) process.on('SIGTERM', () => process.exit(0));
else process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
  );
  const serviceDir = join(root, 'svc', 'scripts');
  mkdirSync(serviceDir, { recursive: true });
  script(
    join(serviceDir, 'device-service.mjs'),
    `
import fs from 'node:fs';
import http from 'node:http';
fs.writeFileSync(${JSON.stringify(join(state, 'service.json'))}, JSON.stringify({ pid: process.pid, env: process.env, cwd: process.cwd() }));
http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); })
  .listen(Number(process.env.DEVICE_SERVICE_PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`.replace(/^/, ''),
  );

  const env = {
    HOME: root,
    PATH: '/usr/bin:/bin',
    TYPESAFE_API_KEY: 'test-key-value',
    TYPESAFE_CREDENTIAL_REFERENCE: 'op://vault/item/field',
    ADB_SERIAL: '100.0.0.1:5555',
    MOBILERUN_API_KEY: 'cloud-key',
    MOBILERUN_DEVICE_ID: 'cloud-device',
    IOS_DEVICE_UDID: UDID,
    IOS_DEVICE_NAME: 'DeviPhone11',
    IOS_WDA_URL: `http://127.0.0.1:${wdaPort}`,
    IOS_WDA_BUILD_DIR: products,
    IOS_WDA_SOURCE_REVISION: REVISION,
    IOS_EXPECTED_VENDOR_UUID: VENDOR,
    IOS_WDA_BINDING_FILE: join(root, 'bindings', `${UDID}.json`),
    DEVICE_SERVICE_PORT: String(servicePort),
    IOS_XCRUN_BIN: join(bin, 'xcrun'),
    IOS_XCODEBUILD_BIN: join(bin, 'xcodebuild'),
    IPROXY_BIN: join(bin, 'iproxy'),
    IOS_DEVICE_SERVICE_SCRIPT: join(serviceDir, 'device-service.mjs'),
  };
  const readState = (name) => JSON.parse(readFileSync(join(state, name), 'utf8'));
  const lines = (name) => {
    const file = join(state, name);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  };
  return {
    root,
    env,
    products,
    state,
    wdaPort,
    servicePort,
    write,
    readState,
    lines,
    has: (name) => existsSync(join(state, name)),
    binding: env.IOS_WDA_BINDING_FILE,
  };
}

function launch(fixture, { env = {}, timing = {} } = {}) {
  const events = [];
  const waiters = [];
  const signals = new EventEmitter();
  const log = (event, fields) => {
    events.push({ event, ...fields });
    for (const waiter of [...waiters]) if (waiter.event === event) waiter.resolve();
  };
  const done = runSupervisor({
    env: { ...fixture.env, ...env },
    log,
    timing: { ...FAST, ...timing },
    signals,
  });
  const waitFor = (event, ms = 15_000) =>
    new Promise((resolve, reject) => {
      if (events.some((entry) => entry.event === event)) return resolve();
      const waiter = { event, resolve: () => resolve() };
      waiters.push(waiter);
      done.then(() =>
        reject(new Error(`supervisor ended before ${event}: ${JSON.stringify(events)}`)),
      );
      setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms).unref();
    });
  const run = { events, signals, done, waitFor, sigterm: () => signals.emit('SIGTERM') };
  launched.push(run);
  return run;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

const skip = darwin ? false : 'requires macOS plutil';

test('config accepts the documented shape and rejects unsafe identity or endpoint values', async () => {
  const fixture = await makeFixture();
  assert.equal(parseIosRuntimeConfig(fixture.env).wdaPort, fixture.wdaPort);
  const rejects = (override, pattern) =>
    assert.throws(
      () => parseIosRuntimeConfig({ ...fixture.env, ...override }),
      (error) => error.exit === EXIT.USAGE && pattern.test(error.message),
    );
  rejects({ IOS_DEVICE_UDID: '../etc' }, /UDID/);
  rejects({ IOS_DEVICE_UDID: UDID + ' ' }, /UDID/);
  rejects({ IOS_DEVICE_UDID: 'ZZZZZZZZ-0000' }, /UDID/);
  rejects({ IOS_DEVICE_UDID: '--UDID-0000-000' }, /UDID/);
  rejects({ IOS_DEVICE_UDID: undefined }, /UDID/);
  rejects({ IOS_DEVICE_NAME: 'bad\nname' }, /NAME/);
  rejects({ IOS_WDA_URL: 'http://localhost:18100' }, /127\.0\.0\.1/);
  rejects({ IOS_WDA_URL: 'http://0.0.0.0:18100' }, /127\.0\.0\.1/);
  rejects({ IOS_WDA_URL: 'http://127.0.0.1:18100/path' }, /127\.0\.0\.1/);
  rejects({ IOS_WDA_URL: 'http://127.0.0.1:80' }, /port/);
  rejects({ DEVICE_SERVICE_PORT: String(fixture.wdaPort) }, /differ/);
  rejects({ IOS_WDA_BUILD_DIR: join(fixture.root, 'Build') }, /Build\/Products/);
  rejects({ IOS_WDA_BUILD_DIR: join(fixture.root, 'missing', 'Build', 'Products') }, /exist/);
  rejects({ IOS_EXPECTED_VENDOR_UUID: 'not-a-uuid' }, /UUID/);
  rejects({ IOS_WDA_BINDING_FILE: 'relative/binding.json' }, /absolute/);
  rejects({ IPROXY_BIN: 'iproxy' }, /absolute/);
  rejects({ IOS_WDA_SOURCE_REVISION: 'abc1234' }, /REVISION/);
  rejects({ IOS_DEVICE_UDID: '00008110-001A' }, /UDID/);
});

test('IPROXY_BIN selects the proxy and defaults to the Homebrew path', async () => {
  const fixture = await makeFixture();
  assert.equal(parseIosRuntimeConfig(fixture.env).bins.iproxy, fixture.env.IPROXY_BIN);
  const bare = { ...fixture.env };
  delete bare.IPROXY_BIN;
  assert.equal(parseIosRuntimeConfig(bare).bins.iproxy, '/opt/homebrew/bin/iproxy');
});

test(
  'runtime starts owned processes, records ownership, creates one session, and cleans up on SIGTERM',
  { skip },
  async () => {
    const fixture = await makeFixture();
    const run = launch(fixture);
    await run.waitFor('ready');

    const proxy = fixture.readState('iproxy.json');
    assert.deepEqual(proxy.argv, ['-u', UDID, '-l', '-s', '127.0.0.1', `${fixture.wdaPort}:8100`]);
    const runner = fixture.readState('xcodebuild.json');
    const derived = join(fixture.products, `mobile-jev-ios-${UDID}.xctestrun`);
    assert.deepEqual(runner.argv, [
      'test-without-building',
      '-xctestrun',
      derived,
      '-destination',
      `platform=iOS,id=${UDID}`,
      `-only-testing:${ONLY_TESTING}`,
    ]);
    assert.equal(ONLY_TESTING, 'WebDriverAgentRunner/UITestingUITests/testRunner');

    // Derived file: ports and bundle id set, everything else preserved, source untouched.
    const read = (file, keypath) =>
      execFileSync('/usr/bin/plutil', ['-extract', keypath, 'raw', '-o', '-', file], {
        encoding: 'utf8',
      }).trim();
    const environment = (key) => read(derived, `WebDriverAgentRunner.EnvironmentVariables.${key}`);
    assert.equal(environment('USE_PORT'), '8100');
    assert.equal(environment('MJPEG_SERVER_PORT'), '9100');
    assert.equal(environment('WDA_PRODUCT_BUNDLE_IDENTIFIER'), WDA_BUNDLE_ID);
    assert.equal(environment('TERM'), 'dumb');
    assert.equal(read(derived, 'WebDriverAgentRunner.DefaultTestExecutionTimeAllowance'), '600');
    assert.equal(
      read(
        join(fixture.products, 'WebDriverAgentRunner_iphoneos27.0-arm64.xctestrun'),
        'WebDriverAgentRunner.EnvironmentVariables.USE_PORT',
      ),
      '',
    );
    assert.equal(statSync(derived).mode & 0o777, 0o600);

    // Ownership manifest.
    assert.equal(statSync(fixture.binding).mode & 0o777, 0o600);
    const manifest = JSON.parse(readFileSync(fixture.binding, 'utf8'));
    assert.equal(manifest.deviceId, UDID);
    assert.equal(manifest.deviceName, 'DeviPhone11');
    assert.equal(manifest.wdaUrl, fixture.env.IOS_WDA_URL);
    assert.equal(manifest.runnerPid, runner.pid);
    assert.equal(manifest.proxyPid, proxy.pid);
    assert.equal(manifest.sourceRevision, REVISION);
    assert.equal(manifest.expectedVendorUuid, VENDOR);
    // WDA reports a generic name; it is recorded separately from the user-assigned name.
    assert.equal(manifest.expectedWdaName, 'iPhone');
    assert.notEqual(manifest.expectedWdaName, manifest.deviceName);

    // Exactly one session POST, with the safe capability body.
    assert.deepEqual(
      fixture.lines('posts.log').map((line) => JSON.parse(line)),
      [SESSION_BODY],
    );
    assert.equal(SESSION_BODY.capabilities.alwaysMatch.autoAcceptAlerts, false);
    assert.equal(SESSION_BODY.capabilities.alwaysMatch.bundleId, undefined);

    // Device precheck used read-only devicectl queries only.
    assert.deepEqual(fixture.lines('xcrun.log'), [
      'devicectl device info details',
      'devicectl device info lockState',
    ]);

    // Service environment: identity set, Android and cloud credentials stripped.
    const service = fixture.readState('service.json');
    assert.equal(service.env.MOBILE_DEVICE_BACKEND, 'ios');
    assert.equal(service.env.AGENT_DEVICE_IDENTITY, UDID);
    assert.equal(service.env.IOS_WDA_SESSION_ID, SESSION_ID);
    assert.equal(service.env.DEVICE_SERVICE_PORT, String(fixture.servicePort));
    assert.equal(service.env.TYPESAFE_API_KEY, 'test-key-value');
    for (const name of [
      'ADB_SERIAL',
      'MOBILERUN_API_KEY',
      'MOBILERUN_DEVICE_ID',
      'TYPESAFE_CREDENTIAL_REFERENCE',
      'IOS_WDA_BUILD_DIR',
    ])
      assert.equal(service.env[name], undefined, `${name} must not reach the service`);
    // Device tools never see credentials.
    assert.ok(!runner.envKeys.includes('TYPESAFE_API_KEY'));
    assert.ok(!runner.envKeys.includes('ADB_SERIAL'));

    const pids = [proxy.pid, runner.pid, runner.grandchild, service.pid];
    assert.ok(pids.every(pidAlive));
    assert.ok(existsSync(`${fixture.binding}.lock`));

    fixture.write('device.json', { fail: true }); // cleanup must not need the device
    run.sigterm();
    assert.equal(await run.done, EXIT.OK);
    assert.ok(
      pids.every((pid) => !pidAlive(pid)),
      'every owned process and grandchild is gone',
    );
    assert.equal(existsSync(fixture.binding), false);
    assert.equal(existsSync(`${fixture.binding}.lock`), false);
  },
);

test('runtime escalates to SIGKILL when the runner ignores SIGTERM', { skip }, async () => {
  const fixture = await makeFixture();
  fixture.write('xcodebuild-mode.json', { ignoreTerm: true });
  const run = launch(fixture);
  await run.waitFor('ready');
  const { pid, grandchild } = fixture.readState('xcodebuild.json');
  run.sigterm();
  assert.equal(await run.done, EXIT.OK);
  assert.ok(run.events.some((entry) => entry.event === 'escalating-kill'));
  assert.ok(!pidAlive(pid) && !pidAlive(grandchild));
});

test(
  'FormatVersion 2 xctestrun gets the same variables on the WebDriverAgentRunner target only',
  { skip },
  async () => {
    const fixture = await makeFixture({ xctestrun: V2 });
    const run = launch(fixture);
    await run.waitFor('ready');
    const derived = join(fixture.products, `mobile-jev-ios-${UDID}.xctestrun`);
    const read = (keypath) =>
      execFileSync('/usr/bin/plutil', ['-extract', keypath, 'raw', '-o', '-', derived], {
        encoding: 'utf8',
      }).trim();
    const wda = 'TestConfigurations.0.TestTargets.1.EnvironmentVariables';
    assert.equal(read(`${wda}.USE_PORT`), '8100');
    assert.equal(read(`${wda}.MJPEG_SERVER_PORT`), '9100');
    assert.equal(read(`${wda}.WDA_PRODUCT_BUNDLE_IDENTIFIER`), WDA_BUNDLE_ID);
    assert.equal(read(`${wda}.TERM`), 'dumb');
    const other = 'TestConfigurations.0.TestTargets.0.EnvironmentVariables';
    assert.equal(read(`${other}.KEEP`), 'other');
    assert.throws(() => read(`${other}.USE_PORT`));
    run.sigterm();
    assert.equal(await run.done, EXIT.OK);
  },
);

test('unsupported xctestrun schemas fail before any process starts', { skip }, async () => {
  const fixture = await makeFixture({ xctestrun: V2.replace('<integer>2<', '<integer>9<') });
  const run = launch(fixture);
  assert.equal(await run.done, EXIT.FAILURE);
  assert.equal(fixture.has('iproxy.json'), false);
  assert.equal(fixture.has('xcodebuild.json'), false);
});

for (const [name, details, lock] of [
  ['device is locked', {}, { passcodeRequired: true }],
  ['lock state is unknown', {}, { passcodeRequired: undefined }],
  ['Developer Mode is off', { developerModeStatus: 'disabled' }, {}],
  ['the device name differs', { name: 'Someone else' }, {}],
]) {
  test(`blocked precheck starts nothing and exits 75 when ${name}`, { skip }, async () => {
    const fixture = await makeFixture({ details, lock });
    const run = launch(fixture);
    assert.equal(await run.done, EXIT.BLOCKED);
    assert.equal(fixture.has('iproxy.json'), false);
    assert.equal(fixture.has('xcodebuild.json'), false);
    assert.equal(existsSync(fixture.binding), false);
    assert.equal(existsSync(`${fixture.binding}.lock`), false);
    assert.deepEqual(
      fixture.lines('xcrun.log').filter((line) => !/info (details|lockState)/.test(line)),
      [],
    );
  });
}

test('unreachable devicectl blocks without starting processes', { skip }, async () => {
  const fixture = await makeFixture();
  fixture.write('device.json', { fail: true });
  assert.equal(await launch(fixture).done, EXIT.BLOCKED);
  assert.equal(fixture.has('iproxy.json'), false);
});

for (const which of ['wda', 'service']) {
  test(
    `an existing listener on the ${which} port is rejected before any spawn`,
    { skip },
    async () => {
      const fixture = await makeFixture();
      const port = which === 'wda' ? fixture.wdaPort : fixture.servicePort;
      const squatter = net.createServer((socket) => socket.end()).listen(port, '127.0.0.1');
      await new Promise((resolve) => squatter.once('listening', resolve));
      try {
        const run = launch(fixture);
        assert.equal(await run.done, EXIT.FAILURE);
        assert.equal(fixture.has('iproxy.json'), false);
        assert.equal(fixture.has('xcodebuild.json'), false);
        assert.equal(fixture.has('xcrun.log'), false);
        assert.equal(existsSync(`${fixture.binding}.lock`), false);
        assert.ok(squatter.listening, 'the foreign listener is left alone');
      } finally {
        squatter.close();
      }
    },
  );
}

test(
  'a manifest owned by another device, a live owner, or unreadable content is preserved and refused',
  { skip },
  async () => {
    const cases = {
      'another device': (fixture) => ({ ...base(fixture), deviceId: '00008110-FFFFFFFFFFFFFFFF' }),
      'another endpoint': (fixture) => ({ ...base(fixture), wdaUrl: 'http://127.0.0.1:19999' }),
      'a live owner pid': (fixture) => ({ ...base(fixture), runnerPid: process.pid }),
      'unreadable content': () => '{not json',
    };
    const base = (fixture) => ({
      deviceId: UDID,
      wdaUrl: fixture.env.IOS_WDA_URL,
      runnerPid: 999_999_999,
      proxyPid: 999_999_998,
    });
    for (const [name, make] of Object.entries(cases)) {
      const fixture = await makeFixture();
      mkdirSync(join(fixture.root, 'bindings'));
      const content = make(fixture);
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      writeFileSync(fixture.binding, text);
      const run = launch(fixture);
      assert.equal(await run.done, EXIT.FAILURE, name);
      assert.equal(readFileSync(fixture.binding, 'utf8'), text, `${name}: manifest preserved`);
      assert.equal(fixture.has('iproxy.json'), false, name);
      assert.equal(fixture.has('xcodebuild.json'), false, name);
    }
  },
);

test(
  'a stale manifest with only dead pids is replaced, and a live supervisor lock is respected',
  { skip },
  async () => {
    const fixture = await makeFixture();
    mkdirSync(join(fixture.root, 'bindings'));
    writeFileSync(
      fixture.binding,
      JSON.stringify({
        deviceId: UDID,
        wdaUrl: fixture.env.IOS_WDA_URL,
        runnerPid: await deadPid(),
        proxyPid: await deadPid(),
      }),
    );
    // A lock held by a live process blocks the start.
    writeFileSync(`${fixture.binding}.lock`, JSON.stringify({ pid: process.pid, runId: 'other' }));
    assert.equal(await launch(fixture).done, EXIT.FAILURE);
    assert.equal(fixture.has('iproxy.json'), false);
    // A lock whose owner is dead is taken over.
    writeFileSync(
      `${fixture.binding}.lock`,
      JSON.stringify({ pid: await deadPid(), runId: 'old' }),
    );
    const run = launch(fixture);
    await run.waitFor('ready');
    assert.equal(JSON.parse(readFileSync(fixture.binding, 'utf8')).expectedVendorUuid, VENDOR);
    run.sigterm();
    assert.equal(await run.done, EXIT.OK);
  },
);

test(
  'WDA identity mismatches stop startup before the manifest or session exist',
  { skip },
  async () => {
    const cases = {
      'wrong vendor UUID': { uuid: 'FFFFFFFF-0000-4000-8000-0123456789AB' },
      'missing vendor UUID': { uuid: undefined },
      'unexpected generic name': { name: 'iPad' },
      'a session this supervisor does not own': { existingSession: 'SOMEONE-ELSES-SESSION' },
    };
    for (const [name, wda] of Object.entries(cases)) {
      const fixture = await makeFixture({ wda });
      const run = launch(fixture);
      assert.equal(await run.done, EXIT.FAILURE, name);
      assert.equal(fixture.has('posts.log'), false, `${name}: no session POST`);
      assert.equal(existsSync(fixture.binding), false, `${name}: no manifest`);
      const { pid, grandchild } = fixture.readState('xcodebuild.json');
      const proxy = fixture.readState('iproxy.json');
      assert.ok(![pid, grandchild, proxy.pid].some(pidAlive), `${name}: processes cleaned up`);
    }
  },
);

test(
  'readiness requires the JSON boolean true and retries only GET requests',
  { skip },
  async () => {
    const fixture = await makeFixture({ wda: { ready: 'true' } });
    const run = launch(fixture);
    assert.equal(await run.done, EXIT.FAILURE);
    const requests = fixture.lines('requests.log');
    assert.ok(requests.filter((line) => line === 'GET /status').length > 2, 'status was retried');
    assert.ok(
      requests.every((line) => line.startsWith('GET ')),
      'no mutating request was retried',
    );
    assert.equal(fixture.has('posts.log'), false);
    assert.equal(existsSync(fixture.binding), false);
  },
);

test('a hung session POST is never repeated and tears everything down', { skip }, async () => {
  const fixture = await makeFixture({ wda: { sessionHang: true } });
  const run = launch(fixture);
  assert.equal(await run.done, EXIT.FAILURE);
  assert.equal(fixture.lines('posts.log').length, 1);
  assert.equal(existsSync(fixture.binding), false);
  const { pid } = fixture.readState('xcodebuild.json');
  assert.equal(pidAlive(pid), false);
  assert.equal(fixture.has('service.json'), false, 'the service never starts without a session');
});

test('a runner that exits at startup fails fast and removes the proxy', { skip }, async () => {
  const fixture = await makeFixture();
  fixture.write('xcodebuild-mode.json', { exitImmediately: true });
  const run = launch(fixture, { timing: { readinessMs: 5000 } });
  const started = Date.now();
  assert.equal(await run.done, EXIT.FAILURE);
  assert.ok(Date.now() - started < 4000, 'did not wait for the full readiness budget');
  assert.equal(pidAlive(fixture.readState('iproxy.json').pid), false);
  assert.equal(fixture.has('posts.log'), false);
});

test(
  'losing any owned process after startup stops the whole runtime with a failure code',
  { skip },
  async () => {
    for (const target of ['runner', 'service']) {
      const fixture = await makeFixture();
      const run = launch(fixture);
      await run.waitFor('ready');
      const pids = {
        runner: fixture.readState('xcodebuild.json').pid,
        service: fixture.readState('service.json').pid,
      };
      const all = [
        fixture.readState('iproxy.json').pid,
        pids.runner,
        pids.service,
        fixture.readState('xcodebuild.json').grandchild,
      ];
      process.kill(pids[target], 'SIGKILL');
      assert.equal(await run.done, EXIT.FAILURE, target);
      assert.ok(
        all.every((pid) => !pidAlive(pid)),
        `${target}: nothing left running`,
      );
      assert.equal(existsSync(fixture.binding), false);
    }
  },
);

test('SIGTERM during startup cleans up and exits 0', { skip }, async () => {
  const fixture = await makeFixture({ wda: { ready: false } });
  const run = launch(fixture, { timing: { readinessMs: 30_000 } });
  await run.waitFor('starting');
  while (!fixture.has('xcodebuild.json')) await new Promise((resolve) => setTimeout(resolve, 20));
  run.sigterm();
  assert.equal(await run.done, EXIT.OK);
  assert.ok(!pidAlive(fixture.readState('xcodebuild.json').pid));
  assert.equal(existsSync(`${fixture.binding}.lock`), false);
});

test(
  'verifyRuntime reads state only: ready when alive, with ownership and identity checks',
  { skip },
  async () => {
    const fixture = await makeFixture();
    const run = launch(fixture);
    await run.waitFor('ready');
    const before = readFileSync(fixture.binding, 'utf8');
    const posts = fixture.lines('posts.log').length;

    const env = { ...fixture.env, IOS_WDA_SESSION_ID: SESSION_ID };
    const ready = await verifyRuntime({ env, timing: FAST });
    assert.equal(ready.ready, true);
    assert.equal(ready.vendorUuid, VENDOR);
    assert.equal(ready.proxyPid, fixture.readState('iproxy.json').pid);
    assert.equal(fixture.lines('xcrun.log').length, 2, 'no device queries while alive');

    // Wrong expected identity is refused without touching anything.
    const foreign = await verifyRuntime({
      env: { ...env, IOS_EXPECTED_VENDOR_UUID: 'FFFFFFFF-0000-4000-8000-0123456789AB' },
      timing: FAST,
    });
    assert.equal(foreign.ready, false);
    assert.equal(foreign.reason, 'binding-foreign');

    // WDA now reports a different device behind the same port.
    fixture.write('wda.json', {
      ready: true,
      name: 'iPhone',
      uuid: 'FFFFFFFF-0000-4000-8000-0123456789AB',
    });
    assert.equal((await verifyRuntime({ env, timing: FAST })).reason, 'identity-mismatch');
    fixture.write('wda.json', { ready: 'true', name: 'iPhone', uuid: VENDOR });
    assert.equal((await verifyRuntime({ env, timing: FAST })).reason, 'wda-not-ready');
    fixture.write('wda.json', { ready: true, name: 'iPhone', uuid: VENDOR });

    assert.equal(readFileSync(fixture.binding, 'utf8'), before, 'manifest untouched');
    assert.equal(fixture.lines('posts.log').length, posts, 'no mutating request');
    assert.ok(
      fixture
        .lines('requests.log')
        .every((line) => !line.startsWith('POST ') || line === 'POST /session'),
    );
    run.sigterm();
    await run.done;
  },
);

test(
  'verifyRuntime reports a down runtime with the device-side blocking reason',
  { skip },
  async () => {
    const fixture = await makeFixture({ lock: { passcodeRequired: true } });
    mkdirSync(join(fixture.root, 'bindings'));
    writeFileSync(
      fixture.binding,
      JSON.stringify({
        deviceId: UDID,
        wdaUrl: fixture.env.IOS_WDA_URL,
        expectedVendorUuid: VENDOR,
        expectedWdaName: 'iPhone',
        runnerPid: await deadPid(),
        proxyPid: await deadPid(),
      }),
    );
    const result = await verifyRuntime({ env: fixture.env, timing: FAST });
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'process-down');
    assert.match(result.blocking, /locked/i);
    assert.equal(fixture.has('iproxy.json'), false, 'verify never starts anything');

    const missing = await makeFixture();
    assert.equal((await verifyRuntime({ env: missing.env, timing: FAST })).reason, 'no-binding');
  },
);

test(
  'verifyRuntime refuses a WDA port held by a process other than the recorded proxy',
  { skip },
  async () => {
    const fixture = await makeFixture();
    mkdirSync(join(fixture.root, 'bindings'));
    const squatter = net.createServer().listen(fixture.wdaPort, '127.0.0.1');
    await new Promise((resolve) => squatter.once('listening', resolve));
    try {
      writeFileSync(
        fixture.binding,
        JSON.stringify({
          deviceId: UDID,
          wdaUrl: fixture.env.IOS_WDA_URL,
          expectedVendorUuid: VENDOR,
          expectedWdaName: 'iPhone',
          runnerPid: process.pid,
          proxyPid: process.ppid,
        }),
      );
      const result = await verifyRuntime({ env: fixture.env, timing: FAST });
      assert.equal(result.reason, 'port-owner-mismatch');
    } finally {
      squatter.close();
    }
  },
);

test('the command line exits 64 on bad configuration and 64 on unknown flags', () => {
  const run = (...args) =>
    spawn(process.execPath, [new URL('./ios-runtime.mjs', import.meta.url).pathname, ...args], {
      env: { PATH: process.env.PATH },
      stdio: 'ignore',
    });
  return Promise.all(
    [[], ['--nonsense']].map(
      (args) =>
        new Promise((resolve) =>
          run(...args).once('exit', (code) => {
            assert.equal(code, EXIT.USAGE);
            resolve();
          }),
        ),
    ),
  );
});

test(
  'first start learns the vendor UUID once from the owned proxy and then pins it',
  { skip },
  async () => {
    const fixture = await makeFixture();
    const learn = { IOS_EXPECTED_VENDOR_UUID: undefined };
    const first = launch(fixture, { env: learn });
    await first.waitFor('ready');
    const enrollment = `${fixture.binding}.vendor-uuid.json`;
    assert.equal(statSync(enrollment).mode & 0o777, 0o600);
    assert.deepEqual(
      { ...JSON.parse(readFileSync(enrollment, 'utf8')), enrolledAt: undefined },
      { deviceId: UDID, vendorUuid: VENDOR, enrolledAt: undefined, sourceRevision: REVISION },
    );
    assert.equal(JSON.parse(readFileSync(fixture.binding, 'utf8')).expectedVendorUuid, VENDOR);
    // verify uses the enrollment even without a pin in the environment
    assert.equal(
      (await verifyRuntime({ env: { ...fixture.env, ...learn }, timing: FAST })).ready,
      true,
    );
    first.sigterm();
    assert.equal(await first.done, EXIT.OK);
    assert.ok(existsSync(enrollment), 'enrollment outlives the runtime');

    // A later start with a different device behind the same endpoint is refused.
    fixture.write('wda.json', {
      ready: true,
      name: 'iPhone',
      uuid: 'FFFFFFFF-0000-4000-8000-0123456789AB',
    });
    const second = launch(fixture, { env: learn });
    assert.equal(await second.done, EXIT.FAILURE);
    assert.equal(fixture.has('posts.log'), true, 'only the first start created a session');
    assert.equal(fixture.lines('posts.log').length, 1);
    // A conflicting explicit pin is refused before anything starts.
    const before = fixture.lines('requests.log').length;
    const third = launch(fixture, {
      env: { IOS_EXPECTED_VENDOR_UUID: 'FFFFFFFF-0000-4000-8000-0123456789AB' },
    });
    assert.equal(await third.done, EXIT.FAILURE);
    assert.equal(fixture.lines('requests.log').length, before);
  },
);

test(
  'learning refuses an endpoint the supervisor does not own and stores nothing',
  { skip },
  async () => {
    const fixture = await makeFixture({ wda: { forkListener: true } });
    const run = launch(fixture, { env: { IOS_EXPECTED_VENDOR_UUID: undefined } });
    assert.equal(await run.done, EXIT.FAILURE);
    assert.ok(
      run.events.some((entry) => /not held solely by the owned proxy/.test(entry.message ?? '')),
    );
    assert.equal(existsSync(`${fixture.binding}.vendor-uuid.json`), false);
    assert.equal(fixture.has('posts.log'), false);
    assert.equal(fixture.has('xcodebuild.json'), false, 'the runner never started');
  },
);

test('IOS_RUNTIME_CONFIG supplies private settings, rejects loose permissions and credentials', async () => {
  const fixture = await makeFixture();
  const keep = Object.fromEntries(
    Object.entries(fixture.env).filter(([key]) => CONFIG_FILE_KEYS.includes(key)),
  );
  const file = join(fixture.root, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({ ...keep, DEVICE_SERVICE_PORT: Number(keep.DEVICE_SERVICE_PORT) }),
    {
      mode: 0o600,
    },
  );
  const bare = { IOS_RUNTIME_CONFIG: file, PATH: '/usr/bin' };
  assert.equal(parseIosRuntimeConfig(loadRuntimeEnv(bare)).udid, UDID);
  assert.equal(loadRuntimeEnv(bare).DEVICE_SERVICE_PORT, keep.DEVICE_SERVICE_PORT);
  chmodSync(file, 0o644);
  assert.throws(() => loadRuntimeEnv(bare), /group or world/);
  chmodSync(file, 0o600);
  writeFileSync(file, JSON.stringify({ ...keep, TYPESAFE_API_KEY: 'x' }), { mode: 0o600 });
  assert.throws(() => loadRuntimeEnv(bare), /not allowed: TYPESAFE_API_KEY/);
  writeFileSync(file, '{broken', { mode: 0o600 });
  assert.throws(() => loadRuntimeEnv(bare), /valid JSON/);
  assert.equal(await runSupervisor({ env: bare, log: () => {} }), EXIT.USAGE);
});

test(
  'runtime rejects redirects without forwarding readiness reads or session POSTs',
  { skip },
  async () => {
    let destinationRequests = 0;
    const destination = createServer((req, res) => {
      destinationRequests++;
      res.end('{}');
    });
    await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
    try {
      for (const redirectCode of [307, 308])
        for (const redirectPath of ['/status', '/session']) {
          const fixture = await makeFixture({
            wda: {
              redirectCode,
              redirectPath,
              redirectUrl: `http://127.0.0.1:${destination.address().port}/forwarded`,
            },
          });
          const run = launch(fixture);
          assert.equal(await run.done, EXIT.FAILURE);
          assert.equal(destinationRequests, 0);
          const posts = fixture.lines('requests.log').filter((line) => line === 'POST /session');
          assert.equal(posts.length, redirectPath === '/session' ? 1 : 0);
        }
    } finally {
      await new Promise((resolve) => destination.close(resolve));
    }
  },
);
