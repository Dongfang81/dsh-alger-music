#!/usr/bin/env node
/**
 * moony-singer 宣传视频录制 v3（营销向，三亮点）。
 *
 * 亮点1：对话框说“我想听歌”，宠物就给你安排好（overlay 模拟对话 + 实际推荐播放）
 * 亮点2：7 只可爱 Moony 宠物随音乐翩翩起舞（逐个变身展示律动）
 * 亮点3：会学习听歌习惯和场景，疲劳时主动推荐（开发中）（overlay 字幕）
 *
 * 需要系统 ffmpeg 出现在 playwright 缓存路径（demo/pw-cache）。
 * 输出：demo/video/promo.webm（画面），随后用 ffmpeg 混入背景音乐。
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire('/Users/dongfangxie/.dsh/profiles/web/');
const { chromium } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'video');
const VIEWPORT = { width: 1280, height: 900 };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
	viewport: VIEWPORT,
	recordVideo: { dir: OUT, size: VIEWPORT }
});
await context.addInitScript(() => {
	try {
		localStorage.setItem('dsh-alger:x', '890');
		localStorage.setItem('dsh-alger:y', '180');
	} catch {}
});
const page = await context.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(new Date().toISOString().slice(11, 19), s);

/* ---------- overlay 字幕系统（全屏半透明大字，模拟对话框/亮点说明） ---------- */
const OVERLAY_CSS = `
#promo-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;pointer-events:none;font-family:system-ui,-apple-system,'PingFang SC',sans-serif}
#promo-overlay .box{max-width:820px;padding:26px 40px;border-radius:22px;background:rgba(13,15,24,.82);border:1px solid rgba(255,255,255,.2);box-shadow:0 24px 60px rgba(0,0,0,.55);text-align:center;backdrop-filter:blur(14px)}
#promo-overlay .big{font-size:42px;font-weight:700;color:#fff;line-height:1.35}
#promo-overlay .sub{margin-top:14px;font-size:20px;color:rgba(255,255,255,.75);line-height:1.5}
#promo-overlay .tag{display:inline-block;margin-top:16px;font-size:14px;color:#fbbf24;border:1px solid rgba(251,191,36,.5);border-radius:999px;padding:4px 14px}
#promo-overlay.hide{display:none}
`;
async function overlay(kind, big, sub, tag) {
	await page.evaluate(([css]) => {
		let s = document.getElementById('promo-overlay-style');
		if (!s) { s = document.createElement('style'); s.id = 'promo-overlay-style'; document.head.appendChild(s); }
		s.textContent = css;
	}, [OVERLAY_CSS]);
	await page.evaluate(([big, sub, tag]) => {
		let el = document.getElementById('promo-overlay');
		if (!el) { el = document.createElement('div'); el.id = 'promo-overlay'; document.body.appendChild(el); }
		el.className = '';
		el.innerHTML = '<div class="box">' +
			(big ? '<div class="big">' + big + '</div>' : '') +
			(sub ? '<div class="sub">' + sub + '</div>' : '') +
			(tag ? '<div class="tag">' + tag + '</div>' : '') +
			'</div>';
	}, [big, sub, tag]);
}
async function overlayHide() {
	await page.evaluate(() => { const el = document.getElementById('promo-overlay'); if (el) el.className = 'hide'; });
}

