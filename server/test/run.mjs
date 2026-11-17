// 一次跑完所有测试：node test/run.mjs
// 全部用临时目录和 fixtures，不碰真实的 ~/.claude、~/.codex、~/.jiangnan-focus。
process.env.TZ = 'America/Los_Angeles';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Engine, GRACE_MS, SERVICE_NAME } from '../lib/engine.mjs';
import { LogWatcher } from '../lib/logwatch.mjs';
import { FocusMachine } from '../lib/focus.mjs';
import { Rewards, RewardError } from '../lib/rewards.mjs';
import { Store } from '../lib/store.mjs';
import { mergeSettings, sanitizeSettings, DEFAULT_SETTINGS, REWARD_POOL, assertSafeDataDir, loadConfig, magpieCandidates, existingFile, sourceEntries } from '../lib/config.mjs';
import { parseIdleSeconds, parseXprintidleMs, parseGdbusIdleMs, sampleIdleLinux, resetIdleLinuxBackend, IdleSampler } from '../lib/idle.mjs';
import { parseCodexLine } from '../lib/parsers.mjs';
import { createApp } from '../lib/http.mjs';
import { startOfDay, dayKey } from '../lib/localday.mjs';
import { ExtraSources, zstdFrameEnd } from '../lib/extsources.mjs';
import { shouldSkipDsh, isValidState, openBrowser } from '../../start.mjs';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const SID = 'claude:11111111-aaaa-4aaa-8aaa-000000000001';
const CODEX_SID = 'codex:019a0000-1111-7000-8000-00000000c0de';
const MIN = 60000;
const T = (h, m = 0, s = 0, d = 17) => new Date(2026, 10, d, h, m, s).getTime(); // 本地时间

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jn-test-'));
let tmpN = 0;
const tmpDir = () => {
  const d = path.join(tmpRoot, String(++tmpN));
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// DeepSeek Harness 的会话文件：一串独立的 zstd 帧，每帧解压后是若干以换行结尾的 JSON 行
const DSH_ID = 'd5d5d5d5-0000-4000-8000-000000000001';
const dshLine = (o) => JSON.stringify(o) + '\n';
const dshFrame = (...objs) => zlib.zstdCompressSync(Buffer.from(objs.map(dshLine).join('')));
const DSH_T = Date.parse('2026-11-17T18:00:00.000Z');
const DSH_F1 = () => dshFrame(
  { type: 'session', version: 4, id: DSH_ID, createdAt: DSH_T, cwd: '/home/demo/深度项目', isSeeded: false, delegationDepth: 0, agentPreset: 'x' },
  { type: 'permission/preset', seq: 1, time: DSH_T, data: { preset: 'SECRET_DSH_PRESET' } },
);
const DSH_F2 = () => dshFrame(
  { type: 'user/message', seq: 4, time: DSH_T + 1000, data: { text: 'SECRET_DSH_USER "type":"assistant/message"' } },
  { type: 'assistant/message', seq: 5, time: DSH_T + 5000, data: { turn: 1, step: 1, message: { text: 'SECRET_DSH_TEXT', source: { kind: 'llm', provider: 'deepseek', model: 'deepseek-flash' } }, usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 3000, cacheWriteTokens: 60, totalTokens: 3600 } } },
  { type: 'tool/call', seq: 6, time: DSH_T + 6000, data: { turn: 1, step: 1, callId: 'k1', name: 'bash', arguments: 'SECRET_DSH_ARGS' } },
  { type: 'tool/call', seq: 7, time: DSH_T + 7000, data: { turn: 1, step: 1, callId: 'k2', name: 'edit_file', arguments: 'SECRET_DSH_ARGS' } },
);
const DSH_F3 = () => dshFrame(
  { type: 'assistant/message', seq: 9, time: DSH_T + 60000, data: { message: { text: 'SECRET' }, usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 } } },
);
const GROK_G1 = '0a0a0a0a-0000-4000-8000-000000000001';

function copyFixtures() {
  const d = tmpDir();
  fs.cpSync(FIX, d, { recursive: true });
  const dshDir = path.join(d, 'dsh');
  const sdir = path.join(dshDir, '--Users-demo-~6DF1~5EA6~9879~76EE--', `session-${DSH_ID}`);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'session.v4.jsonl.zstd'), Buffer.concat([DSH_F1(), DSH_F2()]));
  fs.writeFileSync(path.join(sdir, 'session.lock'), '');
  const grokDir = path.join(d, 'grok');
  fs.mkdirSync(path.join(grokDir, 'sessions', encodeURIComponent('/home/demo/好项目'), GROK_G1), { recursive: true });
  return {
    claudeDir: path.join(d, 'claude'), codexDir: path.join(d, 'codex'), root: d,
    dshDir, dshFile: path.join(sdir, 'session.v4.jsonl.zstd'), grokDir, grokLog: path.join(grokDir, 'logs', 'unified.jsonl'),
    magpieFile: path.join(d, 'magpie', 'usage.jsonl'),
  };
}

// 六个来源一起读：Claude/Codex 用 LogWatcher，其余用 ExtraSources
async function loadAll(f, { now, live = false, saved = null, store = null } = {}) {
  const clock = { now };
  const engine = new Engine({ saved, store, now });
  const ingest = (evs) => engine.ingest(evs, clock.now);
  const watcher = new LogWatcher({ claudeDir: f.claudeDir, codexDir: f.codexDir, onEvents: ingest });
  const extraClaude = new Set();
  const extra = new ExtraSources({
    dshDir: f.dshDir, grokDir: f.grokDir, magpieFile: f.magpieFile, onEvents: ingest,
    isClaudeSession: (id) => watcher.hasClaudeSession(id) || engine.hasClaudeSession(id) || extraClaude.has(id),
  });
  await watcher.init(now);
  await extra.init(now);
  if (live) { engine.markLive(); extra.markLive(); }
  return { engine, watcher, extra, clock, extraClaude };
}

function treeDigest(dir) {
  const h = crypto.createHash('sha256');
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const st = fs.statSync(f);
        h.update(f + ':' + st.size + ':' + st.mtimeMs + ':');
        h.update(fs.readFileSync(f));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

async function loadEngine({ claudeDir, codexDir, now, saved = null, store = null }) {
  const clock = { now };
  const engine = new Engine({ saved, store, now });
  const watcher = new LogWatcher({ claudeDir, codexDir, onEvents: (evs) => engine.ingest(evs, clock.now) });
  await watcher.init(now);
  return { engine, watcher, clock };
}

const ev = (ts, extra = {}) => ({ kind: 'usage', ts, sid: 'claude:s1', source: 'claude', label: '演示项目', tokens: 100, key: null, ...extra });
const toolEv = (ts, tool, extra = {}) => ({
  kind: 'tool', ts, sid: 'claude:s1', source: 'claude', label: '演示项目', tool,
  isFile: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool), isSubagent: ['Task', 'Agent'].includes(tool), key: null, ...extra,
});

