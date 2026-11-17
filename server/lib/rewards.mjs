// 奖励：待领数量、当前三选一（存起来，刷新网页不会刷出新的一组）、已拥有、灯笼等级
import { randomInt } from 'node:crypto';
import { REWARD_POOL, LANTERN_PLUS } from './config.mjs';

const CATEGORY = new Map(REWARD_POOL.map((r) => [r.id, r.category]));

export class RewardError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class Rewards {
  constructor(saved, rng = randomInt) {
    const s = saved && typeof saved === 'object' ? saved : {};
    this.owned = Array.isArray(s.owned) ? [...new Set(s.owned.filter((x) => typeof x === 'string'))] : [];
    this.lanternLevel = Number.isInteger(s.lanternLevel) && s.lanternLevel >= 0 ? s.lanternLevel : 0;
    this.pending = Number.isInteger(s.pendingRewards) && s.pendingRewards >= 0 ? s.pendingRewards : 0;
    this.offerIds = Array.isArray(s.currentOffer) && s.currentOffer.every((x) => typeof x === 'string') ? s.currentOffer : null;
    this.rng = rng;
  }

  grant(n = 1) {
    this.pending += n;
  }

  // 返回当前这组选项；没有待领奖励时返回空数组
  offer() {
    if (this.pending <= 0) return [];
    if (!this.offerIds) {
      const remaining = REWARD_POOL.map((r) => r.id).filter((id) => !this.owned.includes(id));
      if (remaining.length === 0) {
        this.offerIds = [LANTERN_PLUS];
      } else {
        const pick = [];
        const pool = [...remaining];
        while (pick.length < 3 && pool.length) pick.push(pool.splice(this.rng(pool.length), 1)[0]);
        this.offerIds = pick;
      }
    }
    return this.offerIds.map((id) => ({ id, category: id === LANTERN_PLUS ? 'lantern' : CATEGORY.get(id) || 'unknown' }));
  }

  choose(id) {
    if (this.pending <= 0) throw new RewardError('no_pending', '没有待领的奖励', 409);
    if (!this.offerIds) throw new RewardError('no_offer', '请先请求三选一', 409);
    if (typeof id !== 'string' || !this.offerIds.includes(id)) throw new RewardError('not_in_offer', '这个奖励不在当前这组选项里', 400);
    if (id === LANTERN_PLUS) this.lanternLevel += 1;
    else if (!this.owned.includes(id)) this.owned.push(id);
    this.pending -= 1;
    this.offerIds = null;
    return { id, owned: [...this.owned], lanternLevel: this.lanternLevel, pendingRewards: this.pending };
  }

  // 专注归零时一起清：待领、已拥有、灯笼等级、存着的三选一
  reset() {
    this.owned = [];
    this.lanternLevel = 0;
    this.pending = 0;
    this.offerIds = null;
  }

  snapshot() {
    return { owned: [...this.owned], lanternLevel: this.lanternLevel, pendingRewards: this.pending, currentOffer: this.offerIds ? [...this.offerIds] : null };
  }
}
