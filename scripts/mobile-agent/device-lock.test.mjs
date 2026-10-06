import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDeviceLock } from './device-lock.mjs';

const moduleUrl = new URL('./device-lock.mjs', import.meta.url).href;
const jevSimSource =
  process.env.JEV_SIM_SRC || fileURLToPath(new URL('../../../jev-sim/src', import.meta.url));
const venvPython = join(jevSimSource, '../.venv/bin/python');
const PYTHON = process.env.JEV_SIM_PYTHON || (existsSync(venvPython) ? venvPython : 'python3');
const probe = spawnSync(PYTHON, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], {
  encoding: 'utf8',
});
const crossLanguage =
  existsSync(join(jevSimSource, 'jev_sim/device_lock.py')) && probe.stdout?.trim() === 'True'
    ? false
    : 'Python >=3.10 or jev-sim source is unavailable (set JEV_SIM_PYTHON / JEV_SIM_SRC)';

const IDENTITY = 'lock-test-device';
const lockName = (identity = IDENTITY) =>
  createHash('sha256').update(identity).digest('hex').slice(0, 24) + '.lock';

// Pin the environment so a developer's shell cannot redirect or rename the lock.
function pinnedEnv(root, extra = {}) {
  const env = { ...process.env, AGENT_DEVICE_LOCK_ROOT: root, ...extra };
  delete env.AGENT_DEVICE_IDENTITY;
  return env;
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'device-lock-'));
  const saved = {
    root: process.env.AGENT_DEVICE_LOCK_ROOT,
    identity: process.env.AGENT_DEVICE_IDENTITY,
  };
  process.env.AGENT_DEVICE_LOCK_ROOT = root;
  delete process.env.AGENT_DEVICE_IDENTITY;
  try {
    await fn(root);
  } finally {
    for (const [key, name] of [
      ['root', 'AGENT_DEVICE_LOCK_ROOT'],
      ['identity', 'AGENT_DEVICE_IDENTITY'],
    ]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('close', resolve));
  return child.pid;
}

async function writeStale(root, pid, identity = IDENTITY) {
  const path = join(root, lockName(identity));
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'owner.json'),
    JSON.stringify({ pid, deviceId: identity, runId: 'stale' }),
  );
  return path;
}

const ownerOf = async (path) => JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));