// 从 start 开始，每分钟一个干活事件，持续 n 分钟；每分钟结算一次
function workMinutes(engine, start, n, { present = true, idleOk = true } = {}) {
  for (let i = 0; i < n; i++) {
    const t = start + i * MIN + 1000;
    engine.ingest([ev(t)], t);
    const now = start + (i + 1) * MIN + GRACE_MS;
    engine.setIdle({ ok: idleOk, idleSec: present ? 5 : 900 }, now);
    engine.tick(now);
  }
  return start + n * MIN;
}
function idleMinutes(engine, start, n, { present = true } = {}) {
  for (let i = 0; i < n; i++) {
    const now = start + (i + 1) * MIN + GRACE_MS;
    engine.setIdle({ ok: true, idleSec: present ? 5 : 900 }, now);
    engine.tick(now);
  }
  return start + n * MIN;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------- 日志解析 ----------------
test('Claude：同一 message.id 多行只算一次 token（含子代理、跨天过滤）', async () => {
  const f = copyFixtures();
  const { engine } = await loadEngine({ ...f, now: T(10, 10) });
  const s = engine.getState(T(10, 10));
  const c = s.sessions.find((x) => x.id === SID);
  assert.ok(c, '应有 Claude 会话');
  // msg_A 130 + msg_B 10 + msg_C 5 + 子代理 msg_S 100；昨天的 msg_Y 不算；半行 msg_D 不算
  assert.equal(c.tokens, 245);
  assert.equal(c.label, '演示项目');
  assert.equal(c.startedAt, Date.parse('2026-11-17T18:00:00.000Z'));
});

test('Claude：tool_use 按 id 去重计数，改文件和子代理识别', async () => {
  const f = copyFixtures();
  const { engine } = await loadEngine({ ...f, now: T(10, 10) });
  const c = engine.getState(T(10, 10)).sessions.find((x) => x.id === SID);
  // Edit, Bash, Agent(重复一行只算一次), Write, MultiEdit, NotebookEdit, Task, 子代理里的 Read
  assert.equal(c.tools, 8);
  assert.equal(c.files, 4);
  assert.equal(c.subagents, 2);
});

test('Claude：子代理日志归到父会话，不多出一条船', async () => {
  const f = copyFixtures();
  const { engine } = await loadEngine({ ...f, now: T(10, 10) });
  const claude = engine.getState(T(10, 10)).sessions.filter((x) => x.source === 'claude');
  assert.equal(claude.length, 1);
});

test('半行不解析，写完整后下一次轮询才算，且只算一次', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine, watcher, clock } = await loadEngine({ ...f, now });
  const file = path.join(f.claudeDir, '-Users-demo-proj', '11111111-aaaa-4aaa-8aaa-000000000001.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  const lastNl = text.lastIndexOf('\n');
  const half = text.slice(lastNl + 1);
  assert.ok(half.length > 10 && !half.endsWith('}'), 'fixture 末尾应是半行');
  // 在临时副本里把 fixture 的半行换成一条可控的 msg_D，先写前半行，再写后半行
  fs.truncateSync(file, Buffer.byteLength(text.slice(0, lastNl + 1)));
  const msgD = JSON.stringify({
    type: 'assistant', sessionId: '11111111-aaaa-4aaa-8aaa-000000000001', cwd: '/home/demo/演示项目', isSidechain: false,
    timestamp: '2026-11-17T18:02:30.000Z',
    message: { id: 'msg_D', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_8', name: 'Read', input: {} }], usage: { input_tokens: 700, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 77 } },
  });
  // 先写前半行
  fs.appendFileSync(file, msgD.slice(0, 40));
  clock.now = now + 2000;
  await watcher.fullScan(clock.now);
  let c = engine.getState(clock.now).sessions.find((x) => x.id === SID);
  assert.equal(c.tokens, 245, '半行时不应计数');
  fs.appendFileSync(file, msgD.slice(40) + '\n');
  clock.now = now + 4000;
  await watcher.pollHot(clock.now);
  c = engine.getState(clock.now).sessions.find((x) => x.id === SID);
  assert.equal(c.tokens, 245 + 777);
  assert.equal(c.tools, 9);
  await watcher.pollHot(clock.now + 2000);
  c = engine.getState(clock.now).sessions.find((x) => x.id === SID);
  assert.equal(c.tokens, 245 + 777, '再次轮询不重复计数');
});

test('增量读取：只读新追加的字节', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine, watcher, clock } = await loadEngine({ ...f, now });
  const file = path.join(f.claudeDir, '-Users-demo-proj', '11111111-aaaa-4aaa-8aaa-000000000001', 'subagents', 'agent-a1.jsonl');
  const before = watcher.stats.bytesRead;
  const line = JSON.stringify({ type: 'assistant', sessionId: '11111111-aaaa-4aaa-8aaa-000000000001', cwd: '/home/demo/演示项目', timestamp: '2026-11-17T18:05:00.000Z', message: { id: 'msg_E', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }) + '\n';
  fs.appendFileSync(file, line);
  clock.now = now + 2000;
  await watcher.pollHot(clock.now);
  assert.equal(watcher.stats.bytesRead - before, Buffer.byteLength(line));
  const c = engine.getState(clock.now).sessions.find((x) => x.id === SID);
  assert.equal(c.tokens, 247);
});

test('Codex：token_count 为 null 跳过、重复上报不重复算、apply_patch 算改文件、子代理会话归到根会话', async () => {
  const f = copyFixtures();
  const { engine } = await loadEngine({ ...f, now: T(10, 10) });
  const s = engine.getState(T(10, 10));
  const cx = s.sessions.filter((x) => x.source === 'codex');
  assert.equal(cx.length, 1, '子代理会话不单独出船');
  const c = cx[0];
  assert.equal(c.id, CODEX_SID);
  assert.equal(c.label, '商城前端');
  // 250 + 510（重复的 1050 不算） + 子代理 100
  assert.equal(c.tokens, 860);
  assert.equal(c.tools, 3); // apply_patch, exec, spawn_agent（*_output 不算）
  assert.equal(c.files, 1);
  assert.equal(c.subagents, 1);
  assert.equal(s.today.tokens, 245 + 860);
});

test('Codex 去重：累计总量下降后再次涨回旧值照常计数；重复上报跳过；request_id 作为稳定 key', () => {
  const ctx = { sid: 's1', label: '商城前端', fallbackSid: 'fb', lastCodex: null };
  const line = (cum, input, cached, output, total, rid) => JSON.stringify({
    timestamp: '2026-11-17T18:00:00.000Z', type: 'event_msg',
    payload: { type: 'token_count', request_id: rid, info: {
      total_token_usage: { total_tokens: cum },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: total },
    } },
  });
  const tokens = (l) => parseCodexLine(l, ctx).map((e) => e.tokens);
  // 100 → 90 → 100：第三份真实增量不能丢
  assert.deepEqual(tokens(line(100, 100, 0, 0, 100)), [100]);
  assert.deepEqual(tokens(line(90, 90, 0, 0, 90)), [90]);
  assert.deepEqual(tokens(line(100, 100, 0, 0, 100)), [100]);
  // 同一份重复上报（累计和 last 都没变）跳过
  assert.deepEqual(tokens(line(100, 100, 0, 0, 100)), []);
  const e = parseCodexLine(line(120, 120, 0, 0, 120, 'r1'), { sid: 's1', label: 'x', fallbackSid: 'fb', lastCodex: null })[0];
  assert.equal(e.key, 'xc:r1');
});

test('启动只读今天：昨天没改过的文件不读，之后被续写只读新增部分', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const old = path.join(f.claudeDir, '-Users-demo-proj', 'old-session.jsonl');
  const mk = (id, ts, tokens) => JSON.stringify({ type: 'assistant', sessionId: 'old-1', cwd: '/home/demo/旧项目', timestamp: ts, message: { id, usage: { input_tokens: tokens, output_tokens: 0 }, content: [] } }) + '\n';
  // 文件内容写着今天的时间，但修改时间是昨天：说明启动时根本没读它
  fs.writeFileSync(old, mk('old_a', '2026-11-17T17:00:00.000Z', 5000));
  const y = T(12, 0, 0, 16) / 1000;
  fs.utimesSync(old, y, y);
  const { engine, watcher, clock } = await loadEngine({ ...f, now });
  assert.ok(!engine.getState(now).sessions.find((x) => x.id === 'claude:old-1'));
  fs.appendFileSync(old, mk('old_b', '2026-11-17T18:09:00.000Z', 42));
  clock.now = now + 10000;
  await watcher.fullScan(clock.now);
  const c = engine.getState(clock.now).sessions.find((x) => x.id === 'claude:old-1');
  assert.ok(c, '续写后应出现');
  assert.equal(c.tokens, 42);
  assert.equal(c.label, '旧项目');
});

test('运行中新出现的会话文件：全量扫描时发现并发 session_start', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine, watcher, clock } = await loadEngine({ ...f, now });
  engine.markLive();
  engine.flushBeats();
  const dir = path.join(f.claudeDir, '-Users-demo-new');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '22222222-bbbb-4bbb-8bbb-000000000002.jsonl'), JSON.stringify({
    type: 'assistant', sessionId: '22222222-bbbb-4bbb-8bbb-000000000002', cwd: '/home/demo/新项目', timestamp: new Date(now + 1000).toISOString(),
    message: { id: 'n1', usage: { input_tokens: 3, output_tokens: 4 }, content: [{ type: 'tool_use', id: 'n_t1', name: 'Bash', input: {} }] },
  }) + '\n');
  clock.now = now + 2000;
  await watcher.fullScan(clock.now);
  const beats = engine.flushBeats();
  assert.deepEqual(beats.map((b) => b.kind), ['session_start', 'tool']);
  assert.equal(beats[0].label, '新项目');
  const st = engine.getState(clock.now);
  assert.equal(st.sessions[0].id, 'claude:22222222-bbbb-4bbb-8bbb-000000000002');
  assert.equal(st.sessions[0].active, true);
});

test('大文件二分定位到今天：结果正确且跳过昨天的大部分内容', async () => {
  const d = tmpDir();
  const claudeDir = path.join(d, 'claude');
  fs.mkdirSync(path.join(claudeDir, 'p'), { recursive: true });
  const file = path.join(claudeDir, 'p', 'big.jsonl');
  const fd = fs.openSync(file, 'w');
  const pad = 'x'.repeat(2000);
  let t = T(0, 0, 0, 16);
  let i = 0;
  // 昨天约 8MB
  while (t < T(23, 59, 0, 16)) {
    fs.writeSync(fd, JSON.stringify({ type: 'assistant', sessionId: 'big', cwd: '/p/大', timestamp: new Date(t).toISOString(), message: { id: 'y' + i++, usage: { input_tokens: 1, output_tokens: 0 }, content: [{ type: 'text', text: pad }] } }) + '\n');
    t += 20000;
  }
  for (let k = 0; k < 30; k++) {
    fs.writeSync(fd, JSON.stringify({ type: 'assistant', sessionId: 'big', cwd: '/p/大', timestamp: new Date(T(9, k)).toISOString(), message: { id: 't' + k, usage: { input_tokens: 10, output_tokens: 0 }, content: [] } }) + '\n');
  }
  fs.closeSync(fd);
  const size = fs.statSync(file).size;
  assert.ok(size > 6 << 20);
  const { engine, watcher } = await loadEngine({ claudeDir, codexDir: path.join(d, 'none'), now: T(10, 0) });
  assert.equal(engine.getState(T(10, 0)).today.tokens, 300);
  assert.ok(watcher.stats.bytesRead < size / 3, `应跳过大部分：读了 ${watcher.stats.bytesRead} / ${size}`);
});

