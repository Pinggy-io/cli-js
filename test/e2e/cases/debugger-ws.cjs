const { withTunnel, withEcho, pickHttpsUrl, sleep } = require('../lib/framework.cjs');

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
  throw new Error(`could not connect to debugger ws: ${openErr && openErr.message}`);
}

module.exports = {
  name: 'debugger-ws',
  async run() {
    await withEcho('http', (echo) =>
      withTunnel(
        { name: 'debugger-ws', build: { localPort: echo.port } },
        async ({ urls, dbg }) => {
          const url = pickHttpsUrl(urls);
          const ws = await connectWs(dbg);
          const frames = [];
          ws.addEventListener('message', (ev) => {
            try { frames.push(JSON.parse(ev.data.toString())); } catch {}
          });

          await fetch(url, {
            headers: { 'X-WS-Probe': 'yes' },
            signal: AbortSignal.timeout(30000),
          });

          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            if (frames.some((f) => f && (f.req || f.res))) break;
            await sleep(500);
          }
          ws.close();
          if (!frames.some((f) => f && (f.req || f.res))) {
            throw new Error(`no req/res frame received; frames: ${JSON.stringify(frames).slice(0, 500)}`);
          }
        }
      )
    );
  },
};
