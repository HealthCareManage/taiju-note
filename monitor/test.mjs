// 動作確認用：模擬レートで「平常 → 急騰 → 15分後」を再現し、通知と答え合わせが動くか確かめる。
//   node monitor/test.mjs
import assert from 'node:assert/strict';
import { step, addSample, loadState, saveState, DEFAULTS, PAIRS } from './monitor.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = { ...DEFAULTS, pairs: ['USD/JPY'] };
const sent = [];
const notify = async n => { sent.push(n); };
const state = { series: {}, events: [] };

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
let t = Date.UTC(2026, 10, 27, 0, 0, 0), jpy = 150;
const tick = async () => { t += 15e3; await step(state, cfg, { JPY: jpy, EUR: 0.9, GBP: 0.8, AUD: 1.5 }, t, notify); };

// 1. 2時間ぶんの平常な値動き（通知は出ないはず）
for (let i = 0; i < 480; i++) { jpy += rnd() * 0.012; await tick(); }
assert.equal(sent.length, 0, '平常時に通知が出てしまった');

// 2. 3分間で 60pips の急騰
for (let i = 0; i < 12; i++) { jpy += 0.05; await tick(); }
const spike = sent.filter(n => n.priority === 4);
assert.ok(spike.length >= 1, '急騰を検知できなかった');
assert.match(spike[0].title, /USD\/JPY 急騰/);
console.log('--- 急変の通知 ---\n' + spike[0].title + '\n' + spike[0].message);
const n1 = spike.length;

// 3. その後も動き続けても、クールダウン中は同じ向きの通知を繰り返さない
for (let i = 0; i < 8; i++) { jpy += 0.05; await tick(); }
assert.equal(sent.filter(n => n.priority === 4).length, n1, 'クールダウン中に再通知してしまった');

// 4. 15分後に答え合わせの通知が出る
for (let i = 0; i < 70; i++) { jpy += rnd() * 0.012; await tick(); }
const res = sent.filter(n => n.priority === 2);
assert.equal(res.length, 1, '答え合わせの通知が出なかった');
console.log('--- 答え合わせ ---\n' + res[0].title + '\n' + res[0].message);

// 5. 状態の保存と読み込み
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), 'state.json');
saveState(f, state);
const back = loadState(f);
assert.equal(back.events.length, state.events.length);
assert.equal(back.series['USD/JPY'].pts.length, state.series['USD/JPY'].pts.length);

// 6. 空の状態ファイル（初回実行）でも落ちない
fs.writeFileSync(f, '{}');
assert.deepEqual(loadState(f), { series: {}, events: [] });

console.log('\nすべて成功');
