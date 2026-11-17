// 另外四个来源（只读）：DeepSeek Harness、Grok Build、Magpie 网关、经 Magpie 的 Cursor CLI。
// 和 logwatch.mjs 一样：记住读到的字节位置，只读新增部分；启动只读今天改过的文件；只取时间、会话、token、工具名。
//
// - DeepSeek Harness：<JN_DSH_DIR>/<cwd 编码>/session-<id>/session.v4.jsonl.zstd
//   文件是一串独立的 zstd 帧，边写边追加。按帧头解析出完整的帧再逐帧解压，最后一个没写完的帧留到下次。
// - Grok Build：<JN_GROK_DIR>/logs/unified.jsonl 一个文件，只看两种行：
//   shell.turn.inference_done（token）和 shell.tool.exec_done（工具调用，带 sid 和 tool_name）。
//   会话的项目名取 <JN_GROK_DIR>/sessions/<URL 编码的 cwd>/<sid>/ 这个文件夹名，不打开里面任何文件。
// - Magpie：<JN_MAGPIE_FILE>（usage.jsonl），每个请求结束写一行用量。绝不读 routing/ 目录（里面有提示词）。
//   agent 为 claude 且会话已在 Claude Code 日志里出现的行跳过（那边已经算过）；cursor 归 Cursor；其余按 agent 每天一条船。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { startOfDay, dayKey } from './localday.mjs';
import { readLines, findStartOffset } from './logwatch.mjs';
import { lastSegment } from './parsers.mjs';

const SEEK_MARGIN_MS = 10 * 60000;
const HOT_KEEP_MS = 3 * 3600 * 1000;
const MAGPIE_HOLD_MS = 25000; // 不认识的 claude 会话先压 25 秒，等 Claude 日志的全量扫描（10 秒一次）认出它
const GROK_INDEX_TTL_MS = 30000;
const DSH_WINDOW = 8 << 20;
const DSH_MAX_WINDOW = 256 << 20;
const ZSTD_MAGIC = 0xFD2FB528;
const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function'; // 老版本 Node 没有 zstd，直接跳过 DeepSeek

const FILE_TOOL_RE = /^(edit|write|multiedit|multi_edit|notebookedit|search_replace|str_replace|str_replace_editor|strreplace|apply_patch|edit_file|write_file|create_file)$/i;
const SUBAGENT_TOOL_RE = /^(task|agent|spawn_agent|delegate|delegate_task|subagent|launch_agent)$/i;

export function classifyTool(name) {
  return { isFile: FILE_TOOL_RE.test(name), isSubagent: SUBAGENT_TOOL_RE.test(name) };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---------- zstd 帧边界 ----------
// 返回这一帧结束的位置；-1 = 还没写完；-2 = 这里不是帧开头
export function zstdFrameEnd(b, off) {
  if (off + 4 > b.length) return -1;
  const m = b.readUInt32LE(off);
  if (((m & 0xFFFFFFF0) >>> 0) === 0x184D2A50) { // 可跳过帧
    if (off + 8 > b.length) return -1;
    const e = off + 8 + b.readUInt32LE(off + 4);
    return e <= b.length ? e : -1;
  }
  if (m !== ZSTD_MAGIC) return -2;
  if (off + 5 > b.length) return -1;
  const fhd = b[off + 4];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const didFlag = fhd & 3;
  let p = off + 5 + (single ? 0 : 1) + [0, 1, 2, 4][didFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (p + 3 > b.length) return -1;
    const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    p += 3;
    if (type === 3) return -2;
    p += type === 1 ? 1 : size;
    if (p > b.length) return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p <= b.length ? p : -1;
}

function nextMagic(b, from) {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) return i;
  }
  return -1;
}

// ---------- 行解析（只取统计字段） ----------
const DSH_PATTERNS = ['"type":"session"', '"type":"assistant/message"', '"type":"tool/call"'];

