import { open } from 'node:fs/promises';
import { loadEnvironment } from './env.mjs';
import { createDevice } from './mobile-agent/device-factory.mjs';
import { acquireDeviceLock } from './mobile-agent/device-lock.mjs';
import { TypeSafePolicy, runAgent } from './mobile-agent/agent.mjs';
import { decisionRequest } from './mobile-agent/providers.mjs';
import { decodeJson } from './mobile-agent/http.mjs';
loadEnvironment();
const [backend, goal, path] = process.argv.slice(2);
const file = await open(path, 'wx', 0o600);
const record = async (event) => file.write(JSON.stringify({ at: Date.now(), ...event }) + '\n');
const device = createDevice();
const release = await acquireDeviceLock(device.deviceId);
try {
  const policy = new TypeSafePolicy({
    backend,
    request: async (request) => {
      await record({ event: 'model_request', body: request.body });
      const t = performance.now();
      const result = await decisionRequest(request);
      await record({
        event: 'model_response',
        body: decodeJson(result),
        latencyMs: performance.now() - t,
      });
      return result;
    },
  });
  const result = await runAgent({
    device,
    policy,
    goal,
    execute: true,
    maxSteps: 30,
    settleMs: 800,
    onStep: (data) => record({ event: 'decision', ...data }),
    onAction: (data) => record({ event: 'action', ...data }),
    onObservation: (data) => record({ event: 'observation', ...data }),
  });
  await record({
    event: 'result',
    status: result.status,
    steps: result.steps,
    timings: result.timings,
  });
  console.log(
    JSON.stringify({ status: result.status, steps: result.steps, timings: result.timings }),
  );
} catch (error) {
  await record({ event: 'error', message: error.message });
  console.log(JSON.stringify({ status: 'error', error: error.message }));
  process.exitCode = 1;
} finally {
  await release();
  await file.close();
}
