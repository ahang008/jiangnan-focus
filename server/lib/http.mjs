// HTTP + SSE：只监听 127.0.0.1。/api/* 是接口，其余路径把 web 目录当静态网站（只读）。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RewardError } from './rewards.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const BODY_LIMIT = 64 * 1024;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体太大'), { status: 413 }));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('请求体不是 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// 只接受本机的 Host（防 DNS rebinding）；有 Origin 时必须是本机同源（防别的网页跨站 POST）
function hostAllowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (port === 80) { ok.add('127.0.0.1'); ok.add('localhost'); }
  return ok.has(host);
}

function originAllowed(req, port) {
  const o = req.headers.origin;
  if (!o) return true;
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}` || o === `http://[::1]:${port}`;
}

export function createApp({ engine, webDir, nowFn = Date.now, log = () => {}, onStop = null }) {
  const clients = new Set();
  const webRoot = path.resolve(webDir);
  let realWebRoot = null;
  let boundPort = 0;

  function sseSend(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcastState() {
    if (!clients.size) return;
    const s = engine.getState(nowFn());
    for (const res of clients) sseSend(res, 'state', s);
  }

  engine.on('beat', (b) => {
    for (const res of clients) sseSend(res, 'beat', b);
  });

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: 'bad_path' }); }
    if (rel.includes('\0')) return sendJson(res, 400, { error: 'bad_path' });
    let target = path.resolve(webRoot, '.' + path.posix.normalize('/' + rel));
    if (target !== webRoot && !target.startsWith(webRoot + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      let st = await fsp.stat(target);
      if (st.isDirectory()) {
        target = path.join(target, 'index.html');
        st = await fsp.stat(target);
      }
      if (!st.isFile()) throw new Error('not file');
      // 符号链接也不能指到 web 目录外面
      if (!realWebRoot) realWebRoot = await fsp.realpath(webRoot);
      const real = await fsp.realpath(target);
      if (real !== realWebRoot && !real.startsWith(realWebRoot + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
      const type = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(real, { flags: 'r' });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      sendJson(res, 404, { error: 'not_found' });
    }
  }

  async function handle(req, res) {
    if (!hostAllowed(req, boundPort)) return sendJson(res, 403, { error: 'bad_host' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      if (req.method === 'POST' && !originAllowed(req, boundPort)) return sendJson(res, 403, { error: 'bad_origin' });
      const now = nowFn();
      if (p === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendJson(res, 200, engine.getState(now));
      }
      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        sseSend(res, 'state', engine.getState(now));
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, e.status || 400, { error: 'bad_body', message: e.message }); }
      try {
        if (p === '/api/reward/offer') {
          return sendJson(res, 200, engine.offerRewards(now));
        }
        if (p === '/api/reward/choose') {
          const r = engine.chooseReward(body && body.id, now);
          sendJson(res, 200, { ok: true, ...r, ...engine.getState(now) }); // 带完整 state 和 rev
          broadcastState();
          return;
        }
        if (p === '/api/focus/reset') {
          const s = engine.resetFocus(now);
          sendJson(res, 200, { ok: true, ...s }); // 完整 state 带 rev
          broadcastState();
          return;
        }
        if (p === '/api/settings') {
          const r = engine.updateSettings(body, now);
          if (r.errors) return sendJson(res, 400, { error: 'invalid_settings', messages: r.errors });
          sendJson(res, 200, { ok: true, ...engine.getState(now), settings: r.settings }); // 带完整 state 和 rev
          broadcastState();
          return;
        }
        if (p === '/api/stop') {
          sendJson(res, 200, { ok: true });
          if (onStop) setImmediate(onStop);
          return;
        }
      } catch (e) {
        if (e instanceof RewardError) return sendJson(res, e.status, { error: e.code, message: e.message });
        log('接口出错', e && e.message);
        return sendJson(res, 500, { error: 'internal' });
      }
      return sendJson(res, 404, { error: 'not_found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
    return serveStatic(req, res, p);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('请求出错', e && e.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 5000;

  return {
    server,
    clients,
    broadcastState,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          boundPort = server.address().port;
          resolve(boundPort);
        });
      });
    },
    close() {
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