export function parseDshLine(text, ctx) {
  if (!DSH_PATTERNS.some((p) => text.includes(p))) return [];
  let d;
  try { d = JSON.parse(text); } catch { return []; }
  if (!d || typeof d !== 'object') return [];
  if (d.type === 'session') {
    if (typeof d.id === 'string' && d.id) ctx.sid = d.id;
    const l = lastSegment(d.cwd);
    if (l) ctx.label = l;
    return [];
  }
  const ts = num(d.time);
  if (!ts) return [];
  const id = ctx.sid || ctx.fallbackSid;
  const sid = 'deepseek:' + id;
  const label = ctx.label || 'DeepSeek';
  const data = d.data && typeof d.data === 'object' ? d.data : {};
  if (d.type === 'assistant/message') {
    const u = data.usage && typeof data.usage === 'object' ? data.usage : {};
    const tokens = num(u.inputTokens) + num(u.cacheWriteTokens) + num(u.outputTokens);
    return [{ kind: 'usage', ts, sid, source: 'deepseek', label, tokens, key: `dm:${id}:${d.seq}` }];
  }
  if (d.type === 'tool/call' && typeof data.name === 'string' && data.name) {
    const key = typeof data.callId === 'string' && data.callId ? `dt:${id}:${data.callId}` : `dt:${id}:${d.seq}`;
    return [{ kind: 'tool', ts, sid, source: 'deepseek', label, tool: data.name, ...classifyTool(data.name), key }];
  }
  return [];
}

const GROK_PATTERNS = [Buffer.from('"msg":"shell.turn.inference_done"'), Buffer.from('"msg":"shell.tool.exec_done"')];

export function parseGrokLine(text, labelFor) {
  let d;
  try { d = JSON.parse(text); } catch { return []; }
  if (!d || typeof d.sid !== 'string' || !d.sid) return [];
  const ts = Date.parse(d.ts);
  if (!Number.isFinite(ts)) return [];
  const c = d.ctx && typeof d.ctx === 'object' ? d.ctx : {};
  const sid = 'grok:' + d.sid;
  if (d.msg === 'shell.turn.inference_done') {
    const tokens = Math.max(0, num(c.prompt_tokens) - num(c.cached_prompt_tokens)) + num(c.completion_tokens);
    return [{ kind: 'usage', ts, sid, source: 'grok', label: labelFor(d.sid), tokens, key: `gi:${d.sid}:${d.ts}:${c.loop_index ?? ''}` }];
  }
  if (d.msg === 'shell.tool.exec_done' && typeof c.tool_name === 'string' && c.tool_name) {
    return [{ kind: 'tool', ts, sid, source: 'grok', label: labelFor(d.sid), tool: c.tool_name, ...classifyTool(c.tool_name), key: `gt:${d.sid}:${d.ts}:${c.tool_name}` }];
  }
  return [];
}

const MAGPIE_PATTERNS = [Buffer.from('"agent":"')];

// 返回 null，或 { ev, claudeSession }（claudeSession 非空时需要先确认 Claude Code 日志里没有这个会话）
export function parseMagpieLine(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || typeof d.agent !== 'string' || !d.agent) return null;
  const start = Date.parse(d.t);
  if (!Number.isFinite(start)) return null;
  const all = num(d.in) + num(d.out) + num(d.cache_read) + num(d.cache_write);
  if (all <= 0) return null; // 没花 token 的请求（探活、失败）不算干活
  const ts = start + Math.max(0, num(d.ms)); // 行是请求结束时写的，用结束时间
  const tokens = num(d.in) + num(d.cache_write) + num(d.out);
  const agent = d.agent;
  const session = (typeof d.session === 'string' && d.session) || (typeof d.native_session === 'string' && d.native_session) || '';
  const key = `mp:${d.t}:${agent}:${d.rid || d.response_id || d.route_id || ''}`;
  const base = { kind: 'usage', ts, tokens, key };
  if (/^claude$/i.test(agent)) {
    if (session) return { ev: { ...base, sid: 'magpie:claude:' + session, source: 'magpie', label: 'Magpie' }, claudeSession: session };
    return { ev: { ...base, sid: `magpie:claude:${dayKey(ts)}`, source: 'magpie', label: 'Magpie' }, claudeSession: '' };
  }
  if (/cursor/i.test(agent)) {
    return { ev: { ...base, sid: 'cursor:' + (session || dayKey(ts)), source: 'cursor', label: 'Cursor' }, claudeSession: '' };
  }
  return { ev: { ...base, sid: `magpie:${agent}:${dayKey(ts)}`, source: 'magpie', label: 'Magpie' }, claudeSession: '' };
}

