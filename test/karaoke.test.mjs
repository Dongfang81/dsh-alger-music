import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadClientModule() {
	let definition;
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(value) {
					definition = value;
				}
			}
		}
	};
	vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
	return definition.factory((name) => {
		if (name === 'react') return { createElement() {} };
		if (name === 'react-dom') return {};
		throw new Error(`unexpected client dependency: ${name}`);
	});
}

const LRC = [
	{ t: 0, text: '第一句' },
	{ t: 5, text: '第二句' },
	{ t: 11, text: '第三句' },
	{ t: 18, text: '最后一句' }
];

test('karaokeProgress: before line start is 0', () => {
	const { karaokeProgress } = loadClientModule();
	assert.equal(karaokeProgress(LRC, 1, 4.9), 0);
	assert.equal(karaokeProgress(LRC, 1, 0), 0);
});

test('karaokeProgress: fills linearly across a line (end = next line start)', () => {
	const { karaokeProgress } = loadClientModule();
	// 第二句：5s → 11s，6 秒句长
	assert.equal(karaokeProgress(LRC, 1, 5), 0);
	assert.equal(karaokeProgress(LRC, 1, 8), 0.5);
	assert.equal(karaokeProgress(LRC, 1, 11), 1);
});

test('karaokeProgress: clamps to [0, 1]', () => {
	const { karaokeProgress } = loadClientModule();
	assert.equal(karaokeProgress(LRC, 1, 3), 0);
	assert.equal(karaokeProgress(LRC, 1, 99), 1);
});

test('karaokeProgress: last line falls back to average gap (0.2~20s filter)', () => {
	const { karaokeProgress } = loadClientModule();
	// 前 3 个间隔：5、6、7 → 均值 6s；最后一句 18s 起
	assert.equal(karaokeProgress(LRC, 3, 18), 0);
	assert.equal(karaokeProgress(LRC, 3, 21), 0.5);
	assert.equal(karaokeProgress(LRC, 3, 24), 1);
});

test('karaokeProgress: last line with no usable gaps falls back to 4s estimate', () => {
	const { karaokeProgress } = loadClientModule();
	const single = [{ t: 10, text: '唯一一句' }];
	assert.equal(karaokeProgress(single, 0, 10), 0);
	assert.equal(karaokeProgress(single, 0, 12), 0.5);
	assert.equal(karaokeProgress(single, 0, 14), 1);
});

test('karaokeProgress: invalid input returns 0 (no crash)', () => {
	const { karaokeProgress } = loadClientModule();
	assert.equal(karaokeProgress(null, 0, 1), 0);
	assert.equal(karaokeProgress([], 0, 1), 0);
	assert.equal(karaokeProgress(LRC, -1, 1), 0);
	assert.equal(karaokeProgress(LRC, 99, 1), 0);
	assert.equal(karaokeProgress(LRC, 0, 'abc'), 0);
	assert.equal(karaokeProgress(LRC, 0.5, 1), 0);
});
