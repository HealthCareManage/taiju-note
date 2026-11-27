// 為替急変モニター（サーバー側）
// GitHub Actions から5分おきに起動され、約4分間 15 秒おきにレートを取得して急変を判定し、
// 急変したら ntfy（スマホの通知アプリ）に送ります。判定ロジックは fx-monitor.html と同じです。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PAIRS = {
  'USD/JPY': { pip: 0.01,   dp: 3, cb: r => r.JPY },
  'EUR/JPY': { pip: 0.01,   dp: 3, cb: r => r.JPY / r.EUR },
  'GBP/JPY': { pip: 0.01,   dp: 3, cb: r => r.JPY / r.GBP },
  'AUD/JPY': { pip: 0.01,   dp: 3, cb: r => r.JPY / r.AUD },
  'EUR/USD': { pip: 0.0001, dp: 5, cb: r => 1 / r.EUR },
  'GBP/USD': { pip: 0.0001, dp: 5, cb: r => 1 / r.GBP },
  'AUD/USD': { pip: 0.0001, dp: 5, cb: r => 1 / r.AUD },
};

export const DEFAULTS = {
  pairs: ['USD/JPY', 'EUR/JPY', 'EUR/USD'],
  window: 5, z: 3, minPips: 15, absPips: 50, horizon: 15, cooldown: 10,
  runSeconds: 240, intervalSeconds: 15, notifyResults: true,
};
const SRC = 'coinbase';
const KEEP_MS = 8 * 3600e3;
const MIN_SAMPLES = 20;
const LAMBDA = 0.97;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------- 計算 ----------
export function addSample(state, pair, t, p) {
  if (!isFinite(p) || p <= 0) return;
  const s = state.series[pair] || (state.series[pair] = { pts: [], v: null, n: 0 });
  const last = s.pts[s.pts.length - 1];
  if (last && t <= last.t) return;
  if (last && p === last.p) { last.seen = t; return; }
  if (last) {
    const dt = Math.max(1, (t - last.t) / 1000);
    const r = Math.log(p / last.p);
    let x = r * r / dt;
    if (s.v != null) x = Math.min(x, s.v * 25);
    s.v = s.v == null ? x : LAMBDA * s.v + (1 - LAMBDA) * x;
    s.n++;
  }
  s.pts.push({ t, p });
  const cut = t - KEEP_MS;
  while (s.pts.length && s.pts[0].t < cut) s.pts.shift();
}

