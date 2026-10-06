import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  InstallError,
  buildPlist,
  install,
  planInstall,
  xmlEscape,
} from './install-ios-service.mjs';

// The installer is exercised against temporary directories, a recorded launchctl stand-in, and a
// local health endpoint. No LaunchAgent is loaded and no device is touched.
const UDID = '00008110-001A2B3C4D5E6F78';
const REVISION = '0123456789abcdef0123456789abcdef01234567';
const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture({ extra = {}, port = 18100, servicePort = 3042, udid = UDID } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ios-install-test-')));
  roots.push(root);
  const products = join(root, 'Build', 'Products');
  mkdirSync(products, { recursive: true });
  writeFileSync(join(products, 'WebDriverAgentRunner_iphoneos27.0-arm64.xctestrun'), '<plist/>');
  const source = join(root, 'source');
  mkdirSync(join(source, 'scripts'), { recursive: true });
  for (const name of ['with-typesafe-key.mjs', 'ios-runtime.mjs', 'device-service.mjs'])
    writeFileSync(join(source, 'scripts', name), '');
  const state = join(root, 'state');
  const agents = join(root, 'LaunchAgents');
  mkdirSync(agents);
  const config = join(root, `config-${udid}.json`);
  const values = {
    IOS_DEVICE_UDID: udid,
    IOS_DEVICE_NAME: "Dallas's <iPhone> & co",
    IOS_WDA_URL: `http://127.0.0.1:${port}`,
    IOS_WDA_BUILD_DIR: products,
    IOS_WDA_SOURCE_REVISION: REVISION,
    IOS_WDA_BINDING_FILE: join(state, `${udid}-binding.json`),
    DEVICE_SERVICE_PORT: servicePort,
    ...extra,
  };
  writeFileSync(config, JSON.stringify(values), { mode: 0o600 });
  const args = (...more) => [
    '--config',
    config,
    '--source-root',
    source,
    '--state-dir',
    state,
    '--launch-agents-dir',
    agents,
    '--node',
    process.execPath,
    '--ready-timeout',
    '1',
    ...more,
  ];
  return {
    root,
    source,
    state,
    agents,
    config,
    values,
    args,
    binding: values.IOS_WDA_BINDING_FILE,
  };
}

function harness({ running = true, loaded = false } = {}) {
  const calls = [];
  const lines = [];
  let isLoaded = loaded;
  return {
    calls,
    lines,
    deps: {
      uid: 501,
      sleep: async () => {},
      out: (line) => lines.push(JSON.parse(line)),
      run: async (bin, args) => {
        calls.push([bin, ...args]);
        if (args[0] === 'print')
          return {
            ok: isLoaded,
            stdout: isLoaded && running ? 'state = running' : 'state = waiting',
          };
        if (args[0] === 'bootstrap') isLoaded = true;
        return { ok: true, stdout: '' };
      },
    },
  };
}

async function health(status = 200) {
  const server = createServer((req, res) => res.writeHead(status).end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => server.close() };
}

