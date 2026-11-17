// 只读增量读取 Claude Code / Codex 的 jsonl 日志。
// - 每个文件记住读到的字节位置；只读新增部分；最后半行留到下次
// - 启动时只读今天改过的文件；大文件先二分定位到“今天”附近再读，跳过更早的内容
// - 文件只用 'r'（只读）方式打开，绝不写入
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { startOfDay } from './localday.mjs';
import {
  CLAUDE_PATTERNS, CODEX_PATTERNS, lineMatches,
  parseClaudeLine, parseCodexLine, applyCodexMeta, fallbackSessionId,
} from './parsers.mjs';

const CHUNK = 1 << 20; // 每次最多读 1MB
const SEEK_MIN_SIZE = 4 << 20; // 大于 4MB 的文件才二分定位
const SEEK_STOP = 1 << 20; // 二分到 1MB 范围内停止
const SEEK_MARGIN_MS = 10 * 60000; // 定位到零点前 10 分钟，留余量
const MAX_LINE = 64 << 20; // 单行超过 64MB 直接丢弃，防止内存失控
const HOT_KEEP_MS = 3 * 3600 * 1000; // 3 小时内改过的文件每 2 秒查一次
const TS_KEY = Buffer.from('"timestamp":"');

// 同步 stat：几百个小调用用同步版比 Promise 版省很多 CPU（每次几微秒）
function statQuiet(p) {
  try {
    return fs.statSync(p, { throwIfNoEntry: false }) || null;
  } catch {
    return null;
  }
}

export class LogWatcher {
  constructor({ claudeDir, codexDir, onEvents }) {
    this.roots = [
      { dir: claudeDir, source: 'claude' },
      { dir: codexDir, source: 'codex' },
    ];
    this.onEvents = onEvents;
    this.files = new Map(); // path -> rec
    this.dirCache = new Map(); // 目录 -> { mtimeMs, files, dirs }：目录没变就不重新列
    this.claudeIds = new Set(); // Claude Code 会话 id（全量扫描时按当前文件集合对账）
    this.stats = { filesKnown: 0, filesRead: 0, bytesRead: 0, linesParsed: 0, lastScanMs: 0, lastPollMs: 0 };
  }

