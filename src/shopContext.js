'use strict';
// Request/job-local shop identity. run() restores the parent context on return or
// throw, while promises/timers created inside it retain their originating shop.
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const current = () => storage.getStore() || null;
const shopId = () => current()?.id ?? null;
function run(context, fn) {
  if (context !== null && (!context || !context.id || !context.store || !context.shop)) {
    throw new TypeError('Shop context requires id, store and shop');
  }
  return storage.run(context, fn);
}
module.exports = { current, shopId, run };