try {
	await page.goto('http://127.0.0.1:3080', { waitUntil: 'load', timeout: 60000 });
	await page.waitForSelector('.dsa-pet-wrap', { timeout: 30000 });
	await page.waitForFunction(() => {
		const st = document.querySelector('.dsa-conn');
		return !st || st.textContent.includes('启动') || document.querySelector('.dsa-search');
	}, { timeout: 30000 }).catch(() => {});
	await sleep(2000);
	log('就绪，开始录制');

	/* ===== 开场 ===== */
	await overlay('', '🎵 你的 DSH 会唱歌了', '月宝儿 Moony · 本地音乐播放插件', 'dsh-moony-singer');
	await sleep(3500);
	await overlayHide();
	await sleep(1200);

	/* ===== 亮点 1：对话框说“我想听歌”，宠物就给你安排好 ===== */
	// 1a. 展示宠物 + 对话气泡（overlay 模拟用户对话框）
	await overlay('', '「我想听歌」', '—— 在对话框里说一句，剩下的交给月宝儿', '亮点 1 · 对话点歌');
	await sleep(3200);
	await overlayHide();
	await sleep(800);
	// 1b. 让宠物开口“安排”（复用当前播放，不打断音乐）
	await page.evaluate(() =>
		fetch('/dsh-alger/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '好嘞！这就为你安排～' }) })
			.then((r) => r.json())
			.catch(() => null)
	);
	log('宠物已开口安排');
	await sleep(4500);

	/* ===== 亮点 2：7 只 Moony 随音乐起舞 ===== */
	await overlay('', '🐰 七只 Moony，随音乐起舞', '每只都有专属耳型、本色与听歌律动', '亮点 2 · Moony 家族');
	await sleep(3000);
	await overlayHide();
	await sleep(800);

	// 展开播放器，逐只切换
	await page.click('.dsa-pet', { force: true });
	await page.waitForSelector('.dsa-card', { timeout: 5000 });
	log('切换到播放器');
	await sleep(1500);

	const moonyNames = ['Classic', 'Pulse', 'Echo', 'Drift', 'Spark', 'Chorus', 'Hush'];
	for (const name of moonyNames) {
		// 打开变身菜单
		await page.evaluate(() => { const b = document.querySelector('.dsa-shape-arrow'); if (b) b.click(); });
		await sleep(800);
		const clicked = await page.evaluate((n) => {
			const opts = [...document.querySelectorAll('.dsa-moony-option')];
			const opt = opts.find((o) => (o.textContent || '').includes(n));
			if (!opt) return false;
			opt.click();
			return true;
		}, name);
		if (!clicked) { log('未找到 Moony ' + name); continue; }
		await sleep(700);
		// 收起为宠物形态展示跳舞（evaluate 直接触发，绕开菜单遮挡）
		await page.evaluate(() => { const b = document.querySelector('.dsa-shape'); if (b) b.click(); });
		await page.waitForSelector('.dsa-pet-wrap', { timeout: 5000 });
		log('变身：' + name + '（随音乐律动）');
		await sleep(4200);
		// 重新展开，进入下一只
		await page.evaluate(() => { const p = document.querySelector('.dsa-pet'); if (p) p.click(); });
		await page.waitForSelector('.dsa-card', { timeout: 5000 });
		await sleep(900);
	}

	// 回到 Classic 展示展开态（进度条 + 播放列表）
	await page.evaluate(() => { const b = document.querySelector('.dsa-shape-arrow'); if (b) b.click(); });
	await sleep(700);
	await page.evaluate(() => {
		const opt = [...document.querySelectorAll('.dsa-moony-option')].find((o) => (o.textContent || '').includes('Classic'));
		if (opt) opt.click();
	});
	await sleep(900);
	// 选角色后已收起为宠物，点宠物展开播放器
	await page.evaluate(() => { const p = document.querySelector('.dsa-pet'); if (p) p.click(); });
	await page.waitForSelector('.dsa-card', { timeout: 5000 });
	await page.evaluate(() => { const t = document.querySelector('.dsa-queue-title'); if (t) t.click(); });
	await sleep(3500);

	/* ===== 亮点 3：学习习惯（开发中） ===== */
	await overlay('', '🧠 会学习你的听歌习惯和场景', '工作疲劳时，主动推荐应景的歌曲', '亮点 3 · 智能推荐（开发中）');
	await sleep(4200);
	await overlayHide();
	await sleep(1000);

	/* ===== 收尾 ===== */
	await overlay('', '✨ 装上它，让你的 DSH 会唱歌', 'GitHub: Dongfang81/moony-singer', '免费开源 · GPL-3.0');
	await sleep(4000);
	await overlayHide();
	await sleep(1500);
} finally {
	await browser.close();
}
console.log('录制完成：demo/video/promo.webm');
