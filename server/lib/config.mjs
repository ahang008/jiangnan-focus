import fs from 'node:fs';
// 配置：路径、环境变量、默认设置、奖励池常量、设置校验。
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(here, '..');

// Windows 的 AppData 目录：优先 APPDATA 环境变量，没有就用约定位置
export function appDataDir(home = os.homedir(), env = process.env) {
  return env.APPDATA || path.join(home, 'AppData', 'Roaming');
}

// Magpie 的用量文件可能在 ~/.config/magpie 或 %APPDATA%\magpie，两处都检查
export function magpieCandidates(home = os.homedir(), env = process.env) {
  return [
    path.join(home, '.config', 'magpie', 'usage.jsonl'),
    path.join(appDataDir(home, env), 'magpie', 'usage.jsonl'),
  ];
}

// 返回候选里第一个已存在的文件；都不存在返回 null（不报错，调用方跳过该来源）
export function existingFile(candidates) {
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* 忽略 */ }
  }
  return null;
}

// 六个来源的展示顺序和 SOURCES 一致，方便启动时打印“检测到的来源”
export function sourceEntries(cfg) {
  return SOURCES.map((id) => {
    const p = id === 'magpie' || id === 'cursor' ? cfg.magpieFile
      : id === 'claude' ? cfg.claudeDir
      : id === 'codex' ? cfg.codexDir
      : id === 'deepseek' ? cfg.dshDir
      : cfg.grokDir;
    return { id, label: SOURCE_LABELS[id], paths: p ? [p] : [] };
  });
}

export function loadConfig(env = process.env) {
  const home = os.homedir();
  const port = env.JN_PORT === undefined ? 4317 : Number(env.JN_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('JN_PORT 不是有效端口');
  // 环境变量显式设为空串 = 停用这个来源；未设置用默认路径。所有路径都用 os.homedir()/path.join 拼，不写死斜杠。
  const opt = (v, dflt) => {
    if (v === '') return null;
    if (v === undefined) return path.resolve(dflt);
    return path.resolve(v);
  };
  const claudeDir = opt(env.JN_CLAUDE_DIR, path.join(home, '.claude', 'projects'));
  const codexDir = opt(env.JN_CODEX_DIR, path.join(home, '.codex', 'sessions'));
  const dshDir = opt(env.JN_DSH_DIR, path.join(home, '.dsh', 'sessions'));
  const grokDir = opt(env.JN_GROK_DIR, path.join(home, '.grok'));
  let magpieFile;
  if (env.JN_MAGPIE_FILE !== undefined) {
    magpieFile = env.JN_MAGPIE_FILE === '' ? null : path.resolve(env.JN_MAGPIE_FILE);
  } else {
    const candidates = magpieCandidates(home, env);
    magpieFile = existingFile(candidates) || path.resolve(candidates[0]);
  }
  const cfg = {
    host: '127.0.0.1',
    port,
    dataDir: path.resolve(env.JN_HOME || path.join(home, '.jiangnan-focus')),
    claudeDir,
    codexDir,
    dshDir,
    grokDir,
    magpieFile,
    webDir: path.resolve(env.JN_WEB_DIR || path.join(SERVER_DIR, '..', 'web')),
    pollMs: 2000,
    rescanEvery: 5, // 每 5 次轮询（10 秒）全量扫一次目录，发现新文件和被续写的旧文件
  };
  cfg.sources = sourceEntries(cfg);
  return cfg;
}

// 存档目录绝不能落在任何被读取的 AI 工具目录里
export function assertSafeDataDir(dir, home = os.homedir(), env = process.env) {
  // 同时比较字面路径和真实路径（解析符号链接），防止存档目录经链接落进这些日志目录
  const real = (p) => {
    let cur = path.resolve(p); const rest = [];
    while (!fs.existsSync(cur)) { rest.unshift(path.basename(cur)); const up = path.dirname(cur); if (up === cur) break; cur = up; }
    try { cur = fs.realpathSync(cur); } catch {}
    return path.join(cur, ...rest);
  };
  const appData = appDataDir(home, env);
  for (const d of [path.resolve(dir), real(dir)]) {
    for (const forbidden of [
      path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.dsh'),
      path.join(home, '.grok'), path.join(home, '.config', 'magpie'), path.join(appData, 'magpie'),
    ]) {
      for (const f of [path.resolve(forbidden), real(forbidden)]) {
        if ((d + path.sep).startsWith(f + path.sep)) throw new Error('JN_HOME 不能放在任何 AI 工具的日志目录里（~/.claude、~/.codex、~/.dsh、~/.grok、~/.config/magpie、%APPDATA%\\magpie）');
      }
    }
  }
}

// 统计的六个平台（state.today.bySource 固定按这个顺序给全）
export const SOURCES = Object.freeze(['claude', 'codex', 'deepseek', 'grok', 'magpie', 'cursor']);
export const SOURCE_LABELS = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
  grok: 'Grok Build',
  magpie: 'Magpie',
  cursor: 'Cursor CLI（经 Magpie）',
});