  // 找出 root 下所有 .jsonl；目录的修改时间没变就用上次列出的结果
  _walk(root, seenDirs = null) {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      const st = statQuiet(dir);
      if (!st || !st.isDirectory()) {
        this.dirCache.delete(dir);
        continue;
      }
      if (seenDirs) seenDirs.add(dir);
      let c = this.dirCache.get(dir);
      if (!c || c.mtimeMs !== st.mtimeMs) {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        c = { mtimeMs: st.mtimeMs, files: [], dirs: [] };
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) c.dirs.push(p);
          else if (e.isFile() && e.name.endsWith('.jsonl')) c.files.push(p);
        }
        this.dirCache.set(dir, c);
      }
      for (const f of c.files) out.push(f);
      for (const d of c.dirs) stack.push(d);
    }
    return out;
  }

  _statAll(paths) {
    const out = [];
    for (const p of paths) {
      const st = statQuiet(p);
      if (st && st.isFile()) out.push([p, st]);
    }
    return out;
  }

  // 启动：发现所有文件；今天改过的读出今天的部分，其余只记住大小
  async init(now) {
    const t0 = performance.now();
    const dayStart = startOfDay(now);
    for (const { dir, source } of this.roots) {
      const paths = this._walk(dir);
      for (const [p, st] of this._statAll(paths)) {
        const rec = this._newRec(p, source, st);
        this.files.set(p, rec);
        if (st.mtimeMs >= dayStart) {
          rec.hot = true;
          const from = await this._findStart(p, st.size, dayStart - SEEK_MARGIN_MS);
          await this._read(rec, from, st.size);
        } else {
          rec.pos = st.size; // 今天之前就没改过：不读，只记位置
        }
      }
    }
    this.stats.filesKnown = this.files.size;
    this.stats.lastScanMs = performance.now() - t0;
  }

  _newRec(p, source, st) {
    if (source === 'claude' && !p.includes(`${path.sep}subagents${path.sep}`)) this.claudeIds.add(path.basename(p, '.jsonl'));
    return {
      path: p, source, pos: 0, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, hot: false,
      ctx: { fallbackSid: fallbackSessionId(p), sid: '', label: '', lastCodex: null, metaSeen: false },
    };
  }

  // 稳态：只 stat 最近改过的文件，长了就读新增部分
  async pollHot(now) {
    const t0 = performance.now();
    const dayStart = startOfDay(now);
    for (const rec of this.files.values()) {
      if (!rec.hot) continue;
      const st = statQuiet(rec.path);
      if (st && st.isFile()) await this._update(rec, st, now, dayStart);
    }
    this.stats.lastPollMs = performance.now() - t0;
  }

  // 全量扫：发现新文件（新会话）和被续写的旧文件；同时把已经不存在的文件和目录缓存对账清掉
  async fullScan(now) {
    const t0 = performance.now();
    const dayStart = startOfDay(now);
    const seenPaths = new Set();
    const seenDirs = new Set();
    for (const { dir, source } of this.roots) {
      const paths = this._walk(dir, seenDirs);
      for (const [p, st] of this._statAll(paths)) {
        seenPaths.add(p);
        let rec = this.files.get(p);
        if (!rec) {
          rec = this._newRec(p, source, st);
          this.files.set(p, rec);
          // 运行中新出现的文件：今天改过的从头读（定位到今天），否则只记位置
          if (st.mtimeMs >= dayStart) {
            rec.hot = true;
            const from = await this._findStart(p, st.size, dayStart - SEEK_MARGIN_MS);
            await this._read(rec, from, st.size);
          } else {
            rec.pos = st.size;
          }
          continue;
        }
        await this._update(rec, st, now, dayStart);
      }
    }
    // 对账：文件已经被删除的，不再保留读取位置；目录缓存里已经不可达的也一并清掉
    for (const p of [...this.files.keys()]) {
      if (!seenPaths.has(p)) this.files.delete(p);
    }
    for (const d of [...this.dirCache.keys()]) {
      if (!seenDirs.has(d)) this.dirCache.delete(d);
    }
    // 会话索引也按当前文件集合对账：已删除的 Claude 会话不能再被 Magpie 去重永久跳过
    this.claudeIds.clear();
    for (const rec of this.files.values()) {
      if (rec.source === 'claude' && !rec.path.includes(`${path.sep}subagents${path.sep}`)) {
        this.claudeIds.add(path.basename(rec.path, '.jsonl'));
      }
    }
    for (const rec of this.files.values()) rec.hot = now - rec.mtimeMs < HOT_KEEP_MS || rec.mtimeMs >= dayStart;
    this.stats.filesKnown = this.files.size;
    this.stats.lastScanMs = performance.now() - t0;
  }

  async _update(rec, st, now, dayStart) {
    if (!rec) return;
    // 大小、修改时间、inode 都没变：什么都不做（最常见；末尾半行也不会被反复重读）
    if (st.size === rec.size && st.ino === rec.ino && st.mtimeMs === rec.mtimeMs) return;
    if (st.ino !== rec.ino || st.size < rec.pos) {
      // 文件被替换或截断：从头重读（Claude 有消息 id 去重，不会重复计数）
      rec.ino = st.ino;
      rec.pos = 0;
      rec.ctx = { fallbackSid: rec.ctx.fallbackSid, sid: '', label: '', lastCodex: null, metaSeen: false };
    }
    rec.mtimeMs = st.mtimeMs;
    rec.size = st.size;
    if (st.mtimeMs >= dayStart || now - st.mtimeMs < HOT_KEEP_MS) rec.hot = true;
    if (st.size > rec.pos) await this._read(rec, rec.pos, st.size);
  }

  // 二分定位：找到第一条时间 >= target 的行附近的字节位置（日志基本按时间追加）
  async _findStart(p, size, target) {
    return findStartOffset(p, size, target, TS_KEY);
  }

  // Magpie 去重用：Claude Code 会话文件名就是会话 id（含今天之前的文件）
  hasClaudeSession(id) {
    return this.claudeIds.has(id);
  }

  async _read(rec, from, to) {
    let fh;
    try { fh = await fsp.open(rec.path, 'r'); } catch { return; }
    try {
      // Codex 从中间开始读时，先单独读第一行拿会话 id 和 cwd
      if (rec.source === 'codex' && !rec.ctx.metaSeen && from > 0) await this._readCodexMeta(fh, rec);
      this.stats.filesRead++;
      const events = [];
      const patterns = rec.source === 'claude' ? CLAUDE_PATTERNS : CODEX_PATTERNS;
      const parse = rec.source === 'claude' ? parseClaudeLine : parseCodexLine;
      const ctx = rec.ctx;
      const consumed = await readLines(fh, from, to, (line) => {
        if (!lineMatches(line, patterns)) return;
        this.stats.linesParsed++;
        const evs = parse(line.toString('utf8'), ctx);
        for (const e of evs) events.push(e);
      }, this.stats);
      rec.pos = consumed;
      if (events.length) this.onEvents(events);
    } finally {
      await fh.close();
    }
  }

  async _readCodexMeta(fh, rec) {
    const line = await readFirstLine(fh, 16 << 20);
    if (!line) return;
    try {
      const d = JSON.parse(line.toString('utf8'));
      if (d && d.type === 'session_meta' && d.payload) applyCodexMeta(d.payload, rec.ctx);
    } catch { /* 忽略 */ }
    rec.ctx.metaSeen = true;
  }
}

