const TRANSIENT_PORTAL_FAILURE =
  /Portal operation failed|Portal returned no structured state|Portal returned invalid JSON/i;

export async function retryReadOnlyReadiness(
  readReadyState,
  {
    attempts = 5,
    delayMs = 250,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (typeof readReadyState !== 'function') throw new TypeError('A readiness read is required.');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)
    throw new RangeError('Readiness attempts must be between 1 and 10.');
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5000)
    throw new RangeError('Readiness delay must be between 0 and 5,000 ms.');
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await readReadyState();
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_PORTAL_FAILURE.test(error.message) || attempt + 1 === attempts) throw error;
      await sleep(Math.min(delayMs * 2 ** attempt, 1000));
    }
  }
  throw lastError;
}