function statQuiet(p) {
  try { return fs.statSync(p, { throwIfNoEntry: false }) || null; } catch { return null; }
}

// ---------- 监视器 ----------
export class ExtraSources {
  constructor({ dshDir, grokDir, magpieFile, onEvents, isClaudeSession = () => false }) {
    this.dshDir = HAS_ZSTD ? dshDir : null;
    this.grokDir = grokDir;
    this.grokLog = grokDir ? path.join(grokDir, 'logs', 'unified.jsonl') : null;
    this.grokSessions = grokDir ? path.join(grokDir, 'sessions') : null;
    this.magpieFile = magpieFile;
    this.onEvents = onEvents;
    this.isClaudeSession = isClaudeSession;
    this.files = new Map(); // path -> rec
    this.dirCache = new Map();
    this.grokIndex = new Map(); // sid -> label
    this.grokIndexAt = -Infinity;
    this.held = [];
    this.live = false;
    this.stats = { filesKnown: 0, filesRead: 0, bytesRead: 0, frames: 0, frameRetries: 0, magpieSkippedClaude: 0 };
  }

  markLive() {
    this.live = true;
  }

  async init(now) {
    await this._discover(now, true);
    this._processHeld(now);
  }

  // 稳态：只 stat 热文件（Grok、Magpie 两个单文件始终是热的）
  async poll(now) {
    const dayStart = startOfDay(now);
    for (const rec of this.files.values()) {
      if (!rec.hot) continue;
      const st = statQuiet(rec.path);
      if (st && st.isFile()) await this._update(rec, st, now, dayStart);
    }
    this._processHeld(now);
  }

  async fullScan(now) {
    await this._discover(now, false);
    const dayStart = startOfDay(now);
    for (const rec of this.files.values()) {
      if (rec.single) rec.hot = true;
      else rec.hot = rec.mtimeMs >= dayStart || now - rec.mtimeMs < HOT_KEEP_MS;
    }
    this._processHeld(now);
  }

  async _discover(now, initial) {
    const dayStart = startOfDay(now);
    const seenDirs = new Set();
    const cands = [];
    if (this.grokLog) cands.push({ p: this.grokLog, kind: 'grok', single: true });
    if (this.magpieFile) cands.push({ p: this.magpieFile, kind: 'magpie', single: true });
    cands.push(...this._walkDsh(seenDirs).map((p) => ({ p, kind: 'dsh', single: false })));
    const seenPaths = new Set();
    for (const { p, kind, single } of cands) {
      const st = statQuiet(p);
      if (!st || !st.isFile()) continue;
      seenPaths.add(p);
      let rec = this.files.get(p);
      if (rec) {
        if (!initial) await this._update(rec, st, now, dayStart);
        continue;
      }
      rec = {
        path: p, kind, single, pos: 0, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, hot: single,
        ctx: { fallbackSid: kind === 'dsh' ? path.basename(path.dirname(p)).replace(/^session-/, '') : '', sid: '', label: '' },
        carry: '', fail: 0,
      };
      this.files.set(p, rec);
      if (st.mtimeMs >= dayStart) {
        rec.hot = true;
        let from = 0;
        if (kind === 'grok') from = await findStartOffset(p, st.size, dayStart - SEEK_MARGIN_MS, Buffer.from('"ts":"'));
        else if (kind === 'magpie') from = await findStartOffset(p, st.size, dayStart - SEEK_MARGIN_MS, Buffer.from('"t":"'));
        await this._read(rec, from, st.size, now);
      } else {
        rec.pos = st.size; // 今天之前就没改过：不读，只记位置
      }
    }
    if (!initial) {
      // 对账：文件已经被删除/轮转走的，不再保留读取位置；目录缓存里已经不可达的也一并清掉
      for (const p of [...this.files.keys()]) {
        if (!seenPaths.has(p)) this.files.delete(p);
      }
      for (const d of [...this.dirCache.keys()]) {
        if (!seenDirs.has(d)) this.dirCache.delete(d);
      }
    }
    this.stats.filesKnown = this.files.size;
  }