// 从 from 读到 to，按行回调；返回最后一个完整行之后的位置（半行不算）
export async function readLines(fh, from, to, onLine, stats) {
  let pos = from;
  let consumed = from;
  let carry = null;
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, to - from)));
  while (pos < to) {
    const want = Math.min(buf.length, to - pos);
    const { bytesRead } = await fh.read(buf, 0, want, pos);
    if (!bytesRead) break;
    pos += bytesRead;
    if (stats) stats.bytesRead += bytesRead;
    const chunk = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      if (nl > start) onLine(chunk.subarray(start, nl));
      start = nl + 1;
    }
    const rest = chunk.length - start;
    consumed = pos - rest;
    if (rest === 0) carry = null;
    else if (rest > MAX_LINE) {
      // 超长行：不解析，直接跳到它后面的换行
      carry = null;
      const skipTo = await skipToNewline(fh, pos, to);
      if (skipTo === -1) return consumed; // 这行还没写完，下次从行首再看
      pos = skipTo;
      consumed = skipTo;
    } else carry = Buffer.from(chunk.subarray(start));
  }
  return consumed;
}

async function skipToNewline(fh, from, to) {
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = from;
  while (pos < to) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, to - pos), pos);
    if (!bytesRead) break;
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    if (nl !== -1) return pos + nl + 1;
    pos += bytesRead;
  }
  return -1;
}

async function readFirstLine(fh, limit) {
  const parts = [];
  let total = 0;
  const buf = Buffer.allocUnsafe(256 * 1024);
  while (total < limit) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, total);
    if (!bytesRead) return null;
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    if (nl !== -1) {
      parts.push(Buffer.from(buf.subarray(0, nl)));
      return Buffer.concat(parts);
    }
    parts.push(Buffer.from(buf.subarray(0, bytesRead)));
    total += bytesRead;
  }
  return null;
}

// 在 off 处取一个窗口，跳过半行，找第一个结构层的 "timestamp":"..."
async function probeTimestamp(fh, off, size, key) {
  let win = 256 * 1024;
  while (win <= 8 << 20) {
    const len = Math.min(win, size - off);
    if (len <= 0) return null;
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, off);
    const b = buf.subarray(0, bytesRead);
    const nl = b.indexOf(10);
    if (nl !== -1) {
      const i = b.indexOf(key, nl + 1);
      if (i !== -1) {
        const s = i + key.length;
        const e = b.indexOf(34, s); // 下一个双引号
        if (e !== -1 && e - s < 40) {
          const ts = Date.parse(b.toString('latin1', s, e));
          if (Number.isFinite(ts)) return ts;
        }
      }
    }
    if (len < win) return null; // 到文件尾了
    win *= 4;
  }
  return null;
}

// 二分定位：找到第一条时间 >= target 的行附近的字节位置（日志基本按时间追加）。
// key 是时间字段的字节串，例如 '"timestamp":"'、'"ts":"'
export async function findStartOffset(p, size, target, key) {
  if (size < SEEK_MIN_SIZE) return 0;
  let fh;
  try { fh = await fsp.open(p, 'r'); } catch { return 0; }
  try {
    let lo = 0, hi = size;
    while (hi - lo > SEEK_STOP) {
      const mid = Math.floor((lo + hi) / 2);
      const ts = await probeTimestamp(fh, mid, size, key);
      if (ts !== null && ts < target) lo = mid; else hi = mid;
    }
    if (lo === 0) return 0;
    // 从 lo 之后的第一个行首开始
    const buf = Buffer.allocUnsafe(64 * 1024);
    let off = lo;
    while (off < size) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, off);
      if (!bytesRead) break;
      const nl = buf.subarray(0, bytesRead).indexOf(10);
      if (nl !== -1) return off + nl + 1;
      off += bytesRead;
    }
    return 0;
  } finally {
    await fh.close();
  }
}