test('日志目录只读：跑完解析后 fixtures 原样未动', async () => {
  const before = treeDigest(FIX);
  const { engine, watcher } = await loadEngine({ claudeDir: path.join(FIX, 'claude'), codexDir: path.join(FIX, 'codex'), now: T(10, 10) });
  await watcher.pollHot(T(10, 11));
  await watcher.fullScan(T(10, 12));
  engine.tick(T(10, 12));
  assert.equal(treeDigest(FIX), before);
});

test('日志监视：全量扫描会清掉已删除的文件记录和无效目录缓存', async () => {
  const d = tmpDir();
  const claudeDir = path.join(d, 'claude');
  const sub = path.join(claudeDir, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(sub, `s${i}.jsonl`), '');
  const now = T(10, 0);
  const w = new LogWatcher({ claudeDir, codexDir: path.join(d, 'none'), onEvents: () => {} });
  await w.init(now);
  assert.equal(w.files.size, 100);
  fs.rmSync(sub, { recursive: true, force: true });
  await w.fullScan(now + 10000);
  assert.equal(w.files.size, 0);
  assert.equal(w.stats.filesKnown, 0);
  assert.equal(w.dirCache.has(sub), false);
});

test('日志监视：删除 Claude 会话文件后，会话索引同步清理，不再被当作 Claude 会话', async () => {
  const d = tmpDir();
  const claudeDir = path.join(d, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'old.jsonl');
  fs.writeFileSync(file, '');
  const now = T(10, 0);
  const w = new LogWatcher({ claudeDir, codexDir: path.join(d, 'none'), onEvents: () => {} });
  await w.init(now);
  assert.equal(w.hasClaudeSession('old'), true);
  fs.rmSync(file, { force: true });
  await w.fullScan(now + 10000);
  assert.equal(w.claudeIds.size, 0);
  assert.equal(w.hasClaudeSession('old'), false, '已删除的 Claude 会话不应继续留在索引里');
});

test('Grok：会话目录删除后重建索引会清掉旧 sid 的项目名', async () => {
  const d = tmpDir();
  const grokDir = path.join(d, 'grok');
  const sid = 'sid-old';
  const enc = encodeURIComponent('/home/demo/旧项目');
  const sdir = path.join(grokDir, 'sessions', enc, sid);
  fs.mkdirSync(sdir, { recursive: true });
  const grokLog = path.join(grokDir, 'logs', 'unified.jsonl');
  fs.mkdirSync(path.join(grokDir, 'logs'), { recursive: true });
  fs.writeFileSync(grokLog, '');
  const extra = new ExtraSources({ dshDir: null, grokDir, magpieFile: null, onEvents: () => {} });
  assert.equal(extra._grokLabel(sid), '旧项目');
  fs.rmSync(sdir, { recursive: true, force: true });
  extra.grokIndexAt = 0; // 强制下一轮重建索引
  assert.equal(extra._grokLabel(sid), 'Grok', '删除会话目录后不应返回旧的项目名');
});

test('扩展来源：全量扫描会清掉已删除的单文件记录和无效 DSH 目录缓存', async () => {
  const d = tmpDir();
  const grokDir = path.join(d, 'grok');
  const magpieFile = path.join(d, 'magpie.jsonl');
  const dshDir = path.join(d, 'dsh');
  fs.mkdirSync(path.join(grokDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dshDir, 'a', 'session-x'), { recursive: true });
  const grokLog = path.join(grokDir, 'logs', 'unified.jsonl');
  fs.writeFileSync(grokLog, '');
  fs.writeFileSync(magpieFile, '');
  fs.writeFileSync(path.join(dshDir, 'a', 'session-x', 'session.v4.jsonl.zstd'), '');
  const now = T(10, 0);
  const extra = new ExtraSources({ dshDir, grokDir, magpieFile, onEvents: () => {} });
  await extra.init(now);
  assert.equal(extra.files.size, 3);
  fs.rmSync(grokDir, { recursive: true, force: true });
  fs.rmSync(magpieFile, { force: true });
  fs.rmSync(dshDir, { recursive: true, force: true });
  await extra.fullScan(now + 10000);
  assert.equal(extra.files.size, 0);
  assert.equal(extra.stats.filesKnown, 0);
  assert.equal(extra.dirCache.has(dshDir), false);
});

test('隐私：state 和 beat 里没有对话正文、代码、命令、文件内容', async () => {
  const f = copyFixtures();
  const now = Date.parse('2026-11-17T18:03:30.000Z');
  const engine = new Engine({ now });
  engine.markLive();
  const beats = [];
  engine.on('beat', (b) => beats.push(b));
  const watcher = new LogWatcher({ ...f, onEvents: (evs) => engine.ingest(evs, now) });
  await watcher.init(now);
  engine.tick(now);
  engine.flushBeats();
  const out = JSON.stringify(engine.getState(now)) + JSON.stringify(beats);
  assert.ok(beats.length > 0);
  assert.ok(!out.includes('SECRET'), '输出里出现了原文');
  assert.ok(!out.includes('/home/demo'), '输出里出现了完整路径');
});

// ---------------- 专注状态机 ----------------
test('专注满 25 分钟：segments+1、pendingRewards+1、发 segment_done，段清零', () => {
  const t0 = T(9, 0);
  const e = new Engine({ now: t0 });
  e.tick(t0); // 把零点到 9 点的空白分钟走完
  e.markLive();
  const beats = [];
  e.on('beat', (b) => beats.push(b));
  let t = t0;
  for (let i = 0; i < 24; i++) {
    t = workMinutes(e, t, 1);
    e.flushBeats();
  }
  let s = e.getState(t + GRACE_MS);
  assert.equal(s.today.segments, 0);
  assert.equal(e.focus.segment.progress, 24);
  t = workMinutes(e, t, 1);
  e.flushBeats();
  s = e.getState(t + GRACE_MS);
  assert.equal(s.today.segments, 1);
  assert.equal(s.pendingRewards, 1);
  assert.equal(e.focus.segment.progress, 0);
  assert.equal(beats.filter((b) => b.kind === 'segment_done').length, 1);
  assert.equal(s.today.presentFocusMin, 25);
  assert.equal(s.today.aiMinutes, 25);
});

test('停顿超过 5 分钟这一段清零；停顿 5 分钟以内接着算', () => {
  const t0 = T(9, 0);
  const e = new Engine({ now: t0 });
  e.tick(t0);
  // 干 10 分钟；最后一个事件之后还有 activeMin(3) 分钟窗口带来的 2 分钟尾巴
  let t = workMinutes(e, t0, 10);
  assert.equal(e.focus.segment.progress, 10);
  t = idleMinutes(e, t, 2);
  assert.equal(e.focus.segment.progress, 12);
  t = idleMinutes(e, t, 5); // 停顿 5 分钟：不超过 gapMin，这一段还在
  assert.equal(e.focus.segment.progress, 12);
  assert.equal(e.focus.segment.idle, 5);
  assert.equal(e.focus.segment.running, true);
  t = workMinutes(e, t, 1); // 接着算
  assert.equal(e.focus.segment.progress, 13);
  assert.equal(e.focus.segment.idle, 0);
  t = idleMinutes(e, t, 2);
  assert.equal(e.focus.segment.progress, 15);
  t = idleMinutes(e, t, 6); // 停 6 分钟 > 5：清零
  assert.equal(e.focus.segment.progress, 0);
  assert.equal(e.focus.segment.running, false);
  assert.equal(e.getState(t + GRACE_MS).today.segments, 0);
});

test('presentOnly：人不在场不累计，回来才累计；在场/独航分开记', () => {
  const t0 = T(9, 0);
  const e = new Engine({ now: t0 });
  e.tick(t0);
  let t = workMinutes(e, t0, 10, { present: false });
  let s = e.getState(t + GRACE_MS);
  assert.equal(s.today.soloFocusMin, 10, '开关关闭时 AI 独航也算');
  assert.equal(s.today.presentFocusMin, 0);
  assert.equal(e.updateSettings({ presentOnly: true }).settings.presentOnly, true);
  const p0 = e.focus.segment.progress;
  t = workMinutes(e, t, 5, { present: false });
  s = e.getState(t + GRACE_MS);
  assert.equal(e.focus.segment.progress, p0, '不在场时不累计');
  assert.equal(s.today.aiMinutes, 15, 'AI 干活分钟照记');
  assert.equal(s.focusing, false);
  t = workMinutes(e, t, 3, { present: true });
  s = e.getState(t + GRACE_MS);
  assert.equal(s.today.presentFocusMin, 3);
  assert.equal(s.today.soloFocusMin, 10);
  assert.equal(s.present, true);
});