function run(command, args, env, stdin = 'ignore') {
  const child = spawn(command, args, { env, stdio: [stdin, 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const done = new Promise((resolve) =>
    child.once('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })),
  );
  return { child, done, output: () => stdout };
}

const NODE_CONTENDER = `
import { acquireDeviceLock } from ${JSON.stringify(moduleUrl)};
const [start, hold] = [Number(process.env.START_AT), Number(process.env.HOLD_MS)];
while (Date.now() < start);
try {
  const release = await acquireDeviceLock(${JSON.stringify(IDENTITY)});
  console.log('ACQUIRED');
  await new Promise((resolve) => setTimeout(resolve, hold));
  await release();
} catch (error) {
  console.log('REJECTED ' + error.message);
}
`;

const PYTHON_CONTENDER = `
import os, sys, time
sys.path.insert(0, os.environ["JEV_SIM_SRC"])
from jev_sim.device_lock import DeviceLock
while time.time() * 1000 < float(os.environ["START_AT"]):
    pass
try:
    lock = DeviceLock(${JSON.stringify(IDENTITY)}).acquire()
    print("ACQUIRED", flush=True)
    time.sleep(float(os.environ["HOLD_MS"]) / 1000)
    lock.release()
except Exception as error:
    print("REJECTED " + str(error), flush=True)
`;

const contender = (language, root, startAt) =>
  language === 'node'
    ? run(
        process.execPath,
        ['--input-type=module', '-e', NODE_CONTENDER],
        pinnedEnv(root, { START_AT: String(startAt), HOLD_MS: '500' }),
      )
    : run(
        PYTHON,
        ['-c', PYTHON_CONTENDER],
        pinnedEnv(root, {
          START_AT: String(startAt),
          HOLD_MS: '500',
          JEV_SIM_SRC: jevSimSource,
        }),
      );

async function race(root, languages) {
  const pid = await deadPid();
  await writeStale(root, pid);
  const startAt = Date.now() + 600;
  const results = await Promise.all(languages.map((l) => contender(l, root, startAt).done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  return results.map((r) => r.stdout);
}

function assertSingleWinner(outputs) {
  const winners = outputs.filter((line) => line === 'ACQUIRED');
  assert.equal(winners.length, 1, outputs.join('\n'));
  for (const line of outputs.filter((l) => l !== 'ACQUIRED')) {
    assert.match(
      line,
      /^REJECTED (Device busy:|Device lock acquisition guard|Device loop is already active)/,
    );
  }
}

test('stale-lock recovery lets exactly one of many processes acquire', async () => {
  await withRoot(async (root) => {
    for (let round = 0; round < 5; round++)
      assertSingleWinner(await race(root, Array(6).fill('node')));
  });
});

test(
  'Node and Python processes racing for one stale lock yield one owner',
  {
    skip: crossLanguage,
  },
  async () => {
    await withRoot(async (root) => {
      for (let round = 0; round < 4; round++)
        assertSingleWinner(
          await race(root, ['node', 'python', 'node', 'python', 'node', 'python']),
        );
    });
  },
);

test('the guard fails closed, is never reclaimed automatically, and blocks until removed', async () => {
  await withRoot(async (root) => {
    const guard = join(root, lockName() + '.guard');
    await mkdir(guard, { recursive: true });
    await assert.rejects(acquireDeviceLock(IDENTITY), /Device busy: acquisition guard/);
    assert.equal(existsSync(guard), true);
    assert.equal(existsSync(join(root, lockName())), false);
    // Even a dead-owner stale lock stays untouched while the guard is held.
    const stale = await writeStale(root, await deadPid());
    await assert.rejects(acquireDeviceLock(IDENTITY), /Device busy: acquisition guard/);
    assert.equal((await ownerOf(stale)).runId, 'stale');
    await rm(guard, { recursive: true });
    const release = await acquireDeviceLock(IDENTITY);
    assert.equal((await ownerOf(stale)).pid, process.pid);
    await release();
  });
});

test('a live owner is rejected, the guard is released, and nothing is replaced', async () => {
  await withRoot(async (root) => {
    const release = await acquireDeviceLock(IDENTITY);
    const path = join(root, lockName());
    const before = await ownerOf(path);
    await assert.rejects(acquireDeviceLock(IDENTITY), /Device busy: another task owns/);
    assert.deepEqual(await ownerOf(path), before);
    assert.equal(existsSync(path + '.guard'), false);
    await release();
    assert.equal(existsSync(path), false);
  });
});

test('invalid, unreadable and missing owner records fail closed without deletion', async () => {
  await withRoot(async (root) => {
    const path = join(root, lockName());
    for (const content of [
      undefined,
      '{not json',
      JSON.stringify({ pid: 0, deviceId: IDENTITY, runId: 'x' }),
      JSON.stringify({ pid: 1, deviceId: 'other', runId: 'x' }),
      JSON.stringify({ pid: 1, deviceId: IDENTITY, runId: 'x', extra: true }),
    ]) {
      await rm(path, { recursive: true, force: true });
      await mkdir(path, { recursive: true });
      if (content !== undefined) await writeFile(join(path, 'owner.json'), content);
      await assert.rejects(acquireDeviceLock(IDENTITY), /Device busy: lock/);
      assert.equal(existsSync(path), true);
      assert.equal(existsSync(path + '.guard'), false);
    }
  });
});

test('dead-owner reclaim installs a complete owner record and leaves no residue', async () => {
  await withRoot(async (root) => {
    await writeStale(root, await deadPid());
    const release = await acquireDeviceLock(IDENTITY);
    const owner = await ownerOf(join(root, lockName()));
    assert.deepEqual(Object.keys(owner).sort(), ['deviceId', 'pid', 'runId']);
    assert.equal(owner.pid, process.pid);
    assert.deepEqual(await readdir(root), [lockName()]);
    await release();
    assert.deepEqual(await readdir(root), []);
  });
});

test('release is owner specific, idempotent and tolerates a missing lock', async () => {
  await withRoot(async (root) => {
    const path = join(root, lockName());
    const release = await acquireDeviceLock(IDENTITY);
    await rm(path, { recursive: true });
    await release(); // Missing lock: no throw.
    await release();
    const first = await acquireDeviceLock(IDENTITY);
    const foreign = JSON.stringify({ pid: process.pid, deviceId: IDENTITY, runId: 'someone-else' });
    await writeFile(join(path, 'owner.json'), foreign);
    await first();
    assert.equal(await readFile(join(path, 'owner.json'), 'utf8'), foreign);
    assert.deepEqual(await readdir(root), [lockName()]);
  });
});

test(
  'Python holds the lock and Node must wait for its release; Node then holds against Python',
  {
    skip: crossLanguage,
  },
  async () => {
    await withRoot(async (root) => {
      const env = pinnedEnv(root, { JEV_SIM_SRC: jevSimSource });
      const holder = run(
        PYTHON,
        [
          '-c',
          `import os, sys
sys.path.insert(0, os.environ["JEV_SIM_SRC"])
from jev_sim.device_lock import DeviceLock
lock = DeviceLock(${JSON.stringify(IDENTITY)}).acquire()
print("HELD", flush=True)
sys.stdin.read()
lock.release()`,
        ],
        env,
        'pipe',
      );
      for (let i = 0; i < 100 && !holder.output().includes('HELD'); i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(holder.output(), /HELD/);
      await assert.rejects(acquireDeviceLock(IDENTITY), /Device busy: another task owns/);
      holder.child.stdin.end();
      assert.equal((await holder.done).code, 0);
      const release = await acquireDeviceLock(IDENTITY);
      const python = await run(
        PYTHON,
        [
          '-c',
          `import os, sys
sys.path.insert(0, os.environ["JEV_SIM_SRC"])
from jev_sim.device_lock import DeviceLock
DeviceLock(${JSON.stringify(IDENTITY)}).acquire()`,
        ],
        env,
      ).done;
      assert.notEqual(python.code, 0);
      assert.match(python.stderr, /already active/);
      await release();
    });
  },
);
