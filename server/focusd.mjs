#!/usr/bin/env node
// 江南入夜 · 专注挂机小游戏的本地小程序。
// 只读 Claude Code、Codex、DeepSeek Harness、Grok Build、Magpie（含经它的 Cursor CLI）日志里的 token 和工具名，
// 算出专注状态，用 SSE 推给网页，并提供 web/ 静态文件。
// 用法：node focusd.mjs    （端口 JN_PORT，默认 4317；只监听 127.0.0.1）
import fs from 'node:fs';
import { loadConfig } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { Engine } from './lib/engine.mjs';
import { LogWatcher } from './lib/logwatch.mjs';
import { ExtraSources } from './lib/extsources.mjs';
import { IdleSampler } from './lib/idle.mjs';
import { createApp } from './lib/http.mjs';

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a);

function printZeroGuide(port, cfg) {
  log('今天还没有读到任何 AI 使用记录。这是正常的：');
  log('  - 本程序只统计今天改动过的本地日志，不联网、不会自己产生记录。');
  log('  - 支持的来源：Claude Code、Codex、DeepSeek Harness、Grok Build、Magpie（含经它的 Cursor CLI）。');
  for (const src of cfg.sources) {
    const p = src.paths[0] || '';
    if (p) log(`    ${src.label}：${p}`);
  }
  log('  - 先看 60 秒演示效果，打开 http://127.0.0.1:' + port + '/?demo=1');
  log('  - 确认某个来源今天有日志后，刷新页面即可看到船、灯和水牌。');
}

// 先确认端口没被占用，避免第二个实例在启动失败前覆盖存档
async function assertPortFree(port, host) {
  const net = await import('node:net');
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`端口 ${port} 已被占用：focusd 可能已经在运行`) : e));
    s.listen(port, host, () => s.close(resolve));
  });
}

async function main() {
  const cfg = loadConfig();
  await assertPortFree(cfg.port, cfg.host);
  const store = new Store(cfg.dataDir);
  const t0 = Date.now();
  const engine = new Engine({ saved: store.load(), store, now: t0 });
  const watcher = new LogWatcher({
    claudeDir: cfg.claudeDir,
    codexDir: cfg.codexDir,
    onEvents: (evs) => engine.ingest(evs, Date.now()),
  });
  const extra = new ExtraSources({
    dshDir: cfg.dshDir,
    grokDir: cfg.grokDir,
    magpieFile: cfg.magpieFile,
    onEvents: (evs) => engine.ingest(evs, Date.now()),
    isClaudeSession: (id) => watcher.hasClaudeSession(id) || engine.hasClaudeSession(id),
  });

  // 启动：回放今天的记录
  const idleSampler = new IdleSampler();
  const idleP = idleSampler.get(t0);
  await watcher.init(t0); // Claude 先读完，Magpie 去重才认得出 Claude 会话
  await extra.init(t0);
  const idle = await idleP;
  engine.setIdle(idle, Date.now());
  engine.restoreTodayIfMissing(Date.now());
  engine.tick(Date.now());
  engine.markLive();
  extra.markLive();
  engine.save(Date.now());
  const st0 = engine.getState(Date.now());
  log(`回放完成 ${Date.now() - t0}ms：文件 ${watcher.stats.filesKnown} 个（读了 ${watcher.stats.filesRead} 个，${(watcher.stats.bytesRead / 1e6).toFixed(1)}MB），会话 ${st0.sessions.length} 个，今天 token ${st0.today.tokens}；其他来源文件 ${extra.stats.filesKnown} 个（读了 ${(extra.stats.bytesRead / 1e6).toFixed(1)}MB）`);
  log('检测到的来源：');
  for (const src of cfg.sources) {
    const p = src.paths[0] || '';
    const exists = p ? fs.existsSync(p) : false;
    const tokens = (st0.today.bySource && st0.today.bySource[src.id] && st0.today.bySource[src.id].tokens) || 0;
    log(`  ${src.label}：${p ? `${exists ? '存在' : '不存在'} ${p}` : '已停用'}，今天 token ${tokens}`);
  }

  let stopFn = null;
  const app = createApp({ engine, webDir: cfg.webDir, log, onStop: () => { if (stopFn) stopFn('HTTP /api/stop'); } });
  const port = await app.listen(cfg.port, cfg.host);
  log(`已启动 http://127.0.0.1:${port}/`);
  if (st0.sessions.length === 0 && st0.today.tokens === 0) printZeroGuide(port, cfg);

  let stopping = false;
  let n = 0;
  let timer = null;
  // JN_DEBUG=1 时每分钟打印一次各环节耗时（只有数字）
  const debug = !!process.env.JN_DEBUG;
  const perf = { scan: 0, scans: 0, poll: 0, polls: 0, rest: 0, bytes0: watcher.stats.bytesRead, cpu0: process.cpuUsage() };
  async function loop() {
    if (stopping) return;
    const started = Date.now();
    try {
      n += 1;
      const idleP = idleSampler.get(Date.now());
      const a = performance.now();
      if (n % cfg.rescanEvery === 0) {
        await watcher.fullScan(Date.now());
        await extra.fullScan(Date.now());
        perf.scan += performance.now() - a; perf.scans += 1;
      } else {
        await watcher.pollHot(Date.now());
        await extra.poll(Date.now());
        perf.poll += performance.now() - a; perf.polls += 1;
      }
      engine.setIdle(await idleP, Date.now());
      const b = performance.now();
      const now = Date.now();
      engine.tick(now);
      engine.flushBeats();
      app.broadcastState();
      perf.rest += performance.now() - b;
      if (debug && n % 30 === 0) {
        const cpu = process.cpuUsage(perf.cpu0);
        log(`[debug] 60 秒：全量扫 ${(perf.scan / Math.max(1, perf.scans)).toFixed(1)}ms/次，热文件轮询 ${(perf.poll / Math.max(1, perf.polls)).toFixed(1)}ms/次，状态推送 ${(perf.rest / 30).toFixed(1)}ms/次，新读 ${((watcher.stats.bytesRead - perf.bytes0) / 1e3).toFixed(0)}KB，进程 CPU ${((cpu.user + cpu.system) / 1e3).toFixed(0)}ms，SSE 连接 ${app.clients.size}，ioreg 累计 ${idleSampler.spawns} 次，内存 rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB 去重键 ${engine.seen.size}`);
        Object.assign(perf, { scan: 0, scans: 0, poll: 0, polls: 0, rest: 0, bytes0: watcher.stats.bytesRead, cpu0: process.cpuUsage() });
      }
    } catch (e) {
      log('轮询出错', e && e.message);
    }
    if (!stopping) timer = setTimeout(loop, Math.max(200, cfg.pollMs - (Date.now() - started)));
  }
  timer = setTimeout(loop, cfg.pollMs);

  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    log(`收到 ${sig}，保存并退出`);
    try { engine.save(Date.now()); } catch (e) { log('保存失败', e && e.message); }
    try { await idleSampler.close(); } catch (e) { log('释放空闲检测子进程失败', e && e.message); }
    await app.close();
    process.exit(0);
  };
  stopFn = stop;
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((e) => {
  console.error('启动失败：', e && e.message);
  process.exit(1);
});