test('ioreg 读不到：当作人在场并标 presentUnknown', () => {
  const t0 = T(9, 0);
  const e = new Engine({ now: t0 });
  e.tick(t0);
  e.updateSettings({ presentOnly: true });
  const t = workMinutes(e, t0, 3, { idleOk: false });
  const s = e.getState(t + GRACE_MS);
  assert.equal(s.presentUnknown, true);
  assert.equal(s.present, true);
  assert.equal(s.today.presentFocusMin, 3);
});

test('过本地零点：today 归零，owned、pendingRewards、灯笼等级不归零', () => {
  const t0 = T(23, 50);
  const e = new Engine({ now: t0, saved: { owned: ['koi'], pendingRewards: 2, lanternLevel: 1 } });
  e.tick(t0);
  let t = workMinutes(e, t0, 8);
  const before = e.getState(t);
  assert.equal(before.today.day, '2026-11-17');
  assert.equal(before.today.aiMinutes, 8);
  assert.ok(before.today.tokens >= 800);
  t = workMinutes(e, t, 4); // 跨过零点
  const s = e.getState(t + GRACE_MS);
  assert.equal(s.today.day, '2026-11-18');
  assert.equal(s.today.aiMinutes, 2);
  assert.equal(s.today.tokens, 200, '新的一天 token 从 0 开始');
  assert.deepEqual(s.owned, ['koi']);
  assert.equal(s.pendingRewards, 2);
  assert.equal(s.lanternLevel, 1);
  assert.equal(e.focus.segment.progress, 12, '专注段跨零点不清零');
});

test('会话 3 分钟内有动静算在干活，10 分钟没动静结束并发 session_end', () => {
  const t0 = T(9, 0);
  const e = new Engine({ now: t0 });
  e.tick(t0);
  e.markLive();
  e.ingest([toolEv(t0 + 1000, 'Bash')], t0 + 2000);
  let b = e.flushBeats();
  assert.deepEqual(b.map((x) => x.kind), ['session_start', 'tool']);
  e.tick(t0 + 4 * MIN);
  let s = e.getState(t0 + 4 * MIN);
  assert.equal(s.sessions[0].active, false);
  assert.equal(s.sessions[0].ended, false);
  e.tick(t0 + 11 * MIN);
  b = e.flushBeats();
  assert.deepEqual(b.map((x) => x.kind), ['session_end']);
  s = e.getState(t0 + 11 * MIN);
  assert.equal(s.sessions[0].ended, true);
  // 结束 1 小时后不再返回
  e.tick(t0 + 72 * MIN);
  assert.equal(e.getState(t0 + 72 * MIN).sessions.length, 0);
  // 又动了：重新开船
  e.ingest([toolEv(t0 + 73 * MIN, 'Read')], t0 + 73 * MIN + 500);
  b = e.flushBeats();
  assert.deepEqual(b.map((x) => x.kind), ['session_start', 'tool']);
  assert.equal(e.getState(t0 + 73 * MIN + 500).sessions[0].startedAt, t0 + 73 * MIN);
});

test('beat 合并：同会话 1 秒内同名工具合成一条 count，改文件和子代理另发', () => {
  const t0 = T(9, 0);
  const e = new Engine({ now: t0 });
  e.markLive();
  const now = t0 + 5000;
  e.ingest([
    toolEv(t0, 'Bash'), toolEv(t0 + 300, 'Bash'), toolEv(t0 + 900, 'Bash'), toolEv(t0 + 1500, 'Bash'),
    toolEv(t0 + 400, 'Edit'), toolEv(t0 + 450, 'Agent'),
    toolEv(t0 + 500, 'Bash', { sid: 'claude:s2' }),
  ], now);
  const b = e.flushBeats();
  const summary = b.map((x) => `${x.kind}:${x.session}:${x.tool}:${x.count}`);
  assert.deepEqual(summary, [
    'session_start:claude:s1:null:1',
    'tool:claude:s1:Bash:3',
    'tool:claude:s1:Edit:1',
    'file:claude:s1:Edit:1',
    'tool:claude:s1:Agent:1',
    'subagent:claude:s1:Agent:1',
    'session_start:claude:s2:null:1',
    'tool:claude:s2:Bash:1',
    'tool:claude:s1:Bash:1',
  ]);
  // 启动回放（非 live）和 2 分钟前的旧事件不发 beat
  const e2 = new Engine({ now });
  e2.ingest([toolEv(t0, 'Bash')], now);
  e2.markLive();
  e2.ingest([toolEv(t0 + 100, 'Read')], t0 + 10 * MIN);
  assert.equal(e2.flushBeats().length, 0);
});

test('state 带 rev（单调递增）和 boot（同一次启动不变）', () => {
  const now = Date.UTC(2026, 10, 17, 18, 0, 0);
  const e = new Engine({ now });
  const a = e.getState(now), b = e.getState(now + 1000), c = e.getState(now + 2000);
  assert.ok(Number.isInteger(a.rev) && a.rev >= 1);
  assert.ok(b.rev > a.rev && c.rev > b.rev);
  assert.equal(typeof a.boot, 'string');
  assert.ok(a.boot.length >= 6);
  assert.equal(a.boot, c.boot);
  const e2 = new Engine({ now: now + 5 });
  assert.notEqual(e2.getState(now + 5).boot, a.boot);
});

test('state 带 service 标识，供启动器强识别；冒名对象不被认作本程序', () => {
  const e = new Engine({ now: T(10, 0) });
  const s = e.getState(T(10, 0));
  assert.equal(s.service, SERVICE_NAME);
  assert.equal(isValidState(s), true);
  assert.equal(isValidState({ boot: 'x', today: { bySource: {} } }), false);
  assert.equal(isValidState({ service: SERVICE_NAME, boot: '', rev: 1, sessions: [], today: { tokens: 0, bySource: {} } }), false);
});

test('FocusMachine 可单独使用（注入分钟，不依赖真实时钟）', () => {
  const fm = new FocusMachine(null, T(0, 0));
  const st = { ...DEFAULT_SETTINGS, segmentMin: 3 };
  let done = 0;
  for (let i = 1; i <= 7; i++) if (fm.step(T(0, i), { aiActive: true, present: false }, st).segmentDone) done++;
  assert.equal(done, 2);
  assert.equal(fm.today.soloFocusMin, 7);
  assert.equal(fm.segment.progress, 1);
});

// ---------------- 奖励 ----------------
test('奖励：同一个待领奖励重复请求返回同一组；不在组里的 id 拒绝；选中后进 owned', () => {
  const r = new Rewards({ pendingRewards: 2 }, (n) => 0);
  const a = r.offer();
  const b = r.offer();
  assert.equal(a.length, 3);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((x) => x.id), ['teahouse', 'pagoda', 'pavilion']);
  assert.throws(() => r.choose('snow'), RewardError);
  const res = r.choose('pagoda');
  assert.deepEqual(res.owned, ['pagoda']);
  assert.equal(r.pending, 1);
  const c = r.offer();
  assert.ok(!c.some((x) => x.id === 'pagoda'), '已拥有的不再抽到');
  r.choose(c[0].id);
  assert.deepEqual(r.offer(), [], '没有待领时返回空数组');
  assert.throws(() => r.choose('teahouse'), (e) => e.code === 'no_pending');
});

test('奖励：不足 3 个全给；全部集齐后只给 lantern_plus，选中后 lanternLevel+1', () => {
  const ids = REWARD_POOL.map((x) => x.id);
  const r = new Rewards({ owned: ids.slice(0, ids.length - 2), pendingRewards: 3 });
  assert.equal(r.offer().length, 2);
  r.choose(ids[ids.length - 1]);
  r.choose(r.offer()[0].id);
  assert.deepEqual(r.offer(), [{ id: 'lantern_plus', category: 'lantern' }]);
  const res = r.choose('lantern_plus');
  assert.equal(res.lanternLevel, 1);
  assert.equal(res.pendingRewards, 0);
  assert.equal(r.owned.length, ids.length);
});

// ---------------- 设置、存档 ----------------
test('设置：合并保存并做范围校验', () => {
  let r = mergeSettings(DEFAULT_SETTINGS, { volume: 0.5, muted: true, unknown: 1 });
  assert.equal(r.settings.volume, 0.5);
  assert.equal(r.settings.muted, true);
  assert.ok(!('unknown' in r.settings));
  assert.equal(r.settings.segmentMin, 25);
  r = mergeSettings(DEFAULT_SETTINGS, { volume: 1.5 });
  assert.ok(r.errors);
  r = mergeSettings(DEFAULT_SETTINGS, { activeMin: '3' });
  assert.ok(r.errors);
  r = mergeSettings(DEFAULT_SETTINGS, { presentOnly: 'yes' });
  assert.ok(r.errors);
  r = mergeSettings(DEFAULT_SETTINGS, [1]);
  assert.ok(r.errors);
});

