// 本地时区的“天”：零点、明天零点、日期键
export function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function nextDayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function floorMinute(ms) {
  return Math.floor(ms / 60000) * 60000;
}
