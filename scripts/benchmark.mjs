import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createFixtureServer, EXPECTED_FORM } from './benchmark-fixture.mjs';
import { loadEnvironment, root } from './env.mjs';
import { createDevice } from './mobile-agent/device-factory.mjs';
import { acquireDeviceLock } from './mobile-agent/device-lock.mjs';
loadEnvironment();
const exec = promisify(execFile),
  device = createDevice();
const serial = device.deviceId;
const out = resolve(process.env.BENCHMARK_OUT || 'artifacts/comparison-20261006');
const configurations = ['mobile-jev', 'mobile-rizzo', 'sim-jev', 'adb-agent'];
const scenarios = [
  { id: 'dark-theme', goal: 'Turn on dark theme in Android Settings. Stop when Dark is selected.' },
  { id: 'timeout', goal: 'Set the screen timeout to 5 minutes in Android Settings.' },
  { id: 'calculator', goal: 'Calculate 137 + 248 in Calculator and leave the result visible.' },
  {
    id: 'form',
    goal: 'In Chrome set Name "Taylor Tablet", Destination "Austin", Category "Support", Notes "Inspect tablet readiness". Scroll and select Review request. Stop at the review screen.',
  },
];
await mkdir(out, { recursive: true, mode: 0o700 });
const adb = async (...args) =>
  (
    await exec(process.env.ADB_BIN || 'adb', ['-s', serial, ...args], {
      timeout: 20000,
      maxBuffer: 20 * 1024 * 1024,
    })
  ).stdout.trim();
const fixture = createFixtureServer();
await new Promise((r) => fixture.server.listen(3042, '127.0.0.1', r));
await adb('reverse', 'tcp:3042', 'tcp:3042');
const original = {
  night: await adb('shell', 'cmd', 'uimode', 'night'),
  timeout: await adb('shell', 'settings', 'get', 'system', 'screen_off_timeout'),
};
await writeFile(join(out, 'original.json'), JSON.stringify(original), { mode: 0o600 });
const pins = {
  date: '2026-10-06',
  host: process.platform,
  node: process.versions.node,
  physicalIdentity: process.env.AGENT_DEVICE_IDENTITY,
  transport: serial,
  models: {
    jev: 'jev-1.13.0',
    rizzo: 'rizzo-flow-4b-q8_0',
    tev1: 'tev1:4b-q4_K_M',
    adb: 'gpt-6.1-sol',
  },
  simUse: (await exec('sim-use', ['--version'])).stdout.trim(),
  rizzo: await fetch('http://127.0.0.1:18094/health').then((r) => r.json()),
  tev1: await fetch('http://127.0.0.1:11434/api/tags').then((r) => r.json()),
  revision: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
  scenarioGoals: scenarios,
  selectedConfigurations: process.env.BENCHMARK_CONFIGS?.split(',') || configurations,
  repeatCount: Number(process.env.BENCHMARK_REPEATS || 1),
  calculator: {
    package: 'org.fossify.math',
    version: '1.4.0',
    apkSha256: '7c5443c22d6d62c67dfe80df33ea9161ff0fa440f92590bcb45d7008b57613ed',
  },
  revisions: {
    sim: (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: join(process.env.HOME, 'Code/oss/jev-sim') })
    ).stdout.trim(),
  },
  freshContext: {
    newProcess: true,
    resume: false,
    history: 'empty per trial',
    memory: false,
    skills: false,
    budget: { actions: 30, wallSeconds: 180 },
  },
};
for (const file of [
  'scripts/mobile-agent/policy.mjs',
  'scripts/mobile-agent/providers.mjs',
  'scripts/mobile-agent/local-device.mjs',
  'scripts/benchmark-mobile.mjs',
  'scripts/benchmark.mjs',
  'scripts/benchmark-fixture.mjs',
  'scripts/mobile-agent/device.mjs',
  'scripts/mobile-agent/agent.mjs',
  'scripts/mobile-agent/actions.mjs',
  'scripts/mobile-agent/text.mjs',
])
  pins[file] = createHash('sha256')
    .update(await readFile(join(root, file)))
    .digest('hex');