test('设置：反馈方式 feedbackStyle 默认 lantern，只认 lantern/muyu/both，存档坏值回落默认', () => {
  assert.equal(DEFAULT_SETTINGS.feedbackStyle, 'lantern');
  for (const v of ['lantern', 'muyu', 'both']) assert.equal(mergeSettings(DEFAULT_SETTINGS, { feedbackStyle: v }).settings.feedbackStyle, v);
  for (const v of ['Muyu', '', 'fish', 1, null, true]) assert.ok(mergeSettings(DEFAULT_SETTINGS, { feedbackStyle: v }).errors, String(v));
  assert.equal(sanitizeSettings({ feedbackStyle: 'both' }).feedbackStyle, 'both');
  assert.equal(sanitizeSettings({ feedbackStyle: 'x' }).feedbackStyle, 'lantern');
  assert.ok(mergeSettings(DEFAULT_SETTINGS, { feedbackStyle: 'muyu', lanternUnit: 3 }).errors); // 一项不合法整次不合并
});

test('设置：孔明灯单位 lanternUnit 默认 1000，只认 500/1000/2000/5000，存档里坏值回落默认', () => {
  assert.equal(DEFAULT_SETTINGS.lanternUnit, 1000);
  for (const v of [500, 1000, 2000, 5000]) assert.equal(mergeSettings(DEFAULT_SETTINGS, { lanternUnit: v }).settings.lanternUnit, v);
  for (const v of [0, 999, 100000, '1000', null, 1000.5]) assert.ok(mergeSettings(DEFAULT_SETTINGS, { lanternUnit: v }).errors, String(v));
  assert.equal(sanitizeSettings({ lanternUnit: 2000 }).lanternUnit, 2000);
  assert.equal(sanitizeSettings({ lanternUnit: 7 }).lanternUnit, 1000);
  assert.equal(sanitizeSettings({}).lanternUnit, 1000);
});

test('存档：重启后当天统计、专注段、奖励都在，不会重复计数', async () => {
  const f = copyFixtures();
  const home = tmpDir();
  const store = new Store(home);
  const now = T(10, 30);
  const a = await loadEngine({ ...f, now, store });
  a.engine.tick(now);
  a.engine.rewards.grant(1);
  a.engine.offerRewards(now);
  a.engine.updateSettings({ volume: 0.7 }, now);
  const s1 = a.engine.getState(now);
  assert.ok(s1.today.aiMinutes > 0);
  const offer1 = a.engine.offerRewards(now);
  // 重启
  const b = await loadEngine({ ...f, now: now + 5000, saved: store.load(), store });
  b.engine.tick(now + 5000);
  const s2 = b.engine.getState(now + 5000);
  assert.deepEqual(s2.today, s1.today);
  assert.equal(s2.settings.volume, 0.7);
  assert.equal(s2.pendingRewards, 1);
  assert.deepEqual(b.engine.offerRewards(now + 5000), offer1, '刷新/重启后还是同一组');
  // 存档目录之外什么都没写
  assert.deepEqual(fs.readdirSync(home), ['save.json']);
});

test('存档：今天日志消失后重启，用保存的快照恢复水牌和船，不出现旧专注+新零值', async () => {
  const f = copyFixtures();
  const home = tmpDir();
  const store = new Store(home);
  const now = T(10, 30);
  const a = await loadEngine({ ...f, now, store });
  assert.equal(a.engine.restoreTodayIfMissing(now), false, '有日志时不用快照');
  assert.equal(a.engine.getState(now).today.logsMissing, false);
  a.engine.tick(now);
  const s1 = a.engine.getState(now);
  assert.ok(s1.today.tokens > 0);
  assert.ok(s1.sessions.length > 0);
  // 同一个 JN_HOME，但日志目录变成空的
  const empty = tmpDir();
  const b = await loadEngine({ claudeDir: empty, codexDir: empty, now: now + 5000, saved: store.load(), store });
  assert.equal(b.engine.restoreTodayIfMissing(now + 5000), true);
  const s2 = b.engine.getState(now + 5000);
  assert.equal(s2.today.tokens, s1.today.tokens);
  assert.deepEqual(s2.today.bySource, s1.today.bySource);
  assert.ok(s2.sessions.length > 0);
  assert.equal(s2.today.logsMissing, true);
  assert.equal(s2.today.aiMinutes, s1.today.aiMinutes);
});

test('存档：部分来源日志缺失时只恢复缺失来源，并标出受影响来源', () => {
  const now = T(10, 0);
  const mkBy = (claude, codex) => ({
    claude: { tokens: claude, tools: 1, sids: ['claude:a'] },
    codex: { tokens: codex, tools: 2, sids: ['codex:b'] },
    deepseek: { tokens: 0, tools: 0, sids: [] },
    grok: { tokens: 0, tools: 0, sids: [] },
    magpie: { tokens: 0, tools: 0, sids: [] },
    cursor: { tokens: 0, tools: 0, sids: [] },
  });
  const snap = {
    day: '2026-11-17', tokens: 300, bySource: mkBy(100, 200),
    sessions: [
      { id: 'claude:a', source: 'claude', label: '甲', startedAt: now - 60000, lastAt: now - 60000, tools: 1, files: 0, subagents: 0, tokens: 100, ended: false, endedAt: 0 },
      { id: 'codex:b', source: 'codex', label: '乙', startedAt: now - 60000, lastAt: now - 60000, tools: 2, files: 0, subagents: 0, tokens: 200, ended: false, endedAt: 0 },
    ],
  };
  const e = new Engine({ saved: { today: snap }, now });
  e.ingest([
    { kind: 'usage', ts: now - 30000, sid: 'claude:a', source: 'claude', label: '甲', tokens: 100 },
    { kind: 'tool', ts: now - 30000, sid: 'claude:a', source: 'claude', label: '甲', tool: 'Bash', isFile: false, isSubagent: false },
  ], now);
  assert.equal(e.restoreTodayIfMissing(now), true);
  const s = e.getState(now);
  assert.equal(s.today.tokens, 300);
  assert.equal(s.today.bySource.codex.tokens, 200);
  assert.equal(s.today.bySource.codex.sessions, 1);
  assert.equal(s.today.logsMissing, true);
  assert.deepEqual(s.today.logsMissingSources, ['codex']);
  assert.ok(s.sessions.some((x) => x.id === 'codex:b'));
});

test('存档：同一来源只缺一个会话文件时，补回该会话并保留来源统计', () => {
  const now = T(10, 0);
  const mkBy = () => ({
    claude: { tokens: 300, tools: 2, sids: ['claude:a', 'claude:b'] },
    codex: { tokens: 0, tools: 0, sids: [] },
    deepseek: { tokens: 0, tools: 0, sids: [] },
    grok: { tokens: 0, tools: 0, sids: [] },
    magpie: { tokens: 0, tools: 0, sids: [] },
    cursor: { tokens: 0, tools: 0, sids: [] },
  });
  const snap = {
    day: '2026-11-17', tokens: 300, bySource: mkBy(),
    sessions: [
      { id: 'claude:a', source: 'claude', label: '甲', startedAt: now - 60000, lastAt: now - 60000, tools: 1, files: 0, subagents: 0, tokens: 100, ended: false, endedAt: 0 },
      { id: 'claude:b', source: 'claude', label: '乙', startedAt: now - 50000, lastAt: now - 50000, tools: 1, files: 0, subagents: 0, tokens: 200, ended: false, endedAt: 0 },
    ],
  };
  const e = new Engine({ saved: { today: snap }, now });
  e.ingest([
    { kind: 'usage', ts: now - 30000, sid: 'claude:a', source: 'claude', label: '甲', tokens: 100 },
    { kind: 'tool', ts: now - 30000, sid: 'claude:a', source: 'claude', label: '甲', tool: 'Bash', isFile: false, isSubagent: false },
  ], now);
  assert.equal(e.restoreTodayIfMissing(now), true);
  const s = e.getState(now);
  assert.equal(s.today.tokens, 300);
  assert.equal(s.today.bySource.claude.tokens, 300);
  assert.ok(s.sessions.some((x) => x.id === 'claude:b'));
  assert.equal(s.today.logsMissing, true);
  assert.deepEqual(s.today.logsMissingSources, ['claude']);
});

