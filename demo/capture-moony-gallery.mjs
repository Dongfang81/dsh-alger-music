#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire('/Users/dongfangxie/.dsh/profiles/web/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
	const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
	await page.goto(pathToFileURL(join(here, 'moony-gallery.html')).href, { waitUntil: 'load' });
	if (await page.locator('.tile').count() !== 7) throw new Error('gallery must render exactly seven characters');
	if (await page.locator('.dsa-moony-face img').count() !== 0) throw new Error('idle gallery faces must be blank');
	if (await page.locator('.dsa-moony-tail').count() !== 6) throw new Error('three tailed characters shown at two sizes must render six tails');
	await page.screenshot({ path: join(here, '..', 'docs', 'moony-series.png'), fullPage: true });
} finally {
	await browser.close();
}
