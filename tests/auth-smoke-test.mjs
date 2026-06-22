import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 8799;
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  SHOPIFY_SHOP_DOMAIN: '',
  SHOPIFY_ADMIN_TOKEN: '',
  DASHBOARD_USERNAME: 'sweet',
  DASHBOARD_PASSWORD: 'secret-test-password'
};

const server = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const res = await fetch(`${base}/api/shopify/status`);
      return res;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server did not start: ${output}`);
}

try {
  await waitForServer();

  const staticNoAuth = await fetch(`${base}/index.html`);
  assert.equal(staticNoAuth.status, 401, 'static dashboard should require login without auth');
  assert.match(await staticNoAuth.text(), /Authentication required|Login required/i);

  const apiNoAuth = await fetch(`${base}/api/shopify/status`);
  assert.equal(apiNoAuth.status, 401, 'API should require login without auth');

  const authHeader = `Basic ${Buffer.from('sweet:secret-test-password').toString('base64')}`;
  const staticWithAuth = await fetch(`${base}/index.html`, { headers: { authorization: authHeader } });
  assert.equal(staticWithAuth.status, 200, 'static dashboard should load with correct auth');
  assert.match(await staticWithAuth.text(), /Sweet Sunday/i);

  const apiWithAuth = await fetch(`${base}/api/shopify/status`, { headers: { authorization: authHeader } });
  assert.equal(apiWithAuth.status, 200, 'API should load with correct auth');
  const payload = await apiWithAuth.json();
  assert.equal(payload.ok, true);
} finally {
  server.kill('SIGTERM');
}
