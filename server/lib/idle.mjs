// 键鼠空闲时间：
// - macOS：ioreg 读 IOHIDSystem 的 HIDIdleTime（单位纳秒），不需要授权。
// - Windows：常驻一个 PowerShell 子进程，循环调 user32.dll 的 GetLastInputInfo，按行输出空闲毫秒。
// - Linux：先试 xprintidle（X11），再试 gdbus 调 org.gnome.Mutter.IdleMonitor.GetIdletime（Wayland/GNOME）。
//   两个都没有就安静降级：sample 返回 ok=false，引擎会把 presentUnknown 置为 true。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

const IOREG = fs.existsSync('/usr/sbin/ioreg') ? '/usr/sbin/ioreg' : 'ioreg';
// ioreg -c IOHIDSystem 加 -r -d 1：只输出 IOHIDSystem 节点本身（约 4KB），
// 实测每次约 30ms CPU；不加时输出约 350KB、每次约 70ms CPU
const IOREG_ARGS = ['-r', '-d', '1', '-c', 'IOHIDSystem'];
const MAC_ENV = { PATH: '/usr/sbin:/usr/bin:/bin' };

export function parseIdleSeconds(text) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(text));
  if (!m) return null;
  return Math.floor(Number(m[1]) / 1e9);
}

// xprintidle 直接输出一行毫秒数；gdbus 的 GetIdletime 输出 (<uint32 12345>,)
export function parseXprintidleMs(text) {
  const s = String(text).trim();
  const m = /^\d+$/.exec(s);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseGdbusIdleMs(text) {
  // gdbus 返回形如 (<uint32 12345>,)：数字后可能带逗号
  const m = /\(<uint32\s+(\d+)/.exec(String(text));
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

// 跑一个命令，收集 stdout；返回 { ok, out }。找不到命令、超时、非 0 退出都算 ok=false，不抛错。
function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { env: { PATH: process.env.PATH || '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ ok: false, out: '' });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } finish({ ok: false, out }); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { if (out.length < (1 << 20)) out += c; });
    child.on('error', () => finish({ ok: false, out }));
    child.on('close', (code) => finish({ ok: code === 0, out }));
  });
}

// macOS：直接 spawn ioreg 并给极简环境变量：比 execFile 复制整份环境省 CPU。
function sampleIdleMac(timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(IOREG, IOREG_ARGS, { env: MAC_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ ok: false, idleSec: 0 });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } finish({ ok: false, idleSec: 0 }); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { if (out.length < (1 << 20)) out += c; });
    child.on('error', () => finish({ ok: false, idleSec: 0 }));
    child.on('close', (code) => {
      const s = code === 0 ? parseIdleSeconds(out) : null;
      finish(s === null ? { ok: false, idleSec: 0 } : { ok: true, idleSec: s });
    });
  });
}

// Linux：启动后探测一次可用的后端，之后记住它；都不可用就安静降级，不再每轮重复 spawn。
// - X11 上用 xprintidle；GNOME Wayland 上通常没有 xprintidle，会落到 gdbus。
let linuxBackend = null; // null=未探测；'xprintidle' | 'gdbus' | 'none'

export function resetIdleLinuxBackend() {
  linuxBackend = null;
}

export async function sampleIdleLinux(timeoutMs, run = runCommand) {
  if (linuxBackend === 'xprintidle') {
    const x = await run('xprintidle', [], timeoutMs);
    const ms = parseXprintidleMs(x && x.ok ? x.out : '');
    if (ms !== null) return { ok: true, idleSec: Math.floor(ms / 1000) };
    // xprintidle 中途失效：这次按失败返回，但下次再试（不立刻改判 none，避免偶发故障被永久缓存）
  } else if (linuxBackend === 'gdbus') {
    const g = await run('gdbus', [
      'call', '--session',
      '--dest', 'org.gnome.Mutter.IdleMonitor',
      '--object-path', '/org/gnome/Mutter/IdleMonitor',
      '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime',
    ], timeoutMs);
    const ms = parseGdbusIdleMs(g && g.ok ? g.out : '');
    if (ms !== null) return { ok: true, idleSec: Math.floor(ms / 1000) };
  } else if (linuxBackend === 'none') {
    return { ok: false, idleSec: 0 };
  }

  // 首次探测：先 xprintidle，再 gdbus；谁成功就记住谁
  const x = await run('xprintidle', [], timeoutMs);
  if (x && x.ok) {
    const ms = parseXprintidleMs(x.out);
    if (ms !== null) { linuxBackend = 'xprintidle'; return { ok: true, idleSec: Math.floor(ms / 1000) }; }
  }
  const g = await run('gdbus', [
    'call', '--session',
    '--dest', 'org.gnome.Mutter.IdleMonitor',
    '--object-path', '/org/gnome/Mutter/IdleMonitor',
    '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime',
  ], timeoutMs);
  if (g && g.ok) {
    const ms = parseGdbusIdleMs(g.out);
    if (ms !== null) { linuxBackend = 'gdbus'; return { ok: true, idleSec: Math.floor(ms / 1000) }; }
  }
  linuxBackend = 'none';
  return { ok: false, idleSec: 0 };
}

