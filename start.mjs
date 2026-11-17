#!/usr/bin/env node
// 江南入夜专注 · 一键启动 / 停止 / 状态。
// 用法：
//   node start.mjs          启动（若已在运行则只打开浏览器）
//   node start.mjs --no-open 启动但不自动开浏览器
//   node start.mjs --stop    停止后台的 focusd
//   node start.mjs --status  查看是否在运行和今天的用量
// 只监听 127.0.0.1；默认端口 4317，可用 JN_PORT 覆盖。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, SOURCE_LABELS } from './server/lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOCUSD = path.join(HERE, 'server', 'focusd.mjs');
const SERVICE = 'jiangnan-focus';

// DeepSeek Harness 的 zstd 解压依赖 Node 22+ 的 zlib.zstdDecompressSync；没有就跳过该来源
export function shouldSkipDsh(nodeVersion = process.versions.node, hasZstd = typeof zlib.zstdDecompressSync === 'function') {
  const major = Number(String(nodeVersion).split('.')[0]);
  return major < 22 || !hasZstd;
}

// 各平台打开浏览器的命令
export function openCommand(platform = process.platform) {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', args: [] };
}

function readPort() {
  const port = Number(process.env.JN_PORT === undefined ? 4317 : process.env.JN_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('JN_PORT 不是有效端口');
    process.exit(1);
  }
  if (port === 0) {
    console.error('start.mjs 不支持 JN_PORT=0（随机端口），请指定一个具体端口');
    process.exit(1);
  }
  return port;
}

// 强识别：必须带本程序专用 service 标识，且关键结构类型正确，才认作「本程序在跑」
export function isValidState(d) {
  return !!d && typeof d === 'object'
    && d.service === SERVICE
    && typeof d.boot === 'string' && d.boot.length > 0
    && Number.isInteger(d.rev)
    && Array.isArray(d.sessions)
    && !!d.today && typeof d.today === 'object'
    && typeof d.today.tokens === 'number'
    && !!d.today.bySource && typeof d.today.bySource === 'object';
}

// 拉取 /api/state；只有通过强识别才返回对象，否则返回 null
function fetchState(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/state',
      headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs,
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        try {
          const d = JSON.parse(Buffer.concat(parts).toString('utf8'));
          resolve(isValidState(d) ? d : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? 'occupied' : 'error'));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve('free')));
  });
}

function httpRequest(port, pathname, method, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` },
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function waitClosed(port, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port) === 'free') return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// 打开浏览器：成功与否都不影响启动结果；命令不存在或打不开时只提示手动访问。
// spawnImpl/platform 可注入，便于回归测试 opener ENOENT。
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const { cmd, args } = openCommand(platform);
  let p;
  try {
    p = spawnImpl(cmd, [...args, url], { stdio: 'ignore', detached: true });
  } catch {
    console.log(`无法自动打开浏览器，请手动访问：${url}`);
    return null;
  }
  p.on('error', () => {
    console.log(`无法自动打开浏览器，请手动访问：${url}`);
  });
  p.unref();
  return p;
}

async function waitReady(port, child, errBuf, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const detail = errBuf && errBuf.text ? `\n${errBuf.text.trim()}` : '';
      throw new Error(`focusd 启动失败（进程已退出，code=${child.exitCode ?? child.signalCode}）。${detail || '可运行 node server/focusd.mjs 看错误日志'}`);
    }
    if (await fetchState(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等待 focusd 就绪超时（可运行 node server/focusd.mjs 看错误日志）');
}

function printSources(cfg, st) {
  console.log('检测到的来源：');
  for (const src of cfg.sources) {
    const p = src.paths[0] || '';
    const exists = p ? fs.existsSync(p) : false;
    const tokens = (st.today && st.today.bySource && st.today.bySource[src.id] && st.today.bySource[src.id].tokens) || 0;
    console.log(`  ${src.label}：${p ? `${exists ? '存在' : '不存在'} ${p}` : '已停用'}，今天 token ${tokens}`);
  }
}

function printZeroGuide(port) {
  console.log('今天还没有读到任何 AI 使用记录。这是正常的：');
  console.log('  - 本程序只统计今天改动过的本地日志，不联网、不会自己产生记录。');
  console.log('  - 先看 60 秒演示效果：http://127.0.0.1:' + port + '/?demo=1');
  console.log('  - 确认 Claude Code / Codex / DeepSeek Harness / Grok Build / Magpie 今天有日志后，刷新页面即可。');
}

function printStatusBySource(st) {
  if (!st.today || !st.today.bySource) return;
  for (const id of Object.keys(st.today.bySource)) {
    const a = st.today.bySource[id];
    console.log(`  ${SOURCE_LABELS[id] || id}：token ${a.tokens}，会话 ${a.sessions}，工具 ${a.tools}`);
  }
}

async function stopServer(port) {
  const st = await fetchState(port);
  if (!st) {
    if (await probePort(port) === 'occupied') {
      console.error(`端口 ${port} 已被占用，但该服务不是本程序（或版本不匹配）。请手动停止占用者，或换 JN_PORT。`);
      process.exit(1);
    }
    console.log('江南入夜专注 · 没有在运行。');
    return;
  }
  console.log('正在停止江南入夜专注...');
  try {
    const r = await httpRequest(port, '/api/stop', 'POST', {});
    if (r.status !== 200) {
      console.error(`停止失败（HTTP ${r.status}）`);
      process.exit(1);
    }
    const closed = await waitClosed(port);
    console.log(closed ? '已停止。' : '已发送停止请求；若端口仍未释放，请稍后重试 node start.mjs --status。');
  } catch (e) {
    console.error('停止失败：', e && e.message);
    process.exit(1);
  }
}

async function statusServer(port) {
  const st = await fetchState(port);
  if (!st) {
    if (await probePort(port) === 'occupied') {
      console.log(`端口 ${port} 已被占用，但该服务不是本程序。`);
      process.exit(1);
    }
    console.log('江南入夜专注 · 没有在运行。');
    return;
  }
  console.log('江南入夜专注 · 正在运行');
  console.log(`  地址：http://127.0.0.1:${port}/`);
  console.log(`  今天 token：${st.today.tokens}`);
  console.log(`  会话：${st.sessions.length} 个`);
  printStatusBySource(st);
  if (st.today.logsMissing) {
    const names = (Array.isArray(st.today.logsMissingSources) ? st.today.logsMissingSources : [])
      .map((id) => SOURCE_LABELS[id] || id).join('、');
    console.log(`  提示：今天的日志当前不可用（受影响来源：${names || '未知'}），水牌来自上次保存的快照。`);
  }
}

