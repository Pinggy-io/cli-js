const fs = require('fs');
const path = require('path');
const {
  withTunnel, withEcho, pickHttpsUrl, pickHttpUrl, fetchJson, getPublicIp, sleep, workDir,
} = require('../lib/framework.cjs');

// 1 tunnel carries every HTTP option the separate cases test 1 at a time: headers, basic-auth,
// bearer-auth, whitelist-allow, https-only, debugger-ws and config-roundtrip. Those run in the
// `full` suite. When this case fails, run the one named in the error to narrow it down.
const BASIC = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
const WRONG_BASIC = 'Basic ' + Buffer.from('alice:wrong').toString('base64');
const BEARER_TOKEN = 'tk_test_abc123';
const BEARER = `Bearer ${BEARER_TOKEN}`;
const FRAME_DEADLINE_MS = 15000;

function fail(separateCase, message) {
  throw new Error(`[${separateCase}] ${message}`);
}

function extOpts() {
  const opts = ['a:X-E2E-Add:hello', 'u:User-Agent:e2e-runner', 'r:Cookie', 'x:xff', 'x:https',
    'b:alice:s3cret', `k:${BEARER_TOKEN}`];
  const ip = getPublicIp();
  if (ip) opts.push(`w:${ip}/32`);
  else process.stdout.write('  no public IP parsed from an earlier tunnel URL: whitelist not tested\n');
  return opts;
}

async function checkAuth(url) {
  const noCreds = await fetchJson(url);
  if (noCreds.status !== 401) fail('basic-auth', `without creds expected 401, got ${noCreds.status}`);
  const wrong = await fetchJson(url, { headers: { Authorization: WRONG_BASIC } });
  if (wrong.status !== 401) fail('basic-auth', `wrong creds expected 401, got ${wrong.status}`);
  const bearer = await fetchJson(url, { headers: { Authorization: BEARER } });
  if (bearer.status !== 200) fail('bearer-auth', `with bearer expected 200, got ${bearer.status}`);
}

// Also the basic-auth and whitelist-allow pass: this request gets through with the right password.
async function checkHeaders(url) {
  const { status, json } = await fetchJson(url, {
    headers: {
      Authorization: BASIC,
      'User-Agent': 'original-ua',
      Cookie: 'should-be-removed=1',
      'X-Keep-Me': 'still-here',
    },
  });
  if (status !== 200) fail('basic-auth or whitelist-allow', `correct creds expected 200, got ${status}`);
  if (!json) fail('headers', 'echo did not return JSON');
  const h = json.headers || {};
  const dump = `received headers: ${JSON.stringify(h)}`;
  if (h['x-e2e-add'] !== 'hello') fail('headers', `x-e2e-add missing/wrong: ${h['x-e2e-add']}. ${dump}`);
  if (h['user-agent'] !== 'e2e-runner') fail('headers', `user-agent not updated: ${h['user-agent']}. ${dump}`);
  if (h['cookie']) fail('headers', `cookie should have been removed, got: ${h['cookie']}. ${dump}`);
  if (h['x-keep-me'] !== 'still-here') fail('headers', `passthrough header lost. ${dump}`);
  if (!h['x-forwarded-for']) fail('headers', `x-forwarded-for not injected despite x:xff. ${dump}`);
}

async function checkHttpsOnly(urls) {
  const httpsUrl = pickHttpsUrl(urls);
  const httpUrl = pickHttpUrl(urls) ?? httpsUrl.replace(/^https:/, 'http:');
  const res = await fetchJson(httpUrl, { headers: { Authorization: BASIC } });
  if (res.status === 200) fail('https-only', 'http url returned 200, expected redirect/reject under x:https');
}

async function connectWs(dbg) {
  let openErr = null;
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    try {
      const candidate = new WebSocket(`ws://${host}:${dbg}/introspec/websocket`);
      await new Promise((resolve, reject) => {
        candidate.addEventListener('open', resolve, { once: true });
        candidate.addEventListener('error', (e) => reject(new Error(e.message || 'connect failed')), { once: true });
        setTimeout(() => reject(new Error('open timeout')), 5000);
      });
      return candidate;
    } catch (e) {
      openErr = e;
    }
  }
  return fail('debugger-ws', `could not connect to debugger ws: ${openErr && openErr.message}`);
}

async function checkDebuggerFrames(url, dbg) {
  const ws = await connectWs(dbg);
  const frames = [];
  ws.addEventListener('message', (ev) => {
    try { frames.push(JSON.parse(ev.data.toString())); } catch {}
  });
  const seen = () => frames.some((f) => f && (f.req || f.res));
  await fetchJson(url, { headers: { Authorization: BASIC, 'X-WS-Probe': 'yes' } });
  const deadline = Date.now() + FRAME_DEADLINE_MS;
  while (Date.now() < deadline && !seen()) await sleep(250);
  ws.close();
  if (!seen()) fail('debugger-ws', `no req/res frame received; frames: ${JSON.stringify(frames).slice(0, 500)}`);
}

module.exports = {
  name: 'http-options',
  suite: 'ci',
  async run() {
    const cfgPath = path.join(workDir, 'http-options-cfg.json');
    await withEcho('http', async (echo) => {
      await withTunnel(
        { name: 'http-options', build: { localPort: echo.port, extOpts: extOpts(), extraFlags: ['--saveconf', cfgPath] } },
        async ({ urls, dbg }) => {
          const url = pickHttpsUrl(urls);
          if (!url || !url.startsWith('https://')) fail('https-only', 'no https url to test against');
          await checkAuth(url);
          await checkHeaders(url);
          await checkHttpsOnly(urls);
          await checkDebuggerFrames(url, dbg);
          if (!fs.existsSync(cfgPath)) fail('config-roundtrip', 'config file not written');
        }
      );

      // The saved config carries the options, so the 2nd tunnel must enforce them too.
      await withTunnel(
        { name: 'http-options-loadconf', build: { confFile: cfgPath, omitServer: true } },
        async ({ urls }) => {
          const url = pickHttpsUrl(urls);
          const noCreds = await fetchJson(url);
          if (noCreds.status !== 401) fail('config-roundtrip', `loaded config lost its auth: got ${noCreds.status} without creds`);
          await checkHeaders(url);
        }
      );
    });
  },
};
