// 存档：JN_HOME/save.json（收藏、待领奖励、当天统计、专注段、设置）。原子写入：先写临时文件再改名
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeDataDir } from './config.mjs';

export class Store {
  constructor(dir) {
    assertSafeDataDir(dir);
    this.dir = dir;
    this.file = path.join(dir, 'save.json');
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      const d = JSON.parse(text);
      return d && typeof d === 'object' ? d : null;
    } catch {
      // 存档坏了：另存一份留底，然后当作新存档
      try { fs.copyFileSync(this.file, path.join(this.dir, `save.broken-${Date.now()}.json`)); } catch { /* 忽略 */ }
      return null;
    }
  }

  save(obj) {
    fs.mkdirSync(this.dir, { recursive: true });
    assertSafeDataDir(this.dir);
    const tmp = path.join(this.dir, `.save.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { flag: 'wx' }); // 排他创建，不跟随已有文件或链接
    fs.renameSync(tmp, this.file);
  }
}
