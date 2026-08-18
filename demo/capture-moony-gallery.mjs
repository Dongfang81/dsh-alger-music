#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire('/Users/dongfangxie/.dsh/profiles/web/');
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client.js');
const reactPath = join(dirname(require.resolve('react/package.json')), 'umd', 'react.development.js');
const reactDomPath = join(dirname(require.resolve('react-dom/package.json')), 'umd', 'react-dom.development.js');
const browser = await chromium.launch({ channel: 'chrome', headless: true });

function collectBrowserErrors(page) {
	const errors = [];
	page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(`console: ${message.text()}`);
	});
	return errors;
}

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

try {
	const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
	page.setDefaultTimeout(5000);
	const browserErrors = collectBrowserErrors(page);
	await page.goto(pathToFileURL(join(here, 'moony-gallery.html')).href, { waitUntil: 'load' });
	await page.locator('[data-gallery-kind="recovery"] .dsa-moony-face img').waitFor({ state: 'visible' });
	expect(await page.locator('[data-gallery-kind="identity"]').count() === 7, 'gallery must render exactly seven identity cards');
	expect(await page.locator('[data-gallery-kind="identity"] [data-face-mode="blank"] img').count() === 0, 'identity idle faces must be blank');
	expect(await page.locator('[data-gallery-kind="identity"] [data-face-mode="media"] img').count() === 7, 'every identity must show its listening media face');
	expect(await page.locator('[data-gallery-kind="state"]').count() === 5, 'gallery must show all five agent states');
	for (const status of ['idle', 'running', 'waiting', 'failed', 'review']) {
		expect(await page.locator(`[data-gallery-kind="state"][data-status="${status}"] .dsa-agent-${status}`).count() === 2, `${status} must include blank and media modes`);
	}
	expect(await page.locator('[data-gallery-kind="state"] [data-face-mode="blank"] img').count() === 0, 'state blank faces must not render images');
	expect(await page.locator('[data-gallery-kind="state"] [data-face-mode="media"] img').count() === 5, 'every state must include a media face');
	expect(await page.locator('[data-gallery-kind="recovery"][data-recovered="true"] img:not([hidden])').count() === 1, 'failed media must recover to a visible valid source');

	const visualContracts = await page.evaluate(() => {
		const catalog = new Map(window.moonyClient.MOONY_CATALOG.map((pet) => [pet.id, pet]));
		const colors = [...document.querySelectorAll('.dsa-moony-pet')].map((node) => {
			const pet = catalog.get(node.dataset.moonyId);
			const style = getComputedStyle(node);
			return {
				id: pet.id,
				ear: style.getPropertyValue('--moony-ear').trim(),
				highlight: style.getPropertyValue('--moony-ear-highlight').trim(),
				rim: style.getPropertyValue('--moony-rim').trim(),
				expected: pet.colors
			};
		});
		const boundaries = [...document.querySelectorAll('[data-boundary-frame]')].map((frame) => {
			const outer = frame.getBoundingClientRect();
			const parts = [...frame.querySelectorAll('.dsa-moony-face,.dsa-moony-ear,.dsa-moony-tail')];
			return parts.every((part) => {
				const box = part.getBoundingClientRect();
				return box.left >= outer.left && box.right <= outer.right && box.top >= outer.top && box.bottom <= outer.bottom;
			});
		});
		const overlaps = [...document.querySelectorAll('[data-boundary-frame] .dsa-moony-tail')].map((tail) => {
			const face = tail.parentElement.querySelector('.dsa-moony-face');
			const a = face.getBoundingClientRect();
			const b = tail.getBoundingClientRect();
			const overlapsFace = Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
			return overlapsFace && Number(getComputedStyle(face).zIndex) > Number(getComputedStyle(tail).zIndex);
		});
		const identityMotions = [...document.querySelectorAll('[data-gallery-kind="identity"]')].map((card) => ({
			idle: getComputedStyle(card.querySelector('[data-face-mode="blank"] .dsa-moony-ear')).animationName,
			listening: getComputedStyle(card.querySelector('[data-face-mode="media"] .dsa-moony-rhythm')).animationName
		}));
		const stateMotions = [...document.querySelectorAll('[data-gallery-kind="state"]')].map((card) => ({
			status: card.dataset.status,
			ear: getComputedStyle(card.querySelector('[data-face-mode="media"] .dsa-moony-ear')).animationName,
			rhythm: getComputedStyle(card.querySelector('[data-face-mode="media"] .dsa-moony-rhythm')).animationName
		}));
		return { colors, boundaries, overlaps, identityMotions, stateMotions };
	});
	for (const value of visualContracts.colors) {
		expect(value.ear === value.expected.ear && value.highlight === value.expected.highlight && value.rim === value.expected.rim, `${value.id} base colors must remain fixed in every state`);
	}
	expect(visualContracts.boundaries.length === 3 && visualContracts.boundaries.every(Boolean), 'ears and tails must stay inside the boundary frames');
	expect(visualContracts.overlaps.length === 3 && visualContracts.overlaps.every(Boolean), 'tails must overlap behind, never above, the face');
	expect(new Set(visualContracts.identityMotions.map((motion) => motion.idle)).size === 7, 'every character must have a distinct computed idle animation');
	expect(new Set(visualContracts.identityMotions.map((motion) => motion.listening)).size === 7, 'every character must have a distinct computed listening rhythm');
	for (const motion of visualContracts.stateMotions) {
		expect(motion.ear === `dsa-moony-${motion.status === 'idle' ? 'idle-beat' : motion.status}`, `${motion.status} must control the ear state layer`);
		expect(motion.rhythm === 'dsa-moony-listen-beat', `${motion.status} must remain compatible with the listening rhythm layer`);
	}

	await page.emulateMedia({ reducedMotion: 'reduce' });
	const reducedAnimations = await page.locator('.dsa-moony-rhythm,.dsa-moony-ear,.dsa-moony-tail').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName));
	expect(reducedAnimations.length > 0 && reducedAnimations.every((name) => name === 'none'), 'reduced motion must disable every Moony animation layer');
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	expect(browserErrors.length === 0, `gallery emitted browser errors:\n${browserErrors.join('\n')}`);
	await page.screenshot({ path: join(here, '..', 'docs', 'moony-series.png'), fullPage: true, animations: 'disabled' });

	const reconciliationPage = await browser.newPage({ viewport: { width: 320, height: 240 } });
	const reconciliationErrors = collectBrowserErrors(reconciliationPage);
	await reconciliationPage.setContent('<div id="root"></div>');
	await reconciliationPage.addScriptTag({ path: reactPath });
	await reconciliationPage.addScriptTag({ path: reactDomPath });
	await reconciliationPage.evaluate(() => {
		window.__ModuleLoader__ = { load(definition) {
			window.moonyClient = definition.factory((name) => {
				if (name === 'react') return window.React;
				if (name === 'react-dom') return window.ReactDOM;
				throw new Error(`unexpected dependency: ${name}`);
			});
		} };
	});
	await reconciliationPage.addScriptTag({ path: clientPath });
	const recovered = await reconciliationPage.evaluate(() => {
		const firstUrl = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
		const secondUrl = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2" height="2"%3E%3Crect width="2" height="2" fill="%236D5BD0"/%3E%3C/svg%3E';
		const root = document.querySelector('#root');
		const reactRoot = window.ReactDOM.createRoot(root);
		window.ReactDOM.flushSync(() => reactRoot.render(window.React.createElement(window.moonyClient.MoonyPet, { petId: 'classic', mediaUrl: firstUrl })));
		const failedNode = root.querySelector('img');
		failedNode.dispatchEvent(new Event('error'));
		if (!failedNode.hidden) return false;
		window.ReactDOM.flushSync(() => reactRoot.render(window.React.createElement(window.moonyClient.MoonyPet, { petId: 'classic', mediaUrl: secondUrl })));
		const validNode = root.querySelector('img');
		validNode.dispatchEvent(new Event('load'));
		return validNode !== failedNode && validNode.src === secondUrl && !validNode.hidden;
	});
	expect(recovered, 'real React reconciliation must replace a failed image and reveal the next valid source');
	expect(reconciliationErrors.length === 0, `reconciliation emitted browser errors:\n${reconciliationErrors.join('\n')}`);
	await reconciliationPage.close();
} finally {
	await browser.close();
}
