// 引擎：把日志事件、键鼠空闲、专注状态机、奖励、存档拼在一起，产出 DESIGN.md 第七节的 state 和 beat。
// 时钟全部由调用方传入（now 参数），测试里可以用假时钟快进。
import { EventEmitter } from 'node:events';
import { sanitizeSettings, mergeSettings, PRESENT_IDLE_SEC, SOURCES } from './config.mjs';
import { startOfDay, dayKey, floorMinute } from './localday.mjs';
import { FocusMachine } from './focus.mjs';
import { Rewards } from './rewards.mjs';

export const SERVICE_NAME = 'jiangnan-focus';
export const GRACE_MS = 15000; // 一分钟结束后再等 15 秒才结算，等晚到的日志
const BEAT_MAX_AGE_MS = 120000; // 超过 2 分钟的旧事件不再发 beat
const ENDED_VISIBLE_MS = 3600000; // 结束超过 1 小时的会话不再返回
const ENDED_FORGET_MS = 24 * 3600000;
const MAX_SESSIONS_OUT = 30;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const MAX_CATCHUP_MS = 2 * 24 * 3600000;
const BEAT_ORDER = { session_start: 0, tool: 1, file: 2, subagent: 3, session_end: 4, segment_done: 5 };

export class Engine extends EventEmitter {
  constructor({ saved = null, store = null, now = Date.now(), rng } = {}) {
    super();
    this.store = store;
    this.settings = sanitizeSettings(saved && saved.settings);
    this.rewards = new Rewards(saved, rng);
    const dayStart = startOfDay(now);
    let fsaved = saved && saved.focus && typeof saved.focus === 'object' ? { ...saved.focus } : null;
    if (fsaved && typeof fsaved.lastMinute === 'number') {
      if (fsaved.lastMinute > floorMinute(now)) fsaved.lastMinute = floorMinute(now); // 时钟往回拨了
      if (now - fsaved.lastMinute > MAX_CATCHUP_MS) fsaved = null; // 太久没开：从今天零点重新算
    } else fsaved = null;
    this.focus = new FocusMachine(fsaved, dayStart);
    this.replayFloor = dayStart; // 启动回放只认今天的记录
    this.live = false;
    this.sessions = new Map();
    this.seen = new Map(); // 去重键 -> 时间
    this.workTimes = [];
    this.workSorted = true;
    this.tokensByDay = new Map();
    this.srcDays = new Map(); // 日期 -> 来源 -> { tokens, tools, sids }
    this.idle = { idleSec: 0, present: true, presentUnknown: true, at: 0 };
    this.samples = [];
    this.pendingBeats = [];
    // 每份 state 带单调递增的 rev 和本次启动的 boot：网页据此丢掉迟到的旧快照
    this.rev = 0;
    this.boot = Math.random().toString(36).slice(2, 10) + now.toString(36);
    // 当天聚合和会话最小快照：日志缺失/来源停用时恢复显示，避免旧专注与新零值混在一起
    this.savedToday = saved && saved.today && typeof saved.today === 'object' ? saved.today : null;
    // 今天哪些来源的日志当前不可用、已从快照恢复；以及按会话恢复的明细（用于日志回来后对账）
    this.missingSources = new Set();
    this.restoredSessions = new Map(); // sid -> { source, counted }；counted=false 表示该会话统计是按会话单独补进来源聚合的
  }

  markLive() {
    this.live = true;
  }