export const PRESENT_IDLE_SEC = 300; // 键鼠空闲小于 5 分钟算人在场

export const DEFAULT_SETTINGS = Object.freeze({
  activeMin: 3, segmentMin: 25, gapMin: 5, endMin: 10,
  presentOnly: false, volume: 0.3, muted: false,
  lanternUnit: 1000, // 网页孔明灯：今日 token 每满多少放一盏
  feedbackStyle: 'both', // 每满一个单位的反馈：lantern 放孔明灯 / muyu 敲木鱼 / both 两样都要
});

const RULES = {
  activeMin: { type: 'number', min: 1, max: 60 },
  segmentMin: { type: 'number', min: 1, max: 240 },
  gapMin: { type: 'number', min: 0, max: 60 },
  endMin: { type: 'number', min: 1, max: 240 },
  presentOnly: { type: 'boolean' },
  volume: { type: 'number', min: 0, max: 1 },
  muted: { type: 'boolean' },
  lanternUnit: { type: 'enum', values: [500, 1000, 2000, 5000] },
  feedbackStyle: { type: 'enum', values: ['lantern', 'muyu', 'both'] },
};

// 合并设置：未知字段忽略；类型或范围不对的字段返回错误，不合并任何东西
export function mergeSettings(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { errors: ['请求体必须是 JSON 对象'] };
  }
  const errors = [];
  const next = { ...current };
  for (const [k, rule] of Object.entries(RULES)) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (rule.type === 'boolean') {
      if (typeof v !== 'boolean') errors.push(`${k} 必须是 true/false`);
      else next[k] = v;
    } else if (rule.type === 'enum') {
      if (!rule.values.includes(v)) errors.push(`${k} 只能是 ${rule.values.join(' / ')}`);
      else next[k] = v;
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${k} 必须是数字`);
      else if (v < rule.min || v > rule.max) errors.push(`${k} 必须在 ${rule.min} 到 ${rule.max} 之间`);
      else next[k] = v;
    }
  }
  return errors.length ? { errors } : { settings: next };
}

export function sanitizeSettings(saved) {
  const base = { ...DEFAULT_SETTINGS };
  if (!saved || typeof saved !== 'object') return base;
  for (const k of Object.keys(RULES)) {
    if (!(k in saved)) continue;
    const r = mergeSettings(base, { [k]: saved[k] });
    if (r.settings) base[k] = r.settings[k];
  }
  return base;
}

// 奖励池：id 和类别。名字、描述、模型由网页侧 rewards.json 负责
export const REWARD_POOL = Object.freeze([
  { id: 'teahouse', category: 'building' },
  { id: 'pagoda', category: 'building' },
  { id: 'pavilion', category: 'building' },
  { id: 'archway', category: 'building' },
  { id: 'egret', category: 'creature' },
  { id: 'koi', category: 'creature' },
  { id: 'cat', category: 'creature' },
  { id: 'lion', category: 'creature' },
  { id: 'rain', category: 'weather' },
  { id: 'fireflies', category: 'weather' },
  { id: 'snow', category: 'weather' },
  { id: 'guqin', category: 'sound' },
  { id: 'raintiles', category: 'sound' },
  { id: 'watchman', category: 'sound' },
]);
export const LANTERN_PLUS = 'lantern_plus';