test('xmlEscape handles markup characters and refuses control characters', () => {
  assert.equal(xmlEscape(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
  assert.throws(() => xmlEscape('bad\u0001value'), InstallError);
});

test(
  'the plist runs the credential wrapper around the runtime and points at the private config',
  {
    skip: process.platform !== 'darwin' && 'requires macOS plutil',
  },
  () => {
    const f = fixture();
    const sourceRoot = join(f.root, 'src & <tools>');
    const plist = buildPlist({
      label: `ai.typesafe.mobile-jev.ios.${UDID.toLowerCase()}`,
      node: '/usr/local/bin/node',
      sourceRoot,
      configPath: f.config,
      home: '/Users/example',
      user: 'example',
      pathEnv: '/opt/homebrew/bin:/usr/bin',
      logDir: join(f.state, 'logs'),
    });
    const file = join(f.root, 'out.plist');
    writeFileSync(file, plist);
    execFileSync('/usr/bin/plutil', ['-lint', file]);
    const parsed = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }),
    );
    assert.deepEqual(parsed.ProgramArguments, [
      '/usr/local/bin/node',
      join(sourceRoot, 'scripts/with-typesafe-key.mjs'),
      '/usr/local/bin/node',
      join(sourceRoot, 'scripts/ios-runtime.mjs'),
    ]);
    assert.equal(parsed.WorkingDirectory, sourceRoot);
    assert.deepEqual(Object.keys(parsed.EnvironmentVariables).sort(), [
      'HOME',
      'IOS_RUNTIME_CONFIG',
      'PATH',
      'USER',
    ]);
    assert.equal(parsed.EnvironmentVariables.IOS_RUNTIME_CONFIG, f.config);
    assert.equal(parsed.ThrottleInterval, 30);
    assert.equal(parsed.KeepAlive, true);
    assert.equal(parsed.RunAtLoad, true);
    assert.equal(parsed.ExitTimeOut, 30);
    assert.ok(!plist.includes('TYPESAFE'), 'no credential or reference in the plist');
  },
);

test('a dry run reports the plan and writes nothing', async () => {
  const f = fixture();
  const h = harness();
  const plan = planInstall(f.args());
  assert.equal(await install(plan, h.deps), 0);
  assert.equal(h.lines[0].mode, 'dry-run');
  assert.equal(h.lines[0].label, `ai.typesafe.mobile-jev.ios.${UDID.toLowerCase()}`);
  assert.equal(h.lines[0].servicePort, 3042);
  assert.deepEqual(h.calls, []);
  assert.equal(existsSync(plan.plistPath), false);
  assert.equal(existsSync(f.state), false);
});

test('install writes a private plist, bootstraps once, and reports readiness from the service', async () => {
  const service = await health();
  try {
    const f2 = fixture({
      servicePort: service.port,
      udid: '00008110-001A2B3C4D5E6F79',
      port: 18101,
    });
    const h = harness();
    const plan = planInstall(f2.args('--install'));
    assert.equal(await install(plan, h.deps), 0);
    assert.equal(statSync(plan.plistPath).mode & 0o777, 0o600);
    assert.equal(statSync(f2.state).mode & 0o777, 0o700);
    assert.equal(statSync(join(f2.state, 'logs')).mode & 0o777, 0o700);
    const bootstraps = h.calls.filter((call) => call[1] === 'bootstrap');
    assert.deepEqual(bootstraps, [['/bin/launchctl', 'bootstrap', 'gui/501', plan.plistPath]]);
    assert.deepEqual(h.lines.at(-1), { ready: true, label: plan.label, servicePort: service.port });
    // Running it again is idempotent: same plist, job already loaded, no second bootstrap.
    const again = harness({ loaded: true });
    assert.equal(await install(planInstall(f2.args('--install')), again.deps), 0);
    assert.equal(again.calls.filter((call) => call[1] === 'bootstrap').length, 0);
  } finally {
    service.close();
  }
});

test('readiness is bounded and reports failure when the service never answers', async () => {
  const f = fixture({ servicePort: 1025 });
  const h = harness({ running: false });
  const started = Date.now();
  assert.equal(await install(planInstall(f.args('--install')), h.deps), 1);
  assert.ok(Date.now() - started < 10_000);
  assert.equal(h.lines.at(-1).ready, false);
  assert.equal(
    h.calls.filter((call) => call[1] === 'bootout').length,
    0,
    'never unloads on failure',
  );
});

test('an existing different plist is preserved and nothing is loaded', async () => {
  const f = fixture();
  const plan = planInstall(f.args('--install'));
  writeFileSync(plan.plistPath, '<plist><!-- someone else --></plist>');
  const h = harness();
  assert.equal(await install(plan, h.deps), 1);
  assert.equal(readFileSync(plan.plistPath, 'utf8'), '<plist><!-- someone else --></plist>');
  assert.match(h.lines[0].problems.join(' '), /different plist already exists/);
  assert.deepEqual(h.calls, []);
});