  // ---------- 日志事件 ----------
  ingest(events, now) {
    // 启动时用快照补过缺失来源/会话，之后对应日志真回来了：先把快照补进去的统计撤掉，再按真实日志重算，避免重复计数。
    if (this.missingSources.size || this.restoredSessions.size) {
      const dk = dayKey(now);
      const incomingSources = new Set();
      for (const e of events) if (e.source) incomingSources.add(e.source);
      for (const src of incomingSources) {
        if (this.missingSources.has(src)) this._removeRestoredSource(src, dk);
      }
      for (const e of events) {
        if (e.sid && this.restoredSessions.has(e.sid)) this._removeRestoredSession(e.sid, dk);
      }
    }
    const floor = this.live ? startOfDay(now) - 10 * 60000 : this.replayFloor;
    const endMs = this.settings.endMin * 60000;
    for (const e of events) {
      if (!(e.ts >= floor)) continue;
      if (e.key) {
        if (this.seen.has(e.key)) continue;
        this.seen.set(e.key, e.ts);
      }
      let s = this.sessions.get(e.sid);
      if (!s) {
        s = {
          id: e.sid, source: e.source, label: e.label || '', startedAt: e.ts, lastAt: e.ts,
          tools: 0, files: 0, subagents: 0, tokens: 0, ended: false, endedAt: 0,
        };
        this.sessions.set(e.sid, s);
        this._queueBeat({ kind: 'session_start', session: s.id, tool: null, label: s.label, source: s.source }, e.ts, now);
      } else if (s.ended && now - e.ts <= endMs) {
        // 结束后又动了：重新开船
        if (e.ts - s.lastAt > endMs) s.startedAt = e.ts;
        s.ended = false;
        s.endedAt = 0;
        this._queueBeat({ kind: 'session_start', session: s.id, tool: null, label: s.label, source: s.source }, e.ts, now);
      }
      if (e.ts > s.lastAt) s.lastAt = e.ts;
      if (e.ts < s.startedAt) s.startedAt = e.ts;
      if (!s.label && e.label) s.label = e.label;
      const dk0 = dayKey(e.ts);
      let day = this.srcDays.get(dk0);
      if (!day) { day = new Map(); this.srcDays.set(dk0, day); }
      let agg = day.get(s.source);
      if (!agg) { agg = { tokens: 0, tools: 0, sids: new Set() }; day.set(s.source, agg); }
      agg.sids.add(s.id);
      if (e.kind === 'usage') agg.tokens += e.tokens;
      else if (e.kind === 'tool') agg.tools += 1;
      if (e.kind === 'usage') {
        s.tokens += e.tokens;
        const dk = dayKey(e.ts);
        this.tokensByDay.set(dk, (this.tokensByDay.get(dk) || 0) + e.tokens);
      } else if (e.kind === 'tool') {
        s.tools += 1;
        this._queueBeat({ kind: 'tool', session: s.id, tool: e.tool }, e.ts, now);
        if (e.isFile) {
          s.files += 1;
          this._queueBeat({ kind: 'file', session: s.id, tool: e.tool }, e.ts, now);
        }
        if (e.isSubagent) {
          s.subagents += 1;
          this._queueBeat({ kind: 'subagent', session: s.id, tool: e.tool }, e.ts, now);
        }
      }
      if (this.workTimes.length && e.ts < this.workTimes[this.workTimes.length - 1]) this.workSorted = false;
      this.workTimes.push(e.ts);
    }
  }

  // ---------- 键鼠空闲 ----------
  setIdle(sample, now) {
    const ok = !!(sample && sample.ok);
    const idleSec = ok ? Math.max(0, Math.floor(sample.idleSec)) : 0;
    const present = !ok || idleSec < PRESENT_IDLE_SEC;
    this.idle = { idleSec, present, presentUnknown: !ok, at: now };
    this.samples.push({ t: now, present });
    while (this.samples.length && this.samples[0].t < now - 5 * 60000) this.samples.shift();
  }

  _presentDuring(a, b) {
    for (const s of this.samples) if (s.t > a && s.t <= b && s.present) return true;
    return false;
  }