// Windows：一个常驻 PowerShell，循环输出 GetLastInputInfo 的毫秒数，Node 按行读、缓存最新结果。
// 不在每次采样时起 PowerShell（那会每 2 秒编译一次 C#，很贵）。
let winProc = null;
let winBuf = '';
const winWaiters = [];
let winDead = false;

// 把 Node 的 PID 传进去：父进程没了就退出，作为 closeIdleWindows() 之外的兜底
function winScript(ppid) {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$ParentPid = ${Number(ppid) || 0}`,
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class JNIdle {',
    '  [StructLayout(LayoutKind.Sequential)]',
    '  private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
    '  [DllImport("user32.dll")]',
    '  private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
    '  [DllImport("kernel32.dll")]',
    '  private static extern uint GetTickCount();',
    '  public static uint Millis() {',
    '    LASTINPUTINFO lii = new LASTINPUTINFO();',
    '    lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));',
    '    if (!GetLastInputInfo(ref lii)) return 0;',
    '    return GetTickCount() - lii.dwTime;',
    '  }',
    '}',
    '"@',
    'while ($true) {',
    '  if ($ParentPid -gt 0) {',
    '    $Parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue',
    '    if (-not $Parent) { break }',
    '  }',
    '  try { [Console]::Out.WriteLine([JNIdle]::Millis()); [Console]::Out.Flush() } catch { }',
    '  Start-Sleep -Milliseconds 1000',
    '}',
  ].join('\n');
}

function flushWin(v) {
  const list = winWaiters.splice(0);
  for (const w of list) w(v);
}

function ensureWin() {
  if (winProc || winDead) return;
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', winScript(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    winDead = true;
    flushWin(null);
    return;
  }
  winProc = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    winBuf += c;
    let i;
    while ((i = winBuf.indexOf('\n')) !== -1) {
      const line = winBuf.slice(0, i).trim();
      winBuf = winBuf.slice(i + 1);
      if (!line) continue;
      const w = winWaiters.shift();
      if (w) w(line);
    }
  });
  child.on('error', () => { winProc = null; winDead = true; flushWin(null); });
  child.on('close', () => { winProc = null; winDead = true; flushWin(null); });
}

// 停止时调用：结束常驻 PowerShell 并等它退出，避免残留每秒输出一次的孤儿进程
export function closeIdleWindows() {
  const p = winProc;
  winProc = null;
  winDead = true;
  flushWin(null);
  if (!p) return Promise.resolve();
  return new Promise((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    p.once('close', finish);
    p.once('error', finish);
    try { p.kill(); } catch { finish(); }
    const t = setTimeout(finish, 1000);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

function sampleIdleWindows(timeoutMs) {
  ensureWin();
  if (winDead) return Promise.resolve({ ok: false, idleSec: 0 });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    // 首次要等 PowerShell 编译 C#，给足 8 秒；之后每 1 秒就有一行
    const timer = setTimeout(() => finish({ ok: false, idleSec: 0 }), Math.max(timeoutMs, 8000));
    winWaiters.push((line) => {
      const n = parseInt(line, 10);
      finish(Number.isFinite(n) && n >= 0 ? { ok: true, idleSec: Math.floor(n / 1000) } : { ok: false, idleSec: 0 });
    });
  });
}

// 返回 { ok, idleSec }；失败时 ok=false。按平台分发；未知平台安静降级。
export function sampleIdle({ timeoutMs = 1500 } = {}) {
  if (IS_MAC) return sampleIdleMac(timeoutMs);
  if (IS_WIN) return sampleIdleWindows(timeoutMs);
  if (IS_LINUX) return sampleIdleLinux(timeoutMs);
  return Promise.resolve({ ok: false, idleSec: 0 });
}

// 自适应采样：人在场（空闲 < 240 秒）时，接下来至少 60 秒内一定仍在场，
// 所以 10 秒采一次就够，中间用“上次空闲 + 经过的秒数”推算（只会偏大，不会把在场误判成离开）；
// 人不在场或读取失败时每次轮询（2 秒）都采，回来时第一时间发现。
export class IdleSampler {
  constructor({ sample = sampleIdle, presentRecheckMs = 10000, nearAwaySec = 240 } = {}) {
    this.sample = sample;
    this.presentRecheckMs = presentRecheckMs;
    this.nearAwaySec = nearAwaySec;
    this.last = null; // { at, ok, idleSec }
    this.spawns = 0;
  }

  async get(now) {
    const l = this.last;
    if (l && l.ok && l.idleSec < this.nearAwaySec && now - l.at < this.presentRecheckMs && now >= l.at) {
      return { ok: true, idleSec: l.idleSec + Math.floor((now - l.at) / 1000), estimated: true };
    }
    this.spawns += 1;
    const r = await this.sample();
    this.last = { at: now, ok: !!r.ok, idleSec: r.ok ? r.idleSec : 0 };
    return { ok: !!r.ok, idleSec: r.ok ? r.idleSec : 0, estimated: false };
  }

  // 停止时调用：释放 Windows 常驻子进程等资源
  close() {
    return closeIdleWindows();
  }
}
