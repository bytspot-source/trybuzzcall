const test = require('node:test');
const assert = require('node:assert/strict');
const { drainAndFlush } = require('../src/shutdown');

test('shutdown waits for requests before flushing vendor and platform state', async () => {
  const steps=[];
  const server={close(done){steps.push('stop accepting');setImmediate(()=>{steps.push('requests finished');done();});},closeIdleConnections(){steps.push('close idle');}};
  await drainAndFlush(server,async()=>{steps.push('flush vendors');await Promise.resolve();steps.push('flush platform');});
  assert.deepEqual(steps,['stop accepting','close idle','requests finished','flush vendors','flush platform']);
});
test('shutdown reports storage failure instead of declaring a clean exit', async () => {
  await assert.rejects(drainAndFlush({close(done){done();}},async()=>{throw new Error('Storage unavailable');}),/Storage unavailable/);
});
test('shutdown bounds a stuck request and never flushes while it is still running', async () => {
  let forced=false,flushed=false;
  await assert.rejects(drainAndFlush({close(){},closeAllConnections(){forced=true;}},async()=>{flushed=true;},{timeoutMs:5}),/Shutdown timed out/);
  assert.equal(forced,true);assert.equal(flushed,false);
});
