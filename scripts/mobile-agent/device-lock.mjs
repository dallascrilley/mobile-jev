// Shared tablet lock. The Node and Python (jev-sim/src/jev_sim/device_lock.py)
// implementations MUST stay byte-compatible:
//
//   <root>/<sha256(identity)[:24]>.lock          lock directory; owner.json inside
//   <root>/<sha256(identity)[:24]>.lock.guard    acquisition guard directory
//
// owner.json is exactly {"pid": int>0, "deviceId": identity, "runId": string}.
// A lock directory only ever appears at its final path with owner.json already
// inside it (staging directory + atomic rename), so a valid lock is never half built.
//
// Acquisition (including stale reclaim) is serialized by the guard:
//   1. mkdir <lock>.guard. EEXIST => fail closed ("Device busy"). No wait, no retry.
//   2. While holding the guard, inspect the lock. A live owner is rejected. A dead
//      owner is renamed to a tombstone and deleted. An absent/invalid owner record
//      is rejected (fail closed, never auto-reclaimed).
//   3. Build the new lock in <lock>.staging-<runId>, then rename it to <lock>.
//   4. Remove the guard.
// Renaming a stale lock alone is not safe: two contenders can both observe the same
// dead owner, and the slower one then renames away the lock the faster one just
// created. Every mutation of acquisition or stale reclaim therefore holds the guard.
//
// Release is owner specific and needs no guard. A live owner is never reclaimed, so
// no acquirer can replace the lock between release's read and its rename.
//
// GUARD CRASH CLEANUP (manual, intentionally never automatic): the guard is held for
// milliseconds. If a process is killed inside that window, <lock>.guard is left
// behind and every acquirer fails closed with "Device busy: acquisition guard ...".
// An operator must first confirm no jev or mobile-jev process is acquiring (the
// guard's guard.json records the pid), then run `rm -r <root>/<hash>.lock.guard`.
// Leftover <lock>.staging-* / <lock>.stale-* / <lock>.release-* directories are inert
// garbage and may be deleted at any time while nothing is acquiring.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const busy = (message) => new Error(`Device busy: ${message}`);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validOwner(owner, identity) {
  return (
    owner &&
    typeof owner === 'object' &&
    !Array.isArray(owner) &&
    Object.keys(owner).sort().join() === 'deviceId,pid,runId' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    owner.deviceId === identity &&
    typeof owner.runId === 'string' &&
    owner.runId !== ''
  );
}

async function readOwner(path, identity) {
  let text;
  try {
    text = await readFile(join(path, 'owner.json'), 'utf8');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code))
      throw busy(`lock has no owner record; refusing recovery: ${path}`);
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    throw busy(`lock owner record is unreadable; refusing recovery: ${path}`);
  }
  if (!validOwner(owner, identity))
    throw busy(`lock owner record is invalid; refusing recovery: ${path}`);
  return owner;
}

export async function acquireDeviceLock(
  deviceId,
  {
    root = (process.env.AGENT_DEVICE_LOCK_ROOT || '').trim() ||
      join(homedir(), '.local/state/agent-device-android/locks'),
  } = {},
) {
  const identity = (process.env.AGENT_DEVICE_IDENTITY || '').trim() || deviceId;
  if (!identity) throw new Error('Device identity is required for locking.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(
    root,
    createHash('sha256').update(identity).digest('hex').slice(0, 24) + '.lock',
  );
  const guard = `${path}.guard`;
  const runId = randomUUID();
  const owner = { pid: process.pid, deviceId: identity, runId };
  const staging = `${path}.staging-${runId}`;

  try {
    await mkdir(guard, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw busy(
      `acquisition guard is held or abandoned: ${guard}. If no jev process is acquiring, remove it manually (rm -r).`,
    );
  }

  let failure;
  try {
    await writeFile(join(guard, 'guard.json'), JSON.stringify({ pid: process.pid, runId }), {
      mode: 0o600,
    }).catch(() => {}); // Diagnostic only. The guard never depends on this file.
    if (await exists(path)) {
      const existing = await readOwner(path, identity);
      if (pidAlive(existing.pid))
        throw busy(`another task owns the tablet (pid=${existing.pid}, runId=${existing.runId}).`);
      const stale = `${path}.stale-${runId}`;
      await rename(path, stale);
      await rm(stale, { recursive: true, force: true });
    }
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, 'owner.json'), JSON.stringify(owner), {
      mode: 0o600,
      flag: 'wx',
    });
    if (await exists(path)) throw busy('lock appeared during acquisition; refusing to replace it.');
    await rename(staging, path);
  } catch (error) {
    failure = error;
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  let released;
  const release = () => (released ??= releaseOwned(path, runId));
  try {
    await rm(guard, { recursive: true });
  } catch (error) {
    if (!failure) {
      await release().catch(() => {});
      failure = error;
    }
  }
  if (failure) throw failure;
  return release;
}

// Owner-specific and tolerant: a missing, unreadable or foreign lock is left alone.
async function releaseOwned(path, runId) {
  const readRunId = async (directory) => {
    try {
      return JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'))?.runId;
    } catch {
      return undefined;
    }
  };
  if ((await readRunId(path)) !== runId) return;
  const tombstone = `${path}.release-${runId}`;
  try {
    await rename(path, tombstone);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if ((await readRunId(tombstone)) !== runId) {
    // Someone replaced our lock between read and rename; put it back if the path is free.
    await rename(tombstone, path).catch(() => {});
    return;
  }
  await rm(tombstone, { recursive: true, force: true });
}

export async function withDeviceLock(deviceId, fn) {
  const release = await acquireDeviceLock(deviceId);
  try {
    return await fn();
  } finally {
    await release();
  }
}
