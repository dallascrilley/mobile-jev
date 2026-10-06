async function readResponse(response, fallback) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || fallback);
  return value;
}

export async function sendObservedLocalAction(action, fetcher = fetch) {
  const observationResponse = await fetcher('/api/studio/local/observe', { cache: 'no-store' });
  const snapshot = await readResponse(observationResponse, 'Could not observe the local device.');
  if (typeof snapshot.observationId !== 'string' || !snapshot.observationId)
    throw new Error('The local device did not return an observation ID.');
  const actionResponse = await fetcher('/api/studio/local/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, observationId: snapshot.observationId }),
  });
  return readResponse(actionResponse, 'Could not control the local device.');
}
