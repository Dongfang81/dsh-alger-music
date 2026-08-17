#!/usr/bin/env node
/**
 * dsh-alger-music 演示视频录制（Playwright recordVideo 原生版）。
 * 需要系统 ffmpeg 出现在 playwright 缓存路径（见 demo 说明）。
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
	await page.waitForSelector('.dsa-card, .dsa-pet-wrap', { timeout: 30000 });
	await page.waitForFunction(() => (document.querySelector('.dsa-conn')?.textContent || '').includes('已连接'), { timeout: 30000 }).catch(() => {});
	log('浮窗就绪（默认宠物形态），开始录制');

	// 1) 展示宠物形态（歌词气泡）
	await sleep(3500);
	// 2) 点击宠物 → 切换播放器模式
	await page.click('.dsa-pet', { force: true });
	await page.waitForSelector('.dsa-card', { timeout: 5000 });
	log('切换到播放器');
	await sleep(1500);
	// 搜索
	await page.click('.dsa-input', { force: true });
	await page.type('.dsa-input', '周杰伦 晴天');
	await sleep(500);
	await page.click('.dsa-go', { force: true });
	await page.waitForSelector('.dsa-results .dsa-item', { timeout: 15000 });
	log('搜索完成');
	await sleep(2500);
	// 双击第一首播放
	await page.dblclick('.dsa-results .dsa-item', { force: true });
	log('触发播放');
	await sleep(8000);
	// 加入第二首
	const addBtns = page.locator('.dsa-results .dsa-item .dsa-rowbtn');
	if ((await addBtns.count()) > 1) {
		await addBtns.nth(1).click({ force: true });
		log('已加入队列');
	}
	await sleep(1500);
	// 播放列表
	await page.click('.dsa-queue-title', { force: true });
	log('播放列表');
	await sleep(3000);
	// 收起为宠物
	await page.click('.dsa-tl.min', { force: true });
	await page.waitForSelector('.dsa-pet-wrap', { timeout: 5000 });
	log('宠物模式');
	await sleep(10000);
	// 展开收尾
	await page.click('.dsa-pet', { force: true });
	await sleep(3000);
} finally {
	await browser.close();
}
console.log('完成');
