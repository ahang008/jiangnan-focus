"""专注判定实测：读取本机 Claude Code 与 Codex 会话记录里的 token 用量，按拟定规则回放某一天。

只读日志，只输出统计数字，不输出任何对话内容。
用法: python3 reference_focus_probe.py [YYYY-MM-DD 本地日期，默认今天] [--active 3] [--segment 25] [--gap 5]
"""
import argparse, glob, json, os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser('~')
LOCAL_TZ = datetime.now().astimezone().tzinfo


def parse_ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(LOCAL_TZ)


def claude_events(day_start, day_end):
    """Claude Code：assistant 消息的 usage，按 message.id 去重；子代理归入父会话。"""
    seen = set()
    for f in glob.glob(f'{HOME}/.claude/projects/**/*.jsonl', recursive=True):
        if os.path.getmtime(f) < day_start.timestamp():
            continue
        with open(f, encoding='utf-8', errors='ignore') as fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get('type') != 'assistant' or 'timestamp' not in d:
                    continue
                msg = d.get('message') or {}
                mid = msg.get('id')
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                t = parse_ts(d['timestamp'])
                if not (day_start <= t < day_end):
                    continue
                u = msg.get('usage') or {}
                work = u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('output_tokens', 0)
                yield t, 'claude:' + d.get('sessionId', f), work, u.get('cache_read_input_tokens', 0)


def codex_events(day_start, day_end):
    """Codex：token_count 事件里的 last_token_usage。"""
    for f in glob.glob(f'{HOME}/.codex/sessions/**/*.jsonl', recursive=True):
        if os.path.getmtime(f) < day_start.timestamp():
            continue
        sid = os.path.basename(f)
        with open(f, encoding='utf-8', errors='ignore') as fh:
            for line in fh:
                if '"token_count"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                info = (d.get('payload') or {}).get('info') or d.get('info') or {}
                last = info.get('last_token_usage')
                if not last or 'timestamp' not in d:
                    continue
                t = parse_ts(d['timestamp'])
                if not (day_start <= t < day_end):
                    continue
                cached = last.get('cached_input_tokens', 0)
                work = last.get('input_tokens', 0) - cached + last.get('output_tokens', 0)
                yield t, 'codex:' + sid, max(work, 0), cached


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('day', nargs='?', default=datetime.now().strftime('%Y-%m-%d'))
    ap.add_argument('--active', type=float, default=3, help='会话最近几分钟有 token 就算在干活')
    ap.add_argument('--segment', type=float, default=25, help='连续专注多少分钟算完成一段')
    ap.add_argument('--gap', type=float, default=5, help='停顿超过几分钟这一段作废')
    a = ap.parse_args()
    day_start = datetime.strptime(a.day, '%Y-%m-%d').replace(tzinfo=LOCAL_TZ)
    day_end = day_start + timedelta(days=1)
    ev = sorted(list(claude_events(day_start, day_end)) + list(codex_events(day_start, day_end)))
    if not ev:
        print('这一天没有记录'); return

    per_src = defaultdict(lambda: [0, 0, set()])
    for t, s, w, c in ev:
        p = per_src[s.split(':')[0]]; p[0] += w; p[1] += c; p[2].add(s)

    # 每分钟：哪些会话在干活（最近 active 分钟内有 token）
    last_seen = {}
    minute = day_start.replace(second=0, microsecond=0)
    end = min(day_end, datetime.now(LOCAL_TZ))
    i = 0; timeline = []
    while minute < end:
        nxt = minute + timedelta(minutes=1)
        while i < len(ev) and ev[i][0] < nxt:
            last_seen[ev[i][1]] = ev[i][0]; i += 1
        active = [s for s, ts in last_seen.items() if (nxt - ts) <= timedelta(minutes=a.active)]
        timeline.append((minute, len(active)))
        minute = nxt

    # 专注段：在干活就累计；停顿不超过 gap 分钟算连着，超过就作废重来
    segs, run_start, focused, idle = [], None, 0, 0
    for m, n in timeline:
        if n > 0:
            if run_start is None:
                run_start, focused = m, 0
            focused += 1; idle = 0
            if focused >= a.segment:
                segs.append((run_start, m)); run_start, focused = None, 0
        elif run_start is not None:
            idle += 1
            if idle > a.gap:
                run_start, focused, idle = None, 0, 0

    busy = [n for _, n in timeline if n > 0]
    print(f'日期 {a.day}  规则: {a.active} 分钟内有 token 算在干活 / 满 {a.segment} 分钟一段 / 停顿超 {a.gap} 分钟作废')
    for k, (w, c, ss) in per_src.items():
        print(f'  {k}: 会话 {len(ss)} 个, 干活 token {w:,}, 缓存读取 {c:,}')
    print(f'  有 AI 在干活的分钟数: {len(busy)}  同时在干活的会话最多 {max(busy) if busy else 0} 个, 平均 {sum(busy)/max(1,len(busy)):.1f} 个')
    print(f'  完成专注段: {len(segs)} 段')
    for s, e in segs:
        print(f'    {s:%H:%M} - {e:%H:%M}')
    # 按小时的并发峰值，方便看船会不会挤
    hours = defaultdict(int)
    for m, n in timeline:
        hours[m.hour] = max(hours[m.hour], n)
    print('  每小时同时在干活的会话峰值: ' + ' '.join(f'{h:02d}点={n}' for h, n in sorted(hours.items()) if n))


if __name__ == '__main__':
    main()
