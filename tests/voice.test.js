'use strict';
// TwiML <Say> voice selection: VOICE_NAME / VOICE_NAME_ES, validation fallback, 'basic' = no voice attribute.
const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config = () => ({ parsed: {} });
for (const k of ['VOICE_NAME', 'VOICE_NAME_ES', 'VOICE_CONSENT_PROMPT']) delete process.env[k];
Object.assign(process.env, { BUSINESS_NAME: 'Peach State Plumbing', NODE_ENV: 'test' });
const voice = require('../src/voice');
const consent = require('../src/consent');

function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('defaults: warm neural female voices on every Say (English and Spanish)', () => {
  assert.equal(voice.voiceName(), 'Polly.Joanna-Neural');
  assert.equal(voice.voiceNameEs(), 'Polly.Mia-Neural');
  assert.equal(voice.say("we'll <call>"), '<Say voice="Polly.Joanna-Neural">we&apos;ll &lt;call&gt;</Say>');
  assert.equal(voice.say('hola', 'es'), '<Say language="es-MX" voice="Polly.Mia-Neural">hola</Say>');
});

test('the press-1 voice consent prompt is gone: consent.js offers no Gather or prompt helpers', () => {
  for (const removed of ['gatherTwiml', 'goodbyeTwiml', 'voicePrompt', 'spanishPrompt', 'offer', 'record', 'latest']) {
    assert.equal(consent[removed], undefined, removed);
  }
  assert.doesNotMatch(consent.optInSummary('Peach State Plumbing'), /press/i);
  assert.match(consent.optInSummary('Peach State Plumbing'), /written permission/);
});

test('custom valid voices are used', (t) => {
  withEnv(t, { VOICE_NAME: 'Google.en-US-Chirp3-HD-Aoede', VOICE_NAME_ES: 'Polly.Lupe-Neural' });
  assert.equal(voice.say('hi'), '<Say voice="Google.en-US-Chirp3-HD-Aoede">hi</Say>');
  assert.equal(voice.say('hola', 'es'), '<Say language="es-MX" voice="Polly.Lupe-Neural">hola</Say>');
});

test('invalid VOICE_NAME falls back to the default (no injection)', (t) => {
  for (const bad of ['Polly.Joanna"><Hangup/>', 'Acme.Voice', 'alice', 'Polly.', 'Polly.Jo anna']) {
    withEnv(t, { VOICE_NAME: bad, VOICE_NAME_ES: bad });
    assert.equal(voice.voiceName(), 'Polly.Joanna-Neural', bad);
    assert.equal(voice.voiceNameEs(), 'Polly.Mia-Neural', bad);
    assert.doesNotMatch(voice.say('x') + voice.say('x', 'es'), /Hangup\/>"|Acme|alice/);
  }
});

test("'basic' omits the voice attribute (old behavior)", (t) => {
  withEnv(t, { VOICE_NAME: 'basic', VOICE_NAME_ES: 'BASIC' });
  assert.equal(voice.say('hi'), '<Say>hi</Say>');
  assert.equal(voice.say('hola', 'es'), '<Say language="es-MX">hola</Say>');
});