test('存档：一个来源目录不可读时只恢复该来源，另一个来源仍用真实日志', async () => {
  const f = copyFixtures();
  const home = tmpDir();
  const store = new Store(home);
  const now = T(10, 30);
  const a = await loadAll(f, { now, store });
  a.engine.tick(now);
  const s1 = a.engine.getState(now);
  assert.ok(s1.today.bySource.claude.tokens > 0);
  assert.ok(s1.today.bySource.codex.tokens > 0);
  // 只让 codex 目录不可用（不存在的路径），其余来源照常
  const b = await loadAll({ ...f, codexDir: path.join(f.root, 'does-not-exist') }, { now: now + 5000, saved: store.load(), store });
  assert.equal(b.engine.restoreTodayIfMissing(now + 5000), true);
  const s2 = b.engine.getState(now + 5000);
  assert.equal(s2.today.bySource.codex.tokens, s1.today.bySource.codex.tokens);
  assert.equal(s2.today.bySource.claude.tokens, s1.today.bySource.claude.tokens);
  assert.equal(s2.today.logsMissing, true);
  assert.deepEqual(s2.today.logsMissingSources, ['codex']);
});

test('存档目录不允许放在 ~/.claude 或 ~/.codex 里', () => {
  assert.throws(() => assertSafeDataDir(path.join(os.homedir(), '.claude', 'x')));
  assert.throws(() => assertSafeDataDir(path.join(os.homedir(), '.codex')));
  assertSafeDataDir(path.join(os.homedir(), '.jiangnan-focus'));
});

// ---------------- 键鼠空闲 ----------------
test('ioreg 输出解析 HIDIdleTime（纳秒转秒）', () => {
  assert.equal(parseIdleSeconds('    | |   "HIDIdleTime" = 1878298750\n'), 1);
  assert.equal(parseIdleSeconds('"HIDIdleTime" = 600000000000'), 600);
  assert.equal(parseIdleSeconds('nothing'), null);
});

test('键鼠采样自适应：在场时 10 秒采一次，不在场每次都采', async () => {
  const seq = [{ ok: true, idleSec: 3 }, { ok: true, idleSec: 400 }, { ok: true, idleSec: 402 }, { ok: false, idleSec: 0 }];
  let calls = 0;
  const s = new IdleSampler({ sample: async () => seq[Math.min(calls++, seq.length - 1)] });
  const t = 1_000_000;
  assert.deepEqual(await s.get(t), { ok: true, idleSec: 3, estimated: false });
  assert.deepEqual(await s.get(t + 2000), { ok: true, idleSec: 5, estimated: true });
  assert.equal(calls, 1);
  assert.equal((await s.get(t + 10000)).idleSec, 400);
  assert.equal((await s.get(t + 12000)).idleSec, 402);
  assert.equal(calls, 3);
  assert.equal((await s.get(t + 14000)).ok, false);
  await s.get(t + 16000);
  assert.equal(calls, 5, '失败后每次都重试');
});

test('idle：xprintidle / gdbus 输出解析为毫秒', () => {
  assert.equal(parseXprintidleMs('  12345\n'), 12345);
  assert.equal(parseXprintidleMs('abc'), null);
  assert.equal(parseGdbusIdleMs('(<uint32 12345>,)\n'), 12345);
  assert.equal(parseGdbusIdleMs(''), null);
  assert.equal(parseGdbusIdleMs('(oops 1)'), null);
});

test('idle：Linux 探测一次后缓存可用后端，不每轮重试缺失的 xprintidle', async () => {
  resetIdleLinuxBackend();
  const calls = [];
  const run = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'xprintidle') return { ok: false, out: '' };
    if (cmd === 'gdbus') return { ok: true, out: '(<uint32 12345>,)' };
    return { ok: false, out: '' };
  };
  assert.deepEqual(await sampleIdleLinux(1000, run), { ok: true, idleSec: 12 });
  assert.equal(calls.filter((c) => c === 'xprintidle').length, 1);
  assert.equal(calls.filter((c) => c === 'gdbus').length, 1);
  await sampleIdleLinux(1000, run);
  assert.equal(calls.filter((c) => c === 'xprintidle').length, 1, '缓存后不再重试 xprintidle');
  assert.equal(calls.filter((c) => c === 'gdbus').length, 2);
  resetIdleLinuxBackend();
});

test('config：Magpie 在 ~/.config 和 APPDATA 两处里选已存在的那一处', () => {
  const home = tmpDir();
  const appData = path.join(home, 'AppData', 'Roaming');
  const cands = magpieCandidates(home, { APPDATA: appData });
  assert.deepEqual(cands, [path.join(home, '.config', 'magpie', 'usage.jsonl'), path.join(appData, 'magpie', 'usage.jsonl')]);
  assert.equal(existingFile(cands), null);
  fs.mkdirSync(path.join(appData, 'magpie'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'magpie', 'usage.jsonl'), 'x\n');
  assert.equal(existingFile(cands), path.join(appData, 'magpie', 'usage.jsonl'));
});

test('config：JN_DSH_DIR 空串停用 DeepSeek；sources 顺序和 SOURCES 一致', () => {
  const home = tmpDir();
  const cfg = loadConfig({ ...process.env, JN_HOME: home, JN_DSH_DIR: '', JN_MAGPIE_FILE: path.join(home, 'magpie.jsonl') });
  assert.equal(cfg.dshDir, null);
  assert.deepEqual(cfg.sources.map((s) => s.id), ['claude', 'codex', 'deepseek', 'grok', 'magpie', 'cursor']);
  assert.deepEqual(cfg.sources.find((s) => s.id === 'deepseek').paths, []);
  assert.equal(cfg.sources.find((s) => s.id === 'magpie').paths[0], path.join(home, 'magpie.jsonl'));
  assert.deepEqual(sourceEntries(cfg), cfg.sources);
});

test('start.mjs：Node < 22 或没有 zstd 时跳过 DeepSeek', () => {
  assert.equal(shouldSkipDsh('21.0.0', true), true);
  assert.equal(shouldSkipDsh('22.0.0', true), false);
  assert.equal(shouldSkipDsh('22.0.0', false), true);
  assert.equal(shouldSkipDsh('25.0.0', true), false);
});

test('start.mjs：浏览器 opener ENOENT 只提示手动访问，不抛异常、不改变启动结果', () => {
  let errorHandler = null;
  let unrefed = false;
  const fake = {
    on(ev, cb) { if (ev === 'error') errorHandler = cb; return this; },
    unref() { unrefed = true; },
  };
  const spawnImpl = () => fake;
  let out = '';
  const orig = console.log;
  console.log = (...a) => { out += a.join(' ') + '\n'; };
  try {
    const p = openBrowser('http://127.0.0.1:4317/', { platform: 'linux', spawnImpl });
    assert.equal(p, fake);
    assert.equal(typeof errorHandler, 'function', '应注册异步 error 监听');
    errorHandler(new Error('ENOENT'));
    assert.equal(unrefed, true);
  } finally {
    console.log = orig;
  }
  assert.match(out, /无法自动打开浏览器，请手动访问/);
});

