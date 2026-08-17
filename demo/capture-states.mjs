#!/usr/bin/env node
/**
 * 月宝 Moony 状态展示图生成：打开真实 GUI 浮窗，对每个 agent 状态强制切换耳朵
 * 样式并截取宠物区域，最后拼成带标注的完整展示图（docs/moony-states.png）。
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire('/Users/dongfangxie/.dsh/profiles/web/');
const { chromium } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const VIEWPORT = { width: 1280, height: 900 };

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: VIEWPORT });
await context.addInitScript(() => {
	try {
		localStorage.setItem('dsh-alger:x', '900');
		localStorage.setItem('dsh-alger:y', '200');
	} catch {}
});
const page = await context.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATES = [
	['idle', '空闲', '默认蓝紫圆耳'],
	['running', '处理中', '蓝色 · 快速摆动'],
	['waiting', '等你确认', '橙色 · 缓慢探看'],
	['failed', '出错', '红色 · 颤抖'],
	['review', '待审查', '绿色 · 轻点头']
];

try {
	await page.goto('http://127.0.0.1:3080', { waitUntil: 'load', timeout: 60000 });
	await page.waitForSelector('.dsa-pet-wrap .dsa-pet', { timeout: 30000 });
	await sleep(2000);

	const tiles = [];
	for (const [st, label, desc] of STATES) {
		await page.evaluate((s) => {
			const pet = document.querySelector('.dsa-pet');
			if (!pet) return;
			pet.classList.remove('dsa-agent-running', 'dsa-agent-waiting', 'dsa-agent-failed', 'dsa-agent-review');
			if (s !== 'idle') pet.classList.add('dsa-agent-' + s);
		}, st);
		await sleep(400);
		const box = await page.evaluate(() => {
			const r = document.querySelector('.dsa-pet').getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height };
		});
		const clip = { x: box.x - 18, y: box.y - 38, width: box.w + 36, height: box.h + 54 };
		const p = join(SHOTS, st + '.png');
		await page.screenshot({ path: p, clip });
		tiles.push({ st, label, desc, path: p });
		console.log('captured', st);
	}
	// 唱歌中：宠物 + 音符 + 歌词气泡
	const box = await page.evaluate(() => {
		const r = document.querySelector('.dsa-pet').getBoundingClientRect();
		return { x: r.x, y: r.y, w: r.width, h: r.height };
	});
	const singPath = join(SHOTS, 'singing.png');
	await page.screenshot({ path: singPath, clip: { x: box.x - 18, y: box.y - 52, width: 280, height: 130 } });
	tiles.push({ st: 'singing', label: '唱歌中', desc: '音符 + 歌词气泡', path: singPath });
	console.log('captured singing');

	// 拼图：2 列 x 3 行
	const cellW = 320;
	const cellH = 220;
	const COLS = 2;
	const ROWS = 3;
	const grid = tiles.map((t, i) => {
		const col = i % COLS;
		const row = Math.floor(i / COLS);
		return {
			...t,
			x: col * cellW + 24,
			y: row * cellH + 20
		};
	});
	const html = `<!doctype html><html><head><meta charset="utf-8"><style>
		html,body{margin:0;width:${COLS * cellW + 24}px;height:${ROWS * cellH + 20}px;background:linear-gradient(160deg,#0f172a,#1e1b4b);overflow:hidden}
		.tile{position:absolute;width:${cellW - 48}px;height:${cellH - 48}px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
		.tile img{height:92px;object-fit:contain}
		.lab{color:#fff;font:600 20px system-ui,'PingFang SC',sans-serif}
		.desc{color:rgba(255,255,255,0.65);font:13px system-ui,'PingFang SC',sans-serif}
		.title{position:absolute;top:8px;left:0;right:0;text-align:center;color:#fff;font:600 22px system-ui,'PingFang SC',sans-serif}
	</style></head><body>
		<div class="title">🐰 月宝 Moony · 状态展示（圆脸 + 耳朵）</div>
		${grid.map((t) => `
			<div class="tile" style="left:${t.x}px;top:${t.y + 34}px">
				<img src="file://${t.path}">
				<div class="lab">${t.label}</div>
				<div class="desc">${t.desc}</div>
			</div>`).join('')}
	</body></html>`;
	const gridPath = join(HERE, '_grid.html');
	writeFileSync(gridPath, html);
	await page.setViewportSize({ width: 2 * cellW + 24, height: 3 * cellH + 20 });
	await page.goto('file://' + gridPath, { waitUntil: 'load' });
	await page.waitForTimeout(600);
	await page.screenshot({ path: join(HERE, '..', 'docs', 'moony-states.png') });
	console.log('showcase saved');
} finally {
	await browser.close();
}
console.log('done');
