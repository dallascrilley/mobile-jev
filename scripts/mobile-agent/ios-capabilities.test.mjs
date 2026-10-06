import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFor } from './actions.mjs';
import { buildQuestions } from './policy.mjs';

test('iOS policy offers only supported navigation and keeps observed Back buttons', () => {
  const observation = {
    platform: 'ios',
    screen: { width: 390, height: 844 },
    phone: { packageName: 'com.apple.Preferences', isEditable: false },
    capabilities: { globalActions: ['home'], keys: ['enter', 'delete'] },
    elements: [
      {
        id: '0.1',
        label: 'Back',
        text: '',
        enabled: true,
        clickable: true,
        bounds: { left: 0, top: 10, right: 50, bottom: 50 },
      },
    ],
  };
  const actions = candidatesFor(observation);
  assert.equal(actions.back, undefined);
  assert.deepEqual(actions.home, { type: 'global', name: 'home' });
  assert.deepEqual(actions['tap_0.1'], { type: 'tap-element', elementId: '0.1' });
  const space = buildQuestions(observation);
  assert.equal(space.questions.operation.criteria.BACK, undefined);
  assert.equal(space.questions.operation.criteria.HOME, 'Go to the device home screen.');
  assert.ok(space.questions.operation.criteria.TAP);
});
