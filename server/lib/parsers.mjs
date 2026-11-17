// 日志行解析：把一行 JSON 变成只含统计信息的事件。
// 只取：时间戳、会话 id、token 数、工具名、工具调用 id（去重用）、cwd 最后一级。
// 对话正文、代码、命令参数一律不取，解析后的对象用完即丢。
import path from 'node:path';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const CODEX_FILE_TOOLS = new Set(['apply_patch']);
const CODEX_SUBAGENT_TOOLS = new Set(['spawn_agent']);

// 行级预筛：不含这些字节的行直接跳过，不做 JSON 解析
export const CLAUDE_PATTERNS = [Buffer.from('"type":"assistant"')];
export const CODEX_PATTERNS = [
  Buffer.from('"session_meta"'),
  Buffer.from('"token_count"'),
  Buffer.from('"function_call"'),
  Buffer.from('"custom_tool_call"'),
];

export function lineMatches(buf, patterns) {
  for (const p of patterns) if (buf.indexOf(p) !== -1) return true;
  return false;
}

export function lastSegment(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function fallbackSessionId(file) {
  const m = UUID_RE.exec(file);
  return m ? m[1] : path.basename(file, '.jsonl');
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseTs(s) {
  if (typeof s !== 'string') return NaN;
  return Date.parse(s);
}

// Claude Code：assistant 行。返回事件数组（可能为空）
export function parseClaudeLine(text, ctx) {
  let d;
  try { d = JSON.parse(text); } catch { return []; }
  if (!d || d.type !== 'assistant') return [];
  const ts = parseTs(d.timestamp);
  if (!Number.isFinite(ts)) return [];
  const sid = 'claude:' + (typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : ctx.fallbackSid);
  const label = lastSegment(d.cwd);
  const msg = d.message && typeof d.message === 'object' ? d.message : {};
  const out = [];
  if (typeof msg.id === 'string' && msg.id) {
    const u = msg.usage && typeof msg.usage === 'object' ? msg.usage : {};
    const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
    out.push({ kind: 'usage', ts, sid, source: 'claude', label, tokens, key: 'cm:' + msg.id });
  }
  if (Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
      out.push({
        kind: 'tool', ts, sid, source: 'claude', label,
        tool: c.name,
        isFile: FILE_TOOLS.has(c.name),
        isSubagent: SUBAGENT_TOOLS.has(c.name),
        key: typeof c.id === 'string' && c.id ? 'ct:' + c.id : null,
      });
    }
  }
  return out;
}

// Codex：需要文件级上下文（会话 id 和 cwd 只在 session_meta 行里）
// ctx: { fallbackSid, sid, label, lastTotal }
export function parseCodexLine(text, ctx) {
  let d;
  try { d = JSON.parse(text); } catch { return []; }
  if (!d || typeof d !== 'object') return [];
  const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
  if (d.type === 'session_meta') {
    applyCodexMeta(p, ctx);
    return [];
  }
  const ts = parseTs(d.timestamp);
  if (!Number.isFinite(ts)) return [];
  const sid = 'codex:' + (ctx.sid || ctx.fallbackSid);
  const label = ctx.label || '';
  if ((d.type === 'event_msg' && p.type === 'token_count') || (d.type === 'token_count')) {
    const info = (p.info && typeof p.info === 'object' ? p.info : null) || (d.info && typeof d.info === 'object' ? d.info : null);
    const last = info && info.last_token_usage;
    if (!last || typeof last !== 'object') return [];
    // 去重：累计总量和「上一份用量」都没变才算同一份重复上报；
    // 累计总量下降后再次涨回旧值（上下文压缩/新阶段/日志乱序）不能靠累计值去重，要照常计数。
    const cum = info && info.total_token_usage ? num(info.total_token_usage.total_tokens) : 0;
    const cached = num(last.cached_input_tokens);
    const tokens = Math.max(0, num(last.input_tokens) - cached + num(last.output_tokens));
    const tuple = [num(last.input_tokens), cached, num(last.output_tokens), num(last.total_tokens)].join('|');
    const prev = ctx.lastCodex;
    if (prev && prev.cum === cum && prev.tuple === tuple) return [];
    ctx.lastCodex = { cum, tuple };
    const rid = (p.request_id && String(p.request_id)) || (d.request_id && String(d.request_id)) || (info && info.request_id && String(info.request_id));
    return [{ kind: 'usage', ts, sid, source: 'codex', label, tokens, key: rid ? 'xc:' + rid : null }];
  }
  if (d.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
    if (typeof p.name !== 'string' || !p.name) return [];
    return [{
      kind: 'tool', ts, sid, source: 'codex', label,
      tool: p.name,
      isFile: CODEX_FILE_TOOLS.has(p.name),
      isSubagent: CODEX_SUBAGENT_TOOLS.has(p.name),
      key: typeof p.call_id === 'string' && p.call_id ? 'xt:' + p.call_id : null,
    }];
  }
  return [];
}

// session_meta：子代理会话的 session_id 指向根会话，归到根会话那条船上
export function applyCodexMeta(p, ctx) {
  const id = (typeof p.session_id === 'string' && p.session_id) || (typeof p.id === 'string' && p.id) || '';
  if (id) ctx.sid = id;
  const isSub = !!(p.source && typeof p.source === 'object' && p.source.subagent);
  const label = lastSegment(p.cwd);
  if (label) ctx.label = label;
  ctx.isSubagent = isSub;
  ctx.metaSeen = true;
}