  _anyWorkIn(a, b) {
    // [a, b) 区间内是否有干活记录
    if (!this.workSorted) {
      this.workTimes.sort((x, y) => x - y);
      this.workSorted = true;
    }
    const w = this.workTimes;
    let lo = 0, hi = w.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (w[m] < a) lo = m + 1; else hi = m;
    }
    return lo < w.length && w[lo] < b;
  }

  // ---------- 推进 ----------
  tick(now) {
    const st = this.settings;
    const act = st.activeMin * 60000;
    let changed = false;
    while (this.focus.lastMinute + 60000 <= now - GRACE_MS) {
      const B = this.focus.lastMinute + 60000;
      const aiActive = this._anyWorkIn(B - act, B);
      const present = this._presentDuring(B - 60000, B + GRACE_MS);
      const r = this.focus.step(B, { aiActive, present }, st);
      if (r.segmentDone) {
        this.rewards.grant(1);
        this._queueBeat({ kind: 'segment_done', session: null, tool: null }, B, now);
      }
      changed = true;
    }
    // 会话结束
    const endMs = st.endMin * 60000;
    for (const [id, s] of this.sessions) {
      if (!s.ended && now - s.lastAt > endMs) {
        s.ended = true;
        s.endedAt = s.lastAt + endMs;
        this._queueBeat({ kind: 'session_end', session: s.id, tool: null }, s.endedAt, now);
      }
      if (s.ended && now - s.endedAt > ENDED_FORGET_MS) this.sessions.delete(id);
    }
    // 清理（每推进一分钟做一次）：去重键留 26 小时，干活时间只留最近 1 小时多一点
    if (!changed) return false;
    const seenFloor = now - 26 * 3600000;
    for (const [k, t] of this.seen) if (t < seenFloor) this.seen.delete(k);
    if (this.workTimes.length > 1000) {
      if (!this.workSorted) { this.workTimes.sort((x, y) => x - y); this.workSorted = true; }
      const keepFrom = Math.min(this.focus.lastMinute, now) - 65 * 60000;
      let i = 0;
      while (i < this.workTimes.length && this.workTimes[i] < keepFrom) i++;
      if (i) this.workTimes.splice(0, i);
    }
    const today = dayKey(now);
    const yesterday = dayKey(startOfDay(now) - 1);
    for (const k of this.tokensByDay.keys()) if (k !== today && k !== yesterday) this.tokensByDay.delete(k);
    for (const k of this.srcDays.keys()) if (k !== today && k !== yesterday) this.srcDays.delete(k);
    this.save(now);
    return true;
  }

  // ---------- beat ----------
  _queueBeat(b, ts, now) {
    if (!this.live || now - ts > BEAT_MAX_AGE_MS) return;
    this.pendingBeats.push({ ...b, at: ts });
  }

  // 合并：同一会话、同一种、同名工具在 1 秒内的 beat 合成一条，count 为次数
  flushBeats() {
    if (!this.pendingBeats.length) return [];
    const list = this.pendingBeats
      .map((b, i) => ({ b, i }))
      .sort((x, y) => x.b.at - y.b.at || BEAT_ORDER[x.b.kind] - BEAT_ORDER[y.b.kind] || x.i - y.i)
      .map((x) => x.b);
    this.pendingBeats = [];
    const out = [];
    const open = new Map();
    for (const b of list) {
      if (b.kind === 'tool' || b.kind === 'file' || b.kind === 'subagent') {
        const k = `${b.session}|${b.kind}|${b.tool}`;
        const g = open.get(k);
        if (g && b.at - g.at < 1000) { g.count += 1; continue; }
        const ng = { ...b, count: 1 };
        open.set(k, ng);
        out.push(ng);
      } else {
        out.push({ ...b, count: 1 });
      }
    }
    for (const b of out) this.emit('beat', b);
    return out;
  }

  // ---------- 奖励和设置 ----------
  offerRewards(now = Date.now()) {
    const had = this.rewards.offerIds;
    const r = this.rewards.offer();
    if (had !== this.rewards.offerIds) this.save(now);
    return r;
  }

  chooseReward(id, now = Date.now()) {
    const r = this.rewards.choose(id);
    this.save(now);
    return r;
  }

  // 专注归零：只清今天的专注统计和当前段；今天的 token 来自日志，收藏和奖励不受影响
  resetFocus(now = Date.now()) {
    this.focus.resetToday();
    this.save(now);
    return this.getState(now);
  }

  updateSettings(patch, now = Date.now()) {
    const r = mergeSettings(this.settings, patch);
    if (r.errors) return r;
    this.settings = r.settings;
    this.save(now);
    return r;
  }

  save(now = Date.now()) {
    if (!this.store) return;
    this.store.save({
      version: 1,
      savedAt: now,
      settings: this.settings,
      ...this.rewards.snapshot(),
      focus: this.focus.snapshot(),
      today: this._todaySnapshot(now),
    });
  }

  _sourceAgg(dk, src) {
    const day = this.srcDays.get(dk);
    return (day && day.get(src)) || null;
  }

  // 存档里的当天最小快照：只存聚合和会话统计，绝不存正文
  _todaySnapshot(now) {
    const dk = dayKey(now);
    const bySource = {};
    for (const src of SOURCES) {
      const a = this._sourceAgg(dk, src);
      bySource[src] = {
        tokens: a ? a.tokens : 0,
        tools: a ? a.tools : 0,
        sids: a ? [...a.sids] : [],
      };
    }
    return {
      day: dk,
      tokens: this.tokensByDay.get(dk) || 0,
      bySource,
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.id, source: s.source, label: s.label, startedAt: s.startedAt, lastAt: s.lastAt,
        tools: s.tools, files: s.files, subagents: s.subagents, tokens: s.tokens, ended: s.ended, endedAt: s.endedAt,
      })),
    };
  }

  // 启动回放后调用：把「日志缺失」的当天水牌和船按快照补回来，避免旧专注与新的零值混在一起。
  // 按来源和会话做幂等合并：某个来源今天一条日志都没回放到，就恢复该来源的快照聚合和会话；
  // 某个来源只回放到部分会话（例如单文件删除），就只补回缺失的会话及其统计。
  restoreTodayIfMissing(now) {
    const dk = dayKey(now);
    this.missingSources.clear();
    this.restoredSessions.clear();
    const snap = this.savedToday;
    if (!snap || snap.day !== dk) return false;
    const hasData = (snap.tokens || 0) > 0 ||
      (Array.isArray(snap.sessions) && snap.sessions.length > 0) ||
      (snap.bySource && typeof snap.bySource === 'object' &&
        Object.values(snap.bySource).some((x) => x && ((x.tokens || 0) > 0 || (x.tools || 0) > 0 || (Array.isArray(x.sids) && x.sids.length > 0))));
    if (!hasData) return false;

    let restored = false;
    // 第一步：整来源缺失的，恢复该来源的快照聚合。
    if (snap.bySource && typeof snap.bySource === 'object') {
      for (const src of SOURCES) {
        const b = snap.bySource[src];
        if (!b) continue;
        const tokens = num(b.tokens);
        const tools = num(b.tools);
        const sids = Array.isArray(b.sids) ? b.sids.filter((x) => typeof x === 'string') : [];
        if (!tokens && !tools && !sids.length) continue;
        if (this._sourceAgg(dk, src)) continue; // 今天已经回放到该来源，以日志为准
        let day = this.srcDays.get(dk);
        if (!day) { day = new Map(); this.srcDays.set(dk, day); }
        day.set(src, { tokens, tools, sids: new Set(sids) });
        this.tokensByDay.set(dk, (this.tokensByDay.get(dk) || 0) + tokens);
        this.missingSources.add(src);
        restored = true;
      }
    }
    // 第二步：会话级合并。整来源缺失的会话由第一步的聚合覆盖（不重复计 token）；来源仍在、只是个别会话缺失的，把该会话统计补进去。
    if (Array.isArray(snap.sessions)) {
      for (const sn of snap.sessions) {
        if (!sn || typeof sn.id !== 'string' || this.sessions.has(sn.id)) continue;
        const source = SOURCES.includes(sn.source) ? sn.source : 'claude';
        const countedInAgg = this.missingSources.has(source);
        this.sessions.set(sn.id, {
          id: sn.id, source, label: sn.label || '', startedAt: num(sn.startedAt), lastAt: num(sn.lastAt),
          tools: num(sn.tools), files: num(sn.files), subagents: num(sn.subagents), tokens: num(sn.tokens),
          ended: !!sn.ended, endedAt: num(sn.endedAt),
        });
        if (!countedInAgg) {
          let day = this.srcDays.get(dk);
          if (!day) { day = new Map(); this.srcDays.set(dk, day); }
          let agg = day.get(source);
          if (!agg) { agg = { tokens: 0, tools: 0, sids: new Set() }; day.set(source, agg); }
          agg.tokens += num(sn.tokens);
          agg.tools += num(sn.tools);
          agg.sids.add(sn.id);
          this.tokensByDay.set(dk, (this.tokensByDay.get(dk) || 0) + num(sn.tokens));
        }
        this.restoredSessions.set(sn.id, { source, counted: countedInAgg });
        restored = true;
      }
    }
    return restored;
  }

  // 整来源的快照恢复被真实日志取代：撤掉该来源的快照聚合和快照会话，让 ingest 按日志重算。
  _removeRestoredSource(src, dk) {
    const day = this.srcDays.get(dk);
    const agg = day && day.get(src);
    if (agg) {
      this.tokensByDay.set(dk, Math.max(0, (this.tokensByDay.get(dk) || 0) - (agg.tokens || 0)));
      if (day) day.delete(src);
    }
    for (const [sid, rec] of this.restoredSessions) {
      if (rec.source === src) {
        if (this.sessions.has(sid)) this.sessions.delete(sid);
        this.restoredSessions.delete(sid);
      }
    }
    this.missingSources.delete(src);
  }

  // 单会话的快照恢复被真实日志取代：从该来源聚合里撤掉这条会话的统计。
  _removeRestoredSession(sid, dk) {
    const rec = this.restoredSessions.get(sid);
    if (!rec) return;
    const s = this.sessions.get(sid);
    if (s) {
      const day = this.srcDays.get(dk);
      const agg = day && day.get(rec.source);
      if (agg) {
        agg.tokens = Math.max(0, (agg.tokens || 0) - (s.tokens || 0));
        agg.tools = Math.max(0, (agg.tools || 0) - (s.tools || 0));
        agg.sids.delete(sid);
      }
      this.tokensByDay.set(dk, Math.max(0, (this.tokensByDay.get(dk) || 0) - (s.tokens || 0)));
      this.sessions.delete(sid);
    }
    this.restoredSessions.delete(sid);
  }

  // 今日水牌：六个平台各自的 token、会话数、工具调用数（没有的给 0）
  _bySource(dk) {
    const out = {};
    for (const src of SOURCES) {
      const a = this._sourceAgg(dk, src);
      out[src] = { tokens: a ? a.tokens : 0, sessions: a ? a.sids.size : 0, tools: a ? a.tools : 0 };
    }
    return out;
  }

  hasClaudeSession(id) {
    return this.sessions.has('claude:' + id);
  }

  // ---------- 输出 ----------
  getState(now) {
    const st = this.settings;
    const act = st.activeMin * 60000;
    const sessions = [...this.sessions.values()]
      .filter((s) => !s.ended || now - s.endedAt <= ENDED_VISIBLE_MS)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, MAX_SESSIONS_OUT)
      .map((s) => ({
        id: s.id, source: s.source, label: s.label, startedAt: s.startedAt, lastAt: s.lastAt,
        active: !s.ended && now - s.lastAt <= act,
        tools: s.tools, files: s.files, subagents: s.subagents, tokens: s.tokens,
        ended: s.ended,
      }));
    // 船头木牌：去掉日期前缀、最多 6 个字；同名的按开始时间编号（项目、项目二、项目三），一眼分得清是哪条船
    const short = (l) => { const x = String(l || '').replace(/^\d{4}-\d{1,2}-\d{1,2}[\s_-]*/, '').trim() || String(l || '会话'); return [...x].slice(0, 6).join(''); };
    const NUM = ['', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    const groups = new Map();
    for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
      const k = short(s.label); const n = (groups.get(k) || 0) + 1; groups.set(k, n);
      s.folder = s.label; s.label = n === 1 ? k : k + (NUM[n - 1] || String(n));
    }
    const t = this.focus.todayFor(now);
    const aiNow = this._anyWorkIn(now - act, Infinity);
    const focusing = aiNow && (!st.presentOnly || this.idle.present);
    const seg = this.focus.segment;
    let progress = seg.progress;
    if (focusing) {
      const frac = Math.min(0.99, Math.max(0, (now - this.focus.lastMinute) / 60000));
      progress = Math.min(st.segmentMin, progress + frac);
    }
    const r = this.rewards;
    this.rev += 1;
    return {
      rev: this.rev,
      boot: this.boot,
      service: SERVICE_NAME,
      now,
      present: this.idle.present,
      idleSec: this.idle.idleSec,
      presentUnknown: this.idle.presentUnknown,
      sessions,
      today: {
        tokens: this.tokensByDay.get(dayKey(now)) || 0,
        aiMinutes: t.aiMinutes,
        presentFocusMin: t.presentFocusMin,
        soloFocusMin: t.soloFocusMin,
        segments: t.segments,
        day: t.day,
        bySource: this._bySource(dayKey(now)),
        logsMissing: this.missingSources.size > 0 || this.restoredSessions.size > 0,
        logsMissingSources: [...new Set([
          ...this.missingSources,
          ...[...this.restoredSessions.values()].map((r) => r.source),
        ])],
      },
      segment: {
        progressMin: Math.round(progress * 10) / 10,
        targetMin: st.segmentMin,
        idleMin: seg.idle,
      },
      focusing,
      pendingRewards: r.pending,
      owned: [...r.owned],
      lanternLevel: r.lanternLevel,
      settings: { ...st },
    };
  }
}
