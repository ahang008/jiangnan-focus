// 专注状态机（纯逻辑，不碰时钟和文件，便于单测）。
// 按分钟推进：调用方对每个已结束的分钟调用一次 step(分钟结束时刻, {aiActive, present}, settings)。
// 规则（DESIGN.md 第三节）：
// - 专注中 = 有会话在干活；presentOnly 打开时还要人在场
// - 专注的分钟：segment.progress + 1；在场记 presentFocusMin，否则记 soloFocusMin
// - 不专注的分钟：已开始的一段累计 idle，超过 gapMin 就清零这一段
// - progress 满 segmentMin：segments + 1，返回 segmentDone，这一段清零
// - 过本地零点：today 归零（segment 不受影响）
import { dayKey } from './localday.mjs';

export function emptyToday(day) {
  return { day, aiMinutes: 0, presentFocusMin: 0, soloFocusMin: 0, segments: 0 };
}

export class FocusMachine {
  constructor(saved, startMinute) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const okNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const t = s.today && typeof s.today === 'object' ? s.today : {};
    this.today = {
      day: typeof t.day === 'string' ? t.day : dayKey(startMinute),
      aiMinutes: okNum(t.aiMinutes),
      presentFocusMin: okNum(t.presentFocusMin),
      soloFocusMin: okNum(t.soloFocusMin),
      segments: okNum(t.segments),
    };
    const g = s.segment && typeof s.segment === 'object' ? s.segment : {};
    this.segment = { running: !!g.running, progress: okNum(g.progress), idle: okNum(g.idle) };
    this.lastMinute = typeof s.lastMinute === 'number' && Number.isFinite(s.lastMinute) ? s.lastMinute : startMinute;
  }

  // minuteEnd：这一分钟的结束时刻（毫秒，整分钟）
  step(minuteEnd, { aiActive, present }, settings) {
    const day = dayKey(minuteEnd - 1);
    if (day !== this.today.day) this.today = emptyToday(day);
    this.lastMinute = minuteEnd;
    const focus = !!aiActive && (!settings.presentOnly || !!present);
    if (aiActive) this.today.aiMinutes += 1;
    const seg = this.segment;
    if (focus) {
      if (!seg.running) { seg.running = true; seg.progress = 0; }
      seg.progress += 1;
      seg.idle = 0;
      if (present) this.today.presentFocusMin += 1; else this.today.soloFocusMin += 1;
      if (seg.progress >= settings.segmentMin) {
        this.today.segments += 1;
        this._reset();
        return { focus, segmentDone: true };
      }
    } else if (seg.running) {
      seg.idle += 1;
      if (seg.idle > settings.gapMin) this._reset();
    }
    return { focus, segmentDone: false };
  }

  _reset() {
    this.segment = { running: false, progress: 0, idle: 0 };
  }

  // 专注归零：清今天的在场专注、AI 独航、成段和当前这一段；AI 干活分钟（来自日志）不动
  resetToday() {
    this.today.presentFocusMin = 0;
    this.today.soloFocusMin = 0;
    this.today.segments = 0;
    this._reset();
  }

  todayFor(nowMs) {
    // 过零点但还没推进到新的一分钟时，today 显示为 0
    const d = dayKey(nowMs);
    return d === this.today.day ? this.today : emptyToday(d);
  }

  snapshot() {
    return { today: { ...this.today }, segment: { ...this.segment }, lastMinute: this.lastMinute };
  }
}