async function start(port, noOpen) {
  const url = `http://127.0.0.1:${port}/`;
  if (await fetchState(port)) {
    console.log('江南入夜专注 · 已经在运行，直接打开网页。');
    console.log('Jiangnan Focus · already running, opening the page.');
    if (!noOpen) openBrowser(url);
    return;
  }
  if (await probePort(port) === 'occupied') {
    console.error(`端口 ${port} 已被占用，但该服务不是本程序（或版本不匹配）。`);
    console.error('请设置 JN_PORT 换一个端口，或先停止占用者再重试。');
    process.exit(1);
  }
  const skipDsh = shouldSkipDsh();
  const env = { ...process.env };
  if (skipDsh) {
    env.JN_DSH_DIR = '';
    console.log('当前 Node 版本过低或缺少 zlib.zstdDecompressSync，已跳过 DeepSeek Harness 来源。');
    console.log('Node too old or zstd unavailable, DeepSeek Harness source skipped.');
  }
  const cfg = loadConfig(env);
  console.log('江南入夜专注 · 启动中，稍后自动打开网页。');
  console.log('Jiangnan Focus · starting, the page will open shortly.');

  const errBuf = { text: '' };
  const child = spawn(process.execPath, [FOCUSD], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    errBuf.text = (errBuf.text + c).slice(-8192);
    process.stderr.write(c);
  });
  child.on('error', (e) => {
    console.error('无法启动 focusd：', e && e.message);
    process.exit(1);
  });
  child.unref(); // 让本启动器退出，focusd 继续在后台运行
  if (child.stderr && typeof child.stderr.unref === 'function') child.stderr.unref();
  console.log(`focusd 进程 PID ${child.pid}；停止请运行 node start.mjs --stop`);

  await waitReady(port, child, errBuf);
  const st = await fetchState(port);
  if (st) {
    printSources(cfg, st);
    if (st.sessions.length === 0 && st.today.tokens === 0) printZeroGuide(port);
  }
  if (!noOpen) openBrowser(url);
  // 本进程到此退出，focusd 独立在后台运行
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const stopFlag = argv.includes('--stop');
  const statusFlag = argv.includes('--status');
  const noOpen = argv.includes('--no-open');
  const port = readPort();
  const run = stopFlag ? stopServer(port)
    : statusFlag ? statusServer(port)
    : start(port, noOpen);
  run.catch((e) => {
    console.error('启动失败：', e && e.message);
    process.exit(1);
  });
}