pins.simFiles = {};
for (const name of [
  'loop.py',
  'typesafe.py',
  'providers.py',
  'candidates.py',
  'sim_use.py',
  'device_lock.py',
])
  pins.simFiles[name] = createHash('sha256')
    .update(await readFile(join(process.env.HOME, 'Code/oss/jev-sim/src/jev_sim', name)))
    .digest('hex');
await writeFile(join(out, 'pins.json'), JSON.stringify(pins, null, 2) + '\n', { mode: 0o600 });
function runProcess(command, args, opts = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(command, args, {
      env: opts.env || process.env,
      cwd: opts.cwd || root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* process already exited */
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* process already exited */
        }
      }, 3000).unref();
    }, 180000);
    child.stdout.on('data', (x) => (stdout += x));
    child.stderr.on('data', (x) => (stderr += x));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exit: 1, stdout, stderr: e.message, wallMs: performance.now() - start, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exit: code, stdout, stderr, wallMs: performance.now() - start, timedOut });
    });
  });
}
async function reset(scenario, id) {
  const release = await acquireDeviceLock(serial);
  try {
    await adb('shell', 'input', 'keyevent', '3');
    await adb('shell', 'am', 'force-stop', 'com.android.settings');
    await adb('shell', 'am', 'force-stop', 'org.fossify.math');
    await adb('shell', 'cmd', 'uimode', 'night', 'no');
    await adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', '30000');
    if (scenario.id === 'calculator') {
      await adb(
        'shell',
        'am',
        'start',
        '--windowingMode',
        '1',
        '-n',
        'org.fossify.math/.activities.SplashActivity.Green',
      );
      await new Promise((r) => setTimeout(r, 1000));
      let o = await device.observe();
      const clear = o.elements.find((e) => e.enabled && (e.label === 'Clear' || e.text === 'C'));
      if (!clear) throw new Error('Calculator clear control missing.');
      await device.act({ type: 'tap-element', elementId: clear.id }, { expected: o });
      // Fossify C is backspace; hold C to clear the complete expression.
      const b = clear.bounds;
      const x = Math.floor((b.left + b.right) / 2),
        y = Math.floor((b.top + b.bottom) / 2);
      await adb('shell', 'input', 'swipe', String(x), String(y), String(x), String(y), '1200');
    } else if (scenario.id === 'form') {
      await adb(
        'shell',
        'am',
        'start',
        '--windowingMode',
        '1',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        `http://127.0.0.1:3042/?trial=${id}`,
        '-p',
        'com.android.chrome',
      );
    } else
      await adb(
        'shell',
        'am',
        'start',
        '--windowingMode',
        '1',
        '-a',
        'android.settings.DISPLAY_SETTINGS',
      );
    await new Promise((r) => setTimeout(r, 1000));
    let observation;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        observation = await device.observe();
        const expected =
          scenario.id === 'calculator'
            ? 'org.fossify.math'
            : scenario.id === 'form'
              ? 'com.android.chrome'
              : 'com.android.settings';
        if (observation.phone.packageName === expected && observation.elements.length > 4) break;
      } catch {
        /* transient read only */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!observation) throw new Error('No baseline observation.');
    if (
      observation.phone.packageName !==
      (scenario.id === 'calculator'
        ? 'org.fossify.math'
        : scenario.id === 'form'
          ? 'com.android.chrome'
          : 'com.android.settings')
    )
      throw new Error('Baseline foreground did not match.');
    const night = await adb('shell', 'cmd', 'uimode', 'night'),
      timeout = await adb('shell', 'settings', 'get', 'system', 'screen_off_timeout');
    if (!night.includes('no') || timeout !== '30000')
      throw new Error('Baseline Android settings not reset.');
    if (
      scenario.id === 'calculator' &&
      !observation.elements.some((e) => e.resourceId.endsWith(':id/result') && e.text === '0')
    )
      throw new Error('Calculator not reset to zero.');
    if (
      scenario.id === 'form' &&
      observation.elements.some(
        (e) => e.editable && ['name', 'destination', 'notes'].includes(e.resourceId) && e.text,
      )
    )
      throw new Error('Form values not empty.');
    return {
      night,
      timeout,
      foreground: observation.phone.packageName,
      screen: observation.screen,
      fixtureEmpty: !fixture.receipts.has(id),
      initialValues:
        scenario.id === 'calculator'
          ? observation.elements
              .filter((e) => e.resourceId.endsWith(':id/result'))
              .map((e) => e.text)
          : scenario.id === 'form'
            ? observation.elements
                .filter(
                  (e) => e.editable && ['name', 'destination', 'notes'].includes(e.resourceId),
                )
                .map((e) => e.text)
            : undefined,
      fingerprint: observation.fingerprint,
    };
  } finally {
    await release();
  }
}
async function grade(scenario, id) {
  const o = await device.observe();
  if (scenario.id === 'dark-theme') {
    const state = await adb('shell', 'cmd', 'uimode', 'night');
    return { verified: state.includes('yes'), evidence: { night: state } };
  }
  if (scenario.id === 'timeout') {
    const state = await adb('shell', 'settings', 'get', 'system', 'screen_off_timeout');
    return { verified: state === '300000', evidence: { timeout: state } };
  }
  if (scenario.id === 'calculator') {
    const found = o.elements.filter((e) => /(result|calc_result)/i.test(e.resourceId));
    const exact = found.some((e) => (e.text || e.label).replace(/[,\s]/g, '') === '385');
    return {
      verified: o.phone.packageName === 'org.fossify.math' && exact,
      evidence: {
        foreground: o.phone.packageName,
        results: found.map((e) => ({ id: e.resourceId, text: e.text, label: e.label })),
      },
    };
  }
  const receipt = fixture.receipts.get(id);
  return {
    verified: Boolean(receipt) && Object.entries(EXPECTED_FORM).every(([k, v]) => receipt[k] === v),
    evidence: { receipt: receipt || null },
  };
}
const only = process.env.BENCHMARK_CONFIGS?.split(',') || configurations;
const repeats = Number(process.env.BENCHMARK_REPEATS || 1);
try {
  for (let rep = 0; rep < repeats; rep++)
    for (const scenario of scenarios)
      for (let k = 0; k < configurations.length; k++) {
        const configuration =
          configurations[(k + rep + scenarios.indexOf(scenario)) % configurations.length];
        if (!only.includes(configuration)) continue;
        const id = `${scenario.id}-${configuration}-${rep + 1}`;
        const trace = join(out, id + '.jsonl');
        console.log(JSON.stringify({ event: 'trial_start', id }));
        let baseline, result, verification, error;
        try {
          baseline = await reset(scenario, id);
          if (configuration === 'adb-agent') {
            const cwd = await mkdtemp(join(tmpdir(), 'android-adb-fresh-'));
            await writeFile(
              join(out, id + '-context.json'),
              JSON.stringify({
                cwd,
                priorHistory: false,
                projectDocs: false,
                userConfig: false,
                memory: false,
                tools: ['exec_command', 'write_stdin'],
                model: 'gpt-6.1-sol',
              }),
              { mode: 0o600 },
            );
            const codexHome = join(cwd, '.codex');
            await mkdir(codexHome, { mode: 0o700 });
            await copyFile(
              join(process.env.CODEX_HOME || join(process.env.HOME, '.codex'), 'auth.json'),
              join(codexHome, 'auth.json'),
            );
            const isolatedHome = join(cwd, 'home');
            await mkdir(isolatedHome, { mode: 0o700 });
            const instructions = `Control only the Android tablet with raw adb. Goal: ${scenario.goal}\nUse adb -s ${serial} shell uiautomator dump and adb -s ${serial} shell cat for observations; input tap/swipe/text/keyevent for actions. You may inspect foreground or settings read-only. Do not use settings writes, cmd uimode writes, browser/CDP APIs, prewritten scripts, other agents, memory, saved traces, or network. Use fresh UI observations, not guessed taps. Execute at most 30 individual device input actions within 180 seconds. Do not combine input actions in a shell command. Stop when all goal requirements visibly hold or blocked. You start with no prior history. Do not open other files beyond your own UI dump. Keep screenshots local. Do not enter credentials or submit external communications. Return concise outcome.`;
            await writeFile(join(cwd, 'instructions.txt'), instructions, { mode: 0o600 });
            await writeFile(join(out, id + '-instructions.txt'), instructions, { mode: 0o600 });
            const release = await acquireDeviceLock(serial);
            try {
              result = await runProcess(
                'codex',
                [
                  'exec',
                  '--ephemeral',
                  '--ignore-user-config',
                  '--ignore-rules',
                  '--skip-git-repo-check',
                  '--json',
                  '--dangerously-bypass-approvals-and-sandbox',
                  '-C',
                  cwd,
                  '-m',
                  'gpt-6.1-sol',
                  '-c',
                  'openai_base_url="http://127.0.0.1:10100/backend-api/codex"',
                  '-c',
                  'features.memories=false',
                  '-c',
                  'project_doc_max_bytes=0',
                  '-c',
                  'user_instructions=""',
                  '-c',
                  'features.multi_agent=false',
                  '-c',
                  'features.collab=false',
                  '-c',
                  'features.plugins=false',
                  '-c',
                  'features.apps=false',
                  '-c',
                  'skills.max_context_tokens=1',
                  '-c',
                  'memories.use_memories=false',
                  '-c',
                  'memories.generate_memories=false',
                  instructions,
                ],
                {
                  cwd,
                  env: {
                    PATH: process.env.PATH,
                    HOME: isolatedHome,
                    CODEX_HOME: codexHome,
                    TERM: 'dumb',
                  },
                },
              );
            } finally {
              await release();
              await rm(codexHome, { recursive: true, force: true });
              await rm(cwd, { recursive: true, force: true });
            }
            await writeFile(trace, result.stdout, { mode: 0o600 });
          } else {
            const [harness, backend] = configuration.split('-');
            result =
              harness === 'mobile'
                ? await runProcess(process.execPath, [
                    'scripts/benchmark-mobile.mjs',
                    backend,
                    scenario.goal,
                    trace,
                  ])
                : await runProcess(join(process.env.HOME, 'Code/oss/jev-sim/.venv/bin/jev-sim'), [
                    'loop',
                    scenario.goal,
                    '--backend',
                    backend,
                    '--device',
                    '100.74.61.90:5555',
                    '--max-steps',
                    '30',
                    '--trace',
                    trace,
                  ]);
          }
          verification = await grade(scenario, id);
        } catch (e) {
          error = e.message;
          verification = { verified: false, evidence: { error } };
        }
        const row = {
          id,
          scenario: scenario.id,
          configuration,
          repetition: rep + 1,
          baseline,
          process: result
            ? {
                exit: result.exit,
                wallMs: Math.round(result.wallMs),
                timedOut: result.timedOut,
                stderr: result.stderr.slice(0, 600),
              }
            : null,
          verification,
          error,
        };
        if (result) {
          await writeFile(join(out, id + '-stdout.txt'), result.stdout, { mode: 0o600 });
          try {
            const events = (await readFile(trace, 'utf8'))
              .trim()
              .split('\n')
              .map((x) => JSON.parse(x));
            row.modelDeclared = configuration.startsWith('sim-')
              ? events.findLast((x) => x.event === 'step')?.outcome
              : configuration === 'adb-agent'
                ? events.findLast((x) => x.item?.type === 'agent_message')?.item.text
                : events.findLast((x) => x.event === 'result' || x.event === 'outcome');
            row.actions = events.filter(
              (x) =>
                x.event === 'action' ||
                x.event === 'action_executed' ||
                (x.event === 'step' && x.executed),
            ).length;
            if (configuration === 'adb-agent')
              row.actions = events.filter(
                (x) =>
                  x.type === 'item.completed' &&
                  x.item?.type === 'command_execution' &&
                  /\binput\s+(tap|swipe|text|keyevent)\b/.test(x.item.command || ''),
              ).length;
          } catch {
            /* process already exited */
          }
        }
        await appendFile(join(out, 'results.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
        console.log(
          JSON.stringify({
            event: 'trial_end',
            id,
            verified: verification.verified,
            wallMs: row.process?.wallMs,
            error,
          }),
        );
      }
} finally {
  await adb('shell', 'cmd', 'uimode', 'night', original.night.includes('yes') ? 'yes' : 'no');
  await adb('shell', 'settings', 'put', 'system', 'screen_off_timeout', original.timeout);
  await adb('reverse', '--remove', 'tcp:3042');
  await new Promise((r) => fixture.server.close(r));
}