  _walkDsh(seenDirs = null) {
    const out = [];
    if (!this.dshDir) return out;
    const stack = [this.dshDir];
    while (stack.length) {
      const dir = stack.pop();
      const st = statQuiet(dir);
      if (!st || !st.isDirectory()) { this.dirCache.delete(dir); continue; }
      if (seenDirs) seenDirs.add(dir);
      let c = this.dirCache.get(dir);
      if (!c || c.mtimeMs !== st.mtimeMs) {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        c = { mtimeMs: st.mtimeMs, files: [], dirs: [] };
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) c.dirs.push(p);
          else if (e.isFile() && e.name.endsWith('.jsonl.zstd')) c.files.push(p);
        }
        this.dirCache.set(dir, c);
      }
      for (const f of c.files) out.push(f);
      for (const d of c.dirs) stack.push(d);
    }
    return out;
  }

  async _update(rec, st, now, dayStart) {
    // 没变就不读；上次有帧解压失败时例外，下一轮再试
    if (st.size === rec.size && st.ino === rec.ino && st.mtimeMs === rec.mtimeMs && !rec.fail) return;
    if (st.ino !== rec.ino || st.size < rec.pos) {
      // 被截断或换了新文件（日志轮转）：从头读，靠去重键不会重复计数
      rec.ino = st.ino;
      rec.pos = 0;
      rec.carry = '';
      rec.fail = 0;
      if (rec.kind === 'dsh') rec.ctx = { fallbackSid: rec.ctx.fallbackSid, sid: '', label: '' };
    }
    rec.mtimeMs = st.mtimeMs;
    rec.size = st.size;
    if (st.mtimeMs >= dayStart || now - st.mtimeMs < HOT_KEEP_MS) rec.hot = true;
    if (st.size > rec.pos) await this._read(rec, rec.pos, st.size, now);
  }

  async _read(rec, from, to, now) {
    let fh;
    try { fh = await fsp.open(rec.path, 'r'); } catch { return; }
    try {
      this.stats.filesRead++;
      if (rec.kind === 'dsh') return await this._readDsh(fh, rec, from, to);
      const events = [];
      if (rec.kind === 'grok') {
        const labelFor = (sid) => this._grokLabel(sid);
        rec.pos = await readLines(fh, from, to, (line) => {
          if (line.indexOf(GROK_PATTERNS[0]) === -1 && line.indexOf(GROK_PATTERNS[1]) === -1) return;
          for (const e of parseGrokLine(line.toString('utf8'), labelFor)) events.push(e);
        }, this.stats);
      } else {
        rec.pos = await readLines(fh, from, to, (line) => {
          if (line.indexOf(MAGPIE_PATTERNS[0]) === -1) return;
          const r = parseMagpieLine(line.toString('utf8'));
          if (!r) return;
          if (r.claudeSession) this.held.push({ ev: r.ev, session: r.claudeSession, deadline: now + MAGPIE_HOLD_MS });
          else events.push(r.ev);
        }, this.stats);
      }
      if (events.length) this.onEvents(events);
    } finally {
      await fh.close();
    }
  }

  async _readDsh(fh, rec, from, to) {
    // 从中间开始读、还不知道会话 id 时，先解第一帧拿 session 行
    if (from > 0 && !rec.ctx.sid) await this._readDshHeader(fh, rec);
    const events = [];
    let pos = from;
    let win = DSH_WINDOW;
    while (pos < to) {
      const len = Math.min(win, to - pos);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      this.stats.bytesRead += bytesRead;
      const b = buf.subarray(0, bytesRead);
      let off = 0;
      let stop = false;
      while (off < b.length) {
        const end = zstdFrameEnd(b, off);
        if (end === -1) break; // 帧没写完：下次再读
        if (end === -2) {
          const nm = nextMagic(b, off + 1);
          if (nm === -1) { stop = true; break; }
          off = nm; // 跳过坏字节
          continue;
        }
        let text;
        try {
          text = zlib.zstdDecompressSync(b.subarray(off, end)).toString('utf8');
        } catch {
          // 解不开：先当作没写完，下次再试；连续 3 次还解不开就跳过这一帧
          rec.fail += 1;
          this.stats.frameRetries++;
          if (rec.fail < 3) { stop = true; break; }
          rec.fail = 0;
          off = end;
          continue;
        }
        rec.fail = 0;
        this.stats.frames++;
        off = end;
        const all = rec.carry + text;
        const lines = all.split('\n');
        rec.carry = lines.pop() || '';
        if (rec.carry.length > (1 << 20)) rec.carry = '';
        for (const l of lines) if (l) for (const e of parseDshLine(l, rec.ctx)) events.push(e);
      }
      pos += off;
      if (stop) break;
      if (off === 0) {
        // 一个窗口里一帧都不完整：可能帧很大，放大窗口；已经读到文件尾就等下次
        if (len < to - pos && win < DSH_MAX_WINDOW) { win *= 2; continue; }
        break;
      }
    }
    rec.pos = pos;
    if (events.length) this.onEvents(events);
  }

  async _readDshHeader(fh, rec) {
    const buf = Buffer.allocUnsafe(Math.min(1 << 20, rec.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);
    const end = zstdFrameEnd(b, 0);
    if (end < 0) return;
    try {
      const text = zlib.zstdDecompressSync(b.subarray(0, end)).toString('utf8');
      for (const l of text.split('\n')) if (l) parseDshLine(l, rec.ctx);
    } catch { /* 忽略 */ }
  }

  // Grok 会话的项目名：sessions/<URL 编码的 cwd>/<sid>/ 文件夹名，30 秒内最多重建一次索引。
  // 重建时先清空旧索引，已删除的会话目录不会继续留下失效的 sid -> label。
  _grokLabel(sid) {
    if (!this.grokSessions) return 'Grok';
    const now = Date.now();
    if (now - this.grokIndexAt >= GROK_INDEX_TTL_MS) {
      this.grokIndexAt = now;
      this.grokIndex.clear();
      let encs = [];
      try { encs = fs.readdirSync(this.grokSessions, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { /* 没有目录 */ }
      for (const e of encs) {
        let cwd;
        try { cwd = decodeURIComponent(e.name); } catch { cwd = e.name; }
        const label = lastSegment(cwd) || 'Grok';
        let sids = [];
        try { sids = fs.readdirSync(path.join(this.grokSessions, e.name), { withFileTypes: true }).filter((x) => x.isDirectory()); } catch { /* 忽略 */ }
        for (const s of sids) this.grokIndex.set(s.name, label);
      }
    }
    return this.grokIndex.get(sid) || 'Grok';
  }

  // Magpie 里 agent=claude 的行：Claude Code 日志里有这个会话就跳过，没有才算 Magpie
  _processHeld(now) {
    if (!this.held.length) return;
    const keep = [];
    const out = [];
    for (const h of this.held) {
      if (this.isClaudeSession(h.session)) { this.stats.magpieSkippedClaude++; continue; }
      if (this.live && now < h.deadline) keep.push(h);
      else out.push(h.ev);
    }
    this.held = keep;
    if (out.length) this.onEvents(out);
  }
}
