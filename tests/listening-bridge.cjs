const assert = require('node:assert/strict');
(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ server: { port: 5187, strictPort: true, watch: null } });
  try {
    await server.listen();
    const call = async (request, headers = {}) => {
      const response = await fetch('http://127.0.0.1:5187/__tts', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(request) });
      return { status: response.status, value: response.status === 403 ? null : await response.json() };
    };
    assert.equal((await fetch('http://127.0.0.1:5187/__tts')).status, 403);
    assert.equal((await call({ action: 'config' }, { Origin: 'https://untrusted.example' })).status, 403);
    const config = await call({ action: 'config' });
    assert.equal(config.status, 200); assert.equal(config.value.available, true);
    assert.equal(config.value.python, undefined); assert.equal(config.value.model, undefined);
    const state = await call({ action: 'snapshot' });
    assert.equal(state.status, 200); assert.equal(state.value.engine.phase, 'idle'); assert.equal(state.value.model.installed, true);
    assert.equal((await call({ action: 'configure', python: 'untrusted.exe', model: '.' })).status, 400);
    const invalid = await call({ action: 'submit', bookId: 'a', bookHash: 'invalid', segments: [] });
    assert.equal(invalid.status, 400); assert.ok(invalid.value.error);
    console.log('Real dev bridge: default runtime/model, JSON protocol, idle GPU and request rejection passed.');
  } finally { await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