function priceAt(pts, t) {
  let lo = 0, hi = pts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function rsi(pts, n = 14) {
  if (pts.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = pts.length - n; i < pts.length; i++) {
    const d = pts[i].p - pts[i - 1].p;
    if (d > 0) g += d; else l -= d;
  }
  if (g + l === 0) return 50;
  return 100 * g / (g + l);
}

export function analyze(state, cfg, pair, t) {
  const s = state.series[pair];
  const def = PAIRS[pair];
  if (!s || !s.pts.length) return null;
  const pts = s.pts, last = pts[pts.length - 1];
  const res = { pair, p: last.p, t: last.seen || last.t, ready: false, level: 0 };
  if (s.n < MIN_SAMPLES || s.v == null || s.v <= 0) return res;
  const W = cfg.window * 60e3;
  let bi = priceAt(pts, t - W);
  if (bi < 0) { if (t - pts[0].t < W * 0.5) return res; bi = 0; }
  const base = pts[bi];
  const sigW = Math.sqrt(s.v * (W / 1000));
  const z = Math.log(last.p / base.p) / sigW;
  const pips = (last.p - base.p) / def.pip;
  Object.assign(res, { ready: true, z, pips, base, sigW, bi });
  const az = Math.abs(z), ap = Math.abs(pips);
  if ((az >= cfg.z && ap >= cfg.minPips) || ap >= cfg.absPips) res.level = 2;
  else if (az >= cfg.z * 0.66 && ap >= cfg.minPips * 0.5) res.level = 1;
  if (res.level > 0) res.pred = predict(state, cfg, pair, res);
  return res;
}

function predict(state, cfg, pair, a) {
  const s = state.series[pair], pts = s.pts, def = PAIRS[pair];
  const last = pts[pts.length - 1];
  const dir = Math.sign(a.z) || 1;
  const sigSec = Math.sqrt(s.v);
  const W = cfg.window * 60e3;
  const f = [];

  const Ws = W / 5;
  let si = priceAt(pts, last.t - Ws); if (si < 0) si = 0;
  const rS = Math.log(last.p / pts[si].p) * dir;
  const f1 = clamp(rS / (sigSec * Math.sqrt(Ws / 1000)) / 2, -1, 1);
  f.push({ w: 0.9, v: f1, txt: f1 > 0.2 ? '直近も同じ方向に動き続けている' : f1 < -0.2 ? '直近は反対方向に動き始めている' : '直近の勢いは弱まっている' });

  let ext = a.base.p;
  for (let i = a.bi; i < pts.length; i++) ext = dir > 0 ? Math.max(ext, pts[i].p) : Math.min(ext, pts[i].p);
  const span = Math.abs(ext - a.base.p) || def.pip;
  const retr = clamp((ext - last.p) * dir / span, 0, 1);
  const f2 = clamp(0.6 - 3.2 * retr, -1, 0.6);
  f.push({ w: 1.0, v: f2, txt: retr < 0.1 ? '高値（安値）を更新中' : `急変幅の${Math.round(retr * 100)}%を戻している` });

  const r = rsi(pts);
  const rd = dir > 0 ? r : 100 - r;
  const f3 = -clamp((rd - 70) / 20, 0, 1);
  f.push({ w: 0.8, v: f3, txt: f3 < -0.3 ? `買われすぎ／売られすぎ（RSI ${r.toFixed(0)}）で反動が出やすい` : `過熱感はそれほどない（RSI ${r.toFixed(0)}）` });

  const az = Math.abs(a.z);
  const f4 = az < 4.5 ? 0.3 : -clamp((az - 4.5) / 3, 0, 1) * 0.8;
  f.push({ w: 0.6, v: f4, txt: az < 4.5 ? '急変の規模は中程度で、流れが続きやすい' : '普段の何倍もの急変で、行き過ぎの反動に注意' });

  const Wl = W * 6;
  let li = priceAt(pts, last.t - Wl); if (li < 0) li = 0;
  const rL = Math.log(a.base.p / pts[li].p) * dir;
  const f5 = clamp(rL / (sigSec * Math.sqrt(Math.max(1, (a.base.t - pts[li].t) / 1000))), -1, 1) * 0.7;
  f.push({ w: 0.6, v: f5, txt: f5 > 0.15 ? 'それまでの大きな流れと同じ方向' : f5 < -0.15 ? 'それまでの大きな流れとは逆方向' : 'それまでは目立った流れがなかった' });

  const past = state.events.filter(e => e.pair === pair && e.cont != null && e.src === SRC);
  if (past.length) {
    const c = (past.filter(e => e.cont).length + 1) / (past.length + 2);
    const f6 = (c - 0.5) * 2 * (past.length / (past.length + 10));
    f.push({ w: 0.8, v: f6, txt: `過去${past.length}回の急変では${Math.round(c * 100)}%が同じ方向に続いた` });
  }

  const score = f.reduce((acc, x) => acc + x.w * x.v, 0);
  const pc = clamp(1 / (1 + Math.exp(-0.9 * score)), 0.28, 0.72);
  const pdir = pc >= 0.5 ? dir : -dir;
  const prob = Math.max(pc, 1 - pc);
  const band = last.p * (Math.exp(sigSec * Math.sqrt(cfg.horizon * 60) * 1.5) - 1);
  return {
    dir: prob < 0.55 ? 0 : pdir, spike: dir, prob, cont: pc >= 0.5,
    lo: last.p - band, hi: last.p + band,
    factors: f.sort((x, y) => Math.abs(y.w * y.v) - Math.abs(x.w * x.v)).slice(0, 4),
  };
}

// ---------- 急変の記録・答え合わせ・通知 ----------
const predWord = e => e.pdir === 0 ? 'どちらとも言えない' : `${e.pdir > 0 ? '上' : '下'}方向に寄りやすい（${Math.round(e.prob * 100)}%）`;

export async function checkEvents(state, cfg, pair, a, t, notify) {
  if (!a || !a.ready) return;
  const def = PAIRS[pair];
  for (const e of state.events) {
    if (e.pair !== pair || e.result != null || e.src !== SRC || t < e.evalAt) continue;
    const moved = a.p - e.p;
    e.after = a.p;
    e.cont = Math.sign(moved) === e.spike;
    e.result = e.pdir === 0 ? 'neutral' : (Math.sign(moved) === e.pdir ? 'hit' : 'miss');
    if (cfg.notifyResults) {
      const word = { hit: '的中', miss: '外れ', neutral: '見送り' }[e.result];
      await notify({
        title: `${pair} ${cfg.horizon}分前の予想：${word}`,
        message: `${e.p.toFixed(def.dp)} → ${a.p.toFixed(def.dp)}（予想：${predWord(e)}）`,
        priority: 2, tags: [e.result === 'hit' ? 'white_check_mark' : e.result === 'miss' ? 'x' : 'zzz'],
      });
    }
  }
  if (a.level < 2) return;
  const dir = Math.sign(a.z) || 1;
  const lastE = [...state.events].reverse().find(e => e.pair === pair && e.src === SRC);
  if (lastE && t - lastE.t < cfg.cooldown * 60e3 && lastE.spike === dir) return;
  const pr = a.pred;
  const e = {
    id: t + pair, src: SRC, pair, t, p: a.p, spike: dir, z: +a.z.toFixed(2), pips: +a.pips.toFixed(1),
    pdir: pr.dir, prob: +pr.prob.toFixed(2), lo: pr.lo, hi: pr.hi, evalAt: t + cfg.horizon * 60e3, result: null,
  };
  state.events.push(e);
  const kind = pr.dir === 0 ? '' : pr.cont ? '（急変の流れが続く見立て）' : '（急変の反動で戻る見立て）';
  await notify({
    title: `${pair} 急${e.spike > 0 ? '騰' : '落'} ${e.pips > 0 ? '+' : ''}${e.pips.toFixed(0)}pips`,
    message:
      `${cfg.window}分で普段の${Math.abs(e.z).toFixed(1)}倍の動き（${e.p.toFixed(def.dp)}）\n` +
      `${cfg.horizon}分後の見立て：${predWord(e)}${kind}\n` +
      `想定レンジ ${pr.lo.toFixed(def.dp)}〜${pr.hi.toFixed(def.dp)}\n` +
      pr.factors.map(f => `${f.v > 0.05 ? '＋' : f.v < -0.05 ? '－' : '・'}${f.txt}`).join('\n'),
    priority: 4, tags: [e.spike > 0 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend', 'warning'],
  });
}

// ---------- 取得・通知 ----------
export async function fetchRates() {
  const r = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const raw = (await r.json())?.data?.rates;
  if (!raw) throw new Error('レートを読み取れませんでした');
  const out = {}; for (const k in raw) out[k] = parseFloat(raw[k]);
  return out;
}

export function makeNotifier(topic, server = 'https://ntfy.sh') {
  return async ({ title, message, priority, tags }) => {
    if (!topic) { console.log('[通知（NTFY_TOPIC 未設定のため送信せず）]', title, '\n' + message); return; }
    const r = await fetch(server, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, priority, tags }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('ntfy HTTP ' + r.status);
    console.log('通知を送信：', title);
  };
}

export async function step(state, cfg, rates, t, notify) {
  for (const pair of cfg.pairs) {
    addSample(state, pair, t, PAIRS[pair].cb(rates));
    const a = analyze(state, cfg, pair, t);
    await checkEvents(state, cfg, pair, a, t, notify);
  }
}

// ---------- 実行 ----------
export function loadState(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { series: s.series || {}, events: s.events || [] }; }
  catch { return { series: {}, events: [] }; }
}
export function saveState(file, state) {
  state.events = state.events.slice(-300);
  fs.writeFileSync(file, JSON.stringify(state));
}

async function main() {
  const stateFile = process.env.STATE_FILE || path.join(HERE, '..', 'state.json');
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')); } catch {}
  const cfg = { ...DEFAULTS, ...user };
  cfg.pairs = cfg.pairs.filter(p => PAIRS[p]);
  const notify = makeNotifier((process.env.NTFY_TOPIC || '').trim());
  const state = loadState(stateFile);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const end = Date.now() + cfg.runSeconds * 1000;
  let ok = 0, fail = 0;
  do {
    try {
      const t = Date.now();
      await step(state, cfg, await fetchRates(), t, notify);
      ok++;
    } catch (e) { fail++; console.error('失敗：', e.message); }
    saveState(stateFile, state);
    if (Date.now() + cfg.intervalSeconds * 1000 >= end) break;
    await sleep(cfg.intervalSeconds * 1000);
  } while (true);
  console.log(`完了：成功 ${ok} 回、失敗 ${fail} 回`);
  if (!ok) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
