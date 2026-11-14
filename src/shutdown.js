// Stop accepting requests, finish in-flight work, then flush every store. A failed
// or timed-out shutdown is surfaced to the process supervisor, never called clean.
async function drainAndFlush(server, flush, { timeoutMs = 10000 } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      server.closeAllConnections?.();
      reject(new Error('Shutdown timed out'));
    }, timeoutMs);
  });
  const work = (async () => {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
    await flush();
  })();
  try { await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); }
}
module.exports = { drainAndFlush };
