#!/usr/bin/env node
/**
 * moony-singer 演示视频录制 v2（交互更丰富）。
 * 默认宠物形态 → 点击展开 → 搜索 → 播放 → 换歌 → 播放模式 → 收藏 → 加入队列 → 播放列表 → 收起宠物（歌词气泡）。
 * 需要系统 ffmpeg 出现在 playwright 缓存路径（demo/pw-cache）。
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
		localStorage.setItem('dsh-alger:x', '900');
		localStorage.setItem('dsh-alger:y', '200');
	} catch {}
});
const page = await context.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(new Date().toISOString().slice(11, 19), s);

try {
	await page.goto('http://127.0.0.1:3080', { waitUntil: 'load', timeout: 60000 });
	await page.waitForSelector('.dsa-pet-wrap', { timeout: 30000 });
	await page.waitForFunction(() => (document.querySelector('.dsa-conn')?.textContent || '').includes('已连接'), { timeout: 30000 }).catch(() => {});
	log('默认宠物形态就绪，开始录制');

	// 1) 宠物形态（气泡歌词）
	await sleep(3500);

	// 2) 点击宠物 → 播放器模式
	await page.click('.dsa-pet', { force: true });
	await page.waitForSelector('.dsa-card', { timeout: 5000 });
	log('切换到播放器');
	await sleep(1500);

	// 3) 搜索
	await page.click('.dsa-input', { force: true });
	await page.type('.dsa-input', '周杰伦 晴天');
	await sleep(500);
	await page.click('.dsa-go', { force: true });
	await page.waitForSelector('.dsa-results .dsa-item', { timeout: 15000 });
	log('搜索完成');
	await sleep(2500);

	// 4) 双击第一首 → 播放
	await page.dblclick('.dsa-results .dsa-item', { force: true });
	log('播放：第一首');
	await sleep(7000);

	// 5) 换歌：重新搜索另一首歌（播放后结果会自动收起，故重新搜索）
	await page.click('.dsa-input', { force: true });
	await page.fill('.dsa-input', '李荣浩 年少有为');
	await sleep(400);
	await page.click('.dsa-go', { force: true });
	await page.waitForSelector('.dsa-results .dsa-item', { timeout: 15000 });
	await page.dblclick('.dsa-results .dsa-item', { force: true });
	log('换歌：李荣浩 年少有为');
	await sleep(8000);

	// 6) 切换播放模式（循环→单曲）
	await page.click('.dsa-mode', { force: true });
	log('切换播放模式');
	await sleep(1500);

	// 7) 收藏（变红）
	await page.click('.dsa-fav', { force: true });
	log('收藏');
	await sleep(1500);

	// 8) 把第一首加入队列 + 打开播放列表
	const addBtns = page.locator('.dsa-results .dsa-item .dsa-rowbtn');
	if ((await addBtns.count()) > 0) {
		await addBtns.first().click({ force: true });
		log('加入队列');
	}
	await sleep(1200);
	await page.click('.dsa-queue-title', { force: true });
	log('播放列表');
	await sleep(3000);

	// 9) 收起为宠物（新歌歌词气泡）
	await page.click('.dsa-tl.min', { force: true });
	await page.waitForSelector('.dsa-pet-wrap', { timeout: 5000 });
	log('宠物模式（歌词）');
	await sleep(9000);

	// 10) 展开收尾
	await page.click('.dsa-pet', { force: true });
	await sleep(2500);
} finally {
	await browser.close();
}
console.log('完成');