// ---------------- HTTP / SSE ----------------
function request(port, { method = 'GET', p = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function withServer(fn) {
  const d = tmpDir();
  const web = path.join(d, 'web');
  fs.mkdirSync(path.join(web, 'models'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>江南</title>');
  fs.writeFileSync(path.join(web, 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(web, 'rewards.json'), '[]');
  fs.writeFileSync(path.join(web, 'models', 'koi.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46]));
  fs.writeFileSync(path.join(d, 'secret.txt'), 'TOP_SECRET_OUTSIDE_WEB');
  fs.symlinkSync(path.join(d, 'secret.txt'), path.join(web, 'link.txt'));
  const home = tmpDir();
  const store = new Store(home);
  const now = T(10, 0);
  const engine = new Engine({ now, store });
  engine.tick(now);
  engine.markLive();
  const app = createApp({ engine, webDir: web, nowFn: () => now });
  const port = await app.listen(0);
  try {
    await fn({ port, engine, app, store, now });
  } finally {
    await app.close();
  }
}

test('HTTP：/api/state 字段和 DESIGN.md 第七节一致', () => withServer(async ({ port, engine, now }) => {
  engine.ingest([toolEv(now - 1000, 'Edit')], now);
  const r = await request(port, { p: '/api/state' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  const s = JSON.parse(r.text);
  for (const k of ['now', 'present', 'idleSec', 'sessions', 'today', 'segment', 'pendingRewards', 'owned', 'settings', 'lanternLevel', 'presentUnknown', 'service']) assert.ok(k in s, `缺字段 ${k}`);
  for (const k of ['id', 'source', 'label', 'startedAt', 'lastAt', 'active', 'tools', 'files', 'subagents', 'tokens']) assert.ok(k in s.sessions[0], `sessions 缺字段 ${k}`);
  for (const k of ['tokens', 'aiMinutes', 'presentFocusMin', 'soloFocusMin', 'segments']) assert.equal(typeof s.today[k], 'number', `today.${k}`);
  for (const k of ['progressMin', 'targetMin', 'idleMin']) assert.equal(typeof s.segment[k], 'number', `segment.${k}`);
  assert.deepEqual(Object.keys(s.settings).sort(), ['activeMin', 'endMin', 'feedbackStyle', 'gapMin', 'lanternUnit', 'muted', 'presentOnly', 'segmentMin', 'volume']);
  assert.equal(s.settings.feedbackStyle, 'lantern');
  assert.equal(s.settings.lanternUnit, 1000);
  assert.equal(s.settings.volume, 0.3);
  assert.equal(s.sessions[0].label, '演示项目');
}));

test('HTTP：SSE 连上先发 state，之后推 beat 和 state', () => withServer(async ({ port, engine, app, now }) => {
  const got = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      const events = [];
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^event: (\w+)\ndata: (.*)$/m.exec(block);
          if (m) events.push({ event: m[1], data: JSON.parse(m[2]) });
          if (events.length === 1) {
            engine.ingest([toolEv(now - 500, 'Bash'), toolEv(now - 400, 'Bash')], now);
            engine.flushBeats();
            app.broadcastState();
          }
          if (events.length >= 4) { req.destroy(); resolve(events); }
        }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => reject(new Error('SSE 超时')), 3000);
  });
  assert.equal(got[0].event, 'state');
  assert.deepEqual(got.slice(1, 3).map((x) => `${x.event}:${x.data.kind}`), ['beat:session_start', 'beat:tool']);
  assert.equal(got[2].data.count, 2);
  assert.equal(got[2].data.session, 'claude:s1');
  assert.equal(got[2].data.tool, 'Bash');
  assert.equal(got[3].event, 'state');
}));

test('HTTP：奖励接口 offer/choose 与设置接口', () => withServer(async ({ port, engine, store }) => {
  let r = await request(port, { method: 'POST', p: '/api/reward/offer', body: {} });
  assert.deepEqual(JSON.parse(r.text), []);
  engine.rewards.grant(1);
  r = await request(port, { method: 'POST', p: '/api/reward/offer' });
  const offer = JSON.parse(r.text);
  assert.equal(offer.length, 3);
  const again = JSON.parse((await request(port, { method: 'POST', p: '/api/reward/offer' })).text);
  assert.deepEqual(again, offer);
  r = await request(port, { method: 'POST', p: '/api/reward/choose', body: { id: 'not-a-reward' } });
  assert.equal(r.status, 400);
  r = await request(port, { method: 'POST', p: '/api/reward/choose', body: { id: offer[1].id } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text).owned, [offer[1].id]);
  assert.deepEqual(store.load().owned, [offer[1].id]);
  r = await request(port, { method: 'POST', p: '/api/settings', body: { volume: 2 } });
  assert.equal(r.status, 400);
  r = await request(port, { method: 'POST', p: '/api/settings', body: { volume: 0.55, presentOnly: true } });
  assert.equal(r.status, 200);
  assert.equal(store.load().settings.volume, 0.55);
  r = await request(port, { method: 'POST', p: '/api/settings', body: 'not json' });
  assert.equal(r.status, 400);
  // 跨站 POST 和非本机 Host 拒绝
  r = await request(port, { method: 'POST', p: '/api/settings', body: { muted: true }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  r = await request(port, { p: '/api/state', headers: { host: 'evil.example:4317' } });
  assert.equal(r.status, 403);
  assert.equal(store.load().settings.muted, false);
}));

test('专注归零：只清今天的在场/独航/成段和当前段；token、AI 分钟、收藏和奖励不动', () => {
  const t0 = T(9, 0);
  const e = new Engine({ now: t0, saved: { owned: ['koi', 'cat'], pendingRewards: 1, lanternLevel: 2, currentOffer: ['pagoda', 'rain', 'snow'] } });
  e.tick(t0);
  e.markLive();
  let t = workMinutes(e, t0, 30); // 一段满 + 第二段 5 分钟
  e.flushBeats();
  let s = e.getState(t + GRACE_MS);
  assert.equal(s.today.segments, 1);
  assert.ok(s.today.presentFocusMin >= 30);
  const tokens = s.today.tokens, ai = s.today.aiMinutes, rev = s.rev;
  assert.ok(tokens > 0);
  s = e.resetFocus(t + GRACE_MS);
  assert.ok(s.rev > rev);
  assert.equal(s.today.presentFocusMin, 0);
  assert.equal(s.today.soloFocusMin, 0);
  assert.equal(s.today.segments, 0);
  assert.equal(e.focus.segment.progress, 0);
  assert.ok(s.segment.progressMin < 1); // 只剩正在进行这一分钟的插值
  assert.deepEqual(s.owned, ['koi', 'cat']);
  assert.equal(s.pendingRewards, 2, '之前存的 1 个 + 这段完成又得的 1 个');
  assert.equal(s.lanternLevel, 2);
  assert.deepEqual(e.rewards.offerIds, ['pagoda', 'rain', 'snow']);
  assert.equal(s.today.tokens, tokens);
  assert.equal(s.today.aiMinutes, ai);
  // 之后继续正常累计
  t = workMinutes(e, t, 2);
  assert.equal(e.getState(t + GRACE_MS).today.presentFocusMin, 2);
});

test('HTTP：POST /api/focus/reset 返回完整 state 并落盘；跨站拒绝、GET 不允许；收藏和奖励不动', () => withServer(async ({ port, engine, store }) => {
  engine.rewards.grant(2);
  engine.rewards.owned.push('koi');
  engine.save(Date.now());
  let r = await request(port, { method: 'POST', p: '/api/focus/reset', body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(store.load().pendingRewards, 2);
  r = await request(port, { p: '/api/focus/reset' });
  assert.equal(r.status, 405);
  r = await request(port, { method: 'POST', p: '/api/focus/reset', body: {} });
  assert.equal(r.status, 200);
  const s = JSON.parse(r.text);
  assert.equal(s.ok, true);
  assert.ok(Number.isInteger(s.rev));
  assert.ok(Array.isArray(s.sessions));
  assert.deepEqual(s.owned, ['koi']);
  assert.equal(s.pendingRewards, 2);
  assert.equal(s.today.segments, 0);
  const saved = store.load();
  assert.equal(saved.pendingRewards, 2);
  assert.deepEqual(saved.owned, ['koi']);
}));

test('HTTP：静态文件带正确 Content-Type，禁止穿越到 web 目录之外', () => withServer(async ({ port }) => {
  let r = await request(port, { p: '/' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  r = await request(port, { p: '/app.js' });
  assert.match(r.headers['content-type'], /javascript/);
  r = await request(port, { p: '/rewards.json' });
  assert.match(r.headers['content-type'], /application\/json/);
  r = await request(port, { p: '/models/koi.glb' });
  assert.equal(r.headers['content-type'], 'model/gltf-binary');
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/models/..%2f..%2fsecret.txt', '/link.txt', '/%00']) {
    r = await request(port, { p });
    assert.ok(r.status !== 200, `${p} 不应返回 200`);
    assert.ok(!r.text.includes('TOP_SECRET'), `${p} 泄露了 web 目录外的文件`);
  }
  r = await request(port, { p: '/nope.html' });
  assert.equal(r.status, 404);
}));

// ---------------- 另外四个来源 ----------------
// 各来源 fixture 的预期：claude 245、codex 860、deepseek 600、grok 790、magpie 305、cursor 330
const EXPECT = {
  claude: { tokens: 245, sessions: 1, tools: 8 },
  codex: { tokens: 860, sessions: 1, tools: 3 },
  deepseek: { tokens: 600, sessions: 1, tools: 2 },
  grok: { tokens: 790, sessions: 2, tools: 2 },
  magpie: { tokens: 305, sessions: 3, tools: 0 },
  cursor: { tokens: 330, sessions: 1, tools: 0 },
};
const ALL_TOKENS = Object.values(EXPECT).reduce((a, b) => a + b.tokens, 0);

test('六个来源：today.bySource 给全六项，数字和会话来源正确', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine } = await loadAll(f, { now });
  const s = engine.getState(now);
  assert.deepEqual(s.today.bySource, EXPECT);
  assert.equal(s.today.tokens, ALL_TOKENS);
  const bySrc = (src) => s.sessions.filter((x) => x.source === src);
  assert.equal(bySrc('deepseek')[0].folder, '深度项目');
  assert.equal(bySrc('deepseek')[0].files, 1);
  assert.deepEqual(bySrc('grok').map((x) => x.folder).sort(), ['Grok', '好项目']);
  assert.equal(bySrc('grok').find((x) => x.folder === '好项目').files, 1, 'search_replace 算改文件');
  assert.deepEqual(bySrc('magpie').map((x) => x.folder).sort(), ['Magpie', 'Magpie', 'Magpie']);
  assert.equal(bySrc('cursor')[0].id, 'cursor:cur-1');
  // 空的一天：六项都是 0
  const e2 = new Engine({ now });
  assert.deepEqual(Object.values(e2.getState(now).today.bySource), Object.values(EXPECT).map(() => ({ tokens: 0, sessions: 0, tools: 0 })));
});

test('DeepSeek Harness：两帧 zstd 逐帧解压；半帧不算，写完下次读到；不重复计数', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine, extra, clock } = await loadAll(f, { now });
  const b0 = Buffer.concat([DSH_F1(), DSH_F2()]);
  assert.equal(zstdFrameEnd(b0, 0), DSH_F1().length);
  assert.equal(zstdFrameEnd(b0.subarray(0, 10), 0), -1);
  const ds = () => engine.getState(clock.now).today.bySource.deepseek;
  assert.equal(ds().tokens, 600);
  const f3 = DSH_F3();
  fs.appendFileSync(f.dshFile, f3.subarray(0, 9));
  clock.now = now + 2000;
  await extra.poll(clock.now);
  assert.equal(ds().tokens, 600, '半帧不解析');
  fs.appendFileSync(f.dshFile, f3.subarray(9));
  clock.now = now + 4000;
  await extra.poll(clock.now);
  assert.equal(ds().tokens, 610);
  await extra.fullScan(now + 10000);
  assert.equal(ds().tokens, 610, '再扫不重复');
  assert.equal(extra.stats.frames, 3);
});

test('DeepSeek Harness：解压失败当作没写完，重试 3 次后跳过这一帧，后面的帧照读', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine, extra, clock } = await loadAll(f, { now });
  // 帧头和块长度不变，只改坏压缩内容：帧边界判断得出，解压会失败
  const bad = Buffer.from(dshFrame({ type: 'assistant/message', seq: 20, time: DSH_T + 70000, data: { usage: { inputTokens: 999, outputTokens: 0, cacheWriteTokens: 0 } } }));
  const cut = bad.length - 6;
  for (let i = 10; i < cut; i++) bad[i] ^= 0x5a;
  fs.appendFileSync(f.dshFile, bad);
  for (let k = 1; k <= 3; k++) { clock.now = now + k * 2000; await extra.poll(clock.now); }
  fs.appendFileSync(f.dshFile, DSH_F3());
  clock.now = now + 10000;
  await extra.poll(clock.now);
  const ds = engine.getState(clock.now).today.bySource.deepseek;
  assert.equal(ds.tokens, 610, '坏帧跳过，后面的第三帧读到');
  assert.ok(extra.stats.frameRetries >= 2);
});

test('DeepSeek Harness：今天之前没改过的文件启动时不读；之后续写先补读第一帧拿会话 id', async () => {
  const f = copyFixtures();
  const y = T(12, 0, 0, 16) / 1000;
  fs.utimesSync(f.dshFile, y, y);
  const now = T(10, 10);
  const { engine, extra, clock } = await loadAll(f, { now });
  assert.equal(engine.getState(now).today.bySource.deepseek.tokens, 0);
  fs.appendFileSync(f.dshFile, DSH_F3());
  clock.now = now + 10000;
  await extra.fullScan(clock.now);
  const st = engine.getState(clock.now);
  assert.equal(st.today.bySource.deepseek.tokens, 10);
  const s = st.sessions.find((x) => x.source === 'deepseek');
  assert.equal(s.id, 'deepseek:' + DSH_ID);
  assert.equal(s.folder, '深度项目');
});

test('Grok Build：只认 inference_done 和 exec_done、昨天和重复行不算；日志截断或轮转后接着读不重复', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine, extra, clock } = await loadAll(f, { now });
  const g = () => engine.getState(clock.now).today.bySource.grok;
  assert.deepEqual(g(), EXPECT.grok);
  const inf = (ts, loop, p, c, o) => JSON.stringify({ ts, sid: GROK_G1, msg: 'shell.turn.inference_done', ctx: { loop_index: loop, prompt_tokens: p, cached_prompt_tokens: c, completion_tokens: o } }) + '\n';
  // 截断后重写：旧的一行（同 ts、同 loop）+ 新的一行
  fs.writeFileSync(f.grokLog, inf('2026-11-17T18:00:05.000Z', 0, 1000, 600, 50) + inf('2026-11-17T18:05:00.000Z', 2, 300, 100, 5));
  clock.now = now + 2000;
  await extra.poll(clock.now);
  assert.equal(g().tokens, 790 + 205, '截断后只多出新的一行');
  // 轮转：改名后新建同名文件
  fs.renameSync(f.grokLog, f.grokLog + '.1');
  fs.writeFileSync(f.grokLog, inf('2026-11-17T18:06:00.000Z', 3, 50, 0, 5));
  clock.now = now + 4000;
  await extra.poll(clock.now);
  assert.equal(g().tokens, 790 + 205 + 55);
});

test('Magpie：claude 行已在 Claude 日志里的跳过；cursor 归 Cursor；没花 token 的不算；其余按 agent 每天一条船', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine, extra } = await loadAll(f, { now });
  const s = engine.getState(now);
  assert.deepEqual(s.today.bySource.magpie, EXPECT.magpie);
  assert.deepEqual(s.today.bySource.cursor, EXPECT.cursor);
  assert.equal(s.sessions.find((x) => x.id === SID).tokens, 245, 'Claude 会话没有被 Magpie 重复加');
  assert.equal(extra.stats.magpieSkippedClaude, 1);
  assert.ok(!s.sessions.some((x) => x.id.includes('curl')));
});