test('an existing binding file for another device, or with live owners, blocks the install and is kept', async () => {
  for (const [name, manifest, pattern] of [
    ['another device', { deviceId: '00008110-FFFFFFFFFFFFFFFF', wdaUrl: 'x' }, /different device/],
    ['a live owner', null, /live owner/],
  ]) {
    const f = fixture();
    mkdirSync(f.state, { recursive: true });
    const content = JSON.stringify(
      manifest ?? { deviceId: UDID, wdaUrl: f.values.IOS_WDA_URL, runnerPid: process.pid },
    );
    writeFileSync(f.binding, content);
    const h = harness();
    assert.equal(await install(planInstall(f.args('--install')), h.deps), 1, name);
    assert.match(h.lines[0].problems.join(' '), pattern, name);
    assert.equal(readFileSync(f.binding, 'utf8'), content, `${name}: binding preserved`);
    assert.deepEqual(h.calls, [], name);
  }
});

test('two agents cannot share a port or binding file', async () => {
  const h1 = harness();
  const service = await health();
  try {
    // Install agent one for real into a shared LaunchAgents directory.
    const one = fixture({ servicePort: service.port });
    assert.equal(await install(planInstall(one.args('--install')), h1.deps), 0);
    for (const [name, extra] of [
      ['same WDA port', { udid: '00008110-001A2B3C4D5E6F80', port: 18100, servicePort: 3999 }],
      [
        'same service port',
        { udid: '00008110-001A2B3C4D5E6F81', port: 18199, servicePort: service.port },
      ],
    ]) {
      const two = fixture(extra);
      const plan = planInstall(
        [...two.args('--install')].map((v) => (v === two.agents ? one.agents : v)),
      );
      const h = harness();
      assert.equal(await install(plan, h.deps), 1, name);
      assert.match(h.lines[0].problems.join(' '), /same (wdaPort|servicePort)/, name);
      assert.deepEqual(h.calls, [], name);
    }
  } finally {
    service.close();
  }
});

test('planning rejects configs the runtime would reject, and loose config permissions', () => {
  for (const [name, extra, pattern] of [
    ['short revision', { IOS_WDA_SOURCE_REVISION: 'abc1234' }, /REVISION/],
    ['bad UDID', { IOS_DEVICE_UDID: '../x' }, /UDID/],
    ['non-loopback URL', { IOS_WDA_URL: 'http://192.168.1.5:18100' }, /127\.0\.0\.1/],
    ['unknown key', { TYPESAFE_API_KEY: 'secret' }, /not allowed/],
  ]) {
    const f = fixture({ extra });
    assert.throws(() => planInstall(f.args()), pattern, name);
  }
  const f = fixture();
  chmodSync(f.config, 0o644);
  assert.throws(() => planInstall(f.args()), /group or world/);
  assert.throws(() => planInstall(['--config', 'relative.json']), /absolute/);
  assert.throws(() => planInstall([]), /--config/);
});

test('installer refuses redirected health and never requests its destination', async () => {
  let destinationRequests = 0;
  const destination = createServer((req, res) => {
    destinationRequests++;
    res.end('{}');
  });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  try {
    for (const status of [307, 308]) {
      const redirect = createServer((req, res) =>
        res
          .writeHead(status, { location: `http://127.0.0.1:${destination.address().port}/health` })
          .end(),
      );
      await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
      try {
        const f = fixture({ servicePort: redirect.address().port });
        const h = harness();
        assert.equal(await install(planInstall(f.args('--install')), h.deps), 1);
        assert.equal(destinationRequests, 0);
        assert.equal(h.lines.at(-1).ready, false);
      } finally {
        await new Promise((resolve) => redirect.close(resolve));
      }
    }
  } finally {
    await new Promise((resolve) => destination.close(resolve));
  }
});