test('Magpie：运行中不认识的 claude 会话先压 25 秒，期间认出是 Claude Code 会话就丢掉，否则算 Magpie', async () => {
  const f = copyFixtures();
  const now = T(10, 10);
  const { engine, extra, clock, extraClaude } = await loadAll(f, { now, live: true });
  const row = (t, session, rid) => JSON.stringify({ t, agent: 'claude', session, in: 50, out: 5, cache_read: 0, cache_write: 0, ms: 1000, status: 200, rid }) + '\n';
  fs.appendFileSync(f.magpieFile, row('2026-11-17T10:09:50.000000-08:00', 'later-known', 'x1') + row('2026-11-17T10:09:51.000000-08:00', 'never-known', 'x2'));
  clock.now = now + 2000;
  await extra.poll(clock.now);
  const m = () => engine.getState(clock.now).today.bySource.magpie.tokens;
  assert.equal(m(), 305, '先压着');
  extraClaude.add('later-known'); // 比如 Claude 日志的全量扫描刚发现这个会话文件
  clock.now = now + 12000;
  await extra.poll(clock.now);
  assert.equal(m(), 305);
  clock.now = now + 30000;
  await extra.poll(clock.now);
  assert.equal(m(), 305 + 55, '只有没认出的那行算 Magpie');
});

test('四个来源只读、不输出正文：fixtures 原样未动，state 里没有 SECRET', async () => {
  const f = copyFixtures();
  const before = treeDigest(f.root);
  const now = Date.parse('2026-11-17T18:01:30.000Z');
  const { engine, extra } = await loadAll(f, { now, live: true });
  const beats = [];
  engine.on('beat', (b) => beats.push(b));
  await extra.poll(now + 2000);
  await extra.fullScan(now + 4000);
  engine.tick(now + 4000);
  engine.flushBeats();
  assert.equal(treeDigest(f.root), before);
  const out = JSON.stringify(engine.getState(now + 4000)) + JSON.stringify(beats);
  assert.ok(!out.includes('SECRET'));
  assert.ok(!out.includes('/home/demo'));
});


test('focusd.mjs 端到端：用 fixtures 启动、/api/state 有数据、收到 SIGTERM 正常退出', async () => {
  const f = copyFixtures();
  const home = tmpDir();
  const child = spawn(process.execPath, [path.join(HERE, '..', 'focusd.mjs')], {
    env: { ...process.env, JN_HOME: home, JN_CLAUDE_DIR: f.claudeDir, JN_CODEX_DIR: f.codexDir, JN_DSH_DIR: f.dshDir, JN_GROK_DIR: f.grokDir, JN_MAGPIE_FILE: f.magpieFile, JN_PORT: '0', JN_WEB_DIR: tmpDir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
        if (m) { clearInterval(timer); resolve(Number(m[1])); }
      }, 50);
      setTimeout(() => { clearInterval(timer); reject(new Error('启动超时')); }, 10000);
    });
    const s = JSON.parse((await request(port, { p: '/api/state' })).text);
    // fixtures 的日期是 2026-11-17：今天正好是这一天时是六个来源的合计，否则启动回放不读，应为 0
    assert.equal(s.today.tokens, dayKey(Date.now()) === '2026-11-17' ? ALL_TOKENS : 0);
    assert.deepEqual(Object.keys(s.today.bySource), ['claude', 'codex', 'deepseek', 'grok', 'magpie', 'cursor']);
    assert.equal(typeof s.idleSec, 'number');
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.ok(fs.existsSync(path.join(home, 'save.json')));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

// ---------------- 运行 ----------------
let pass = 0;
let fail = 0;
for (const t of tests) {
  try {
    await t.fn();
    pass++;
    console.log(`通过  ${t.name}`);
  } catch (e) {
    fail++;
    console.log(`失败  ${t.name}\n      ${(e && e.stack ? e.stack : String(e)).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
// 临时目录不主动删除（按项目约定不做删除），由系统定期清理
console.log(`\n临时目录：${tmpRoot}`);
console.log(`\n共 ${tests.length} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
