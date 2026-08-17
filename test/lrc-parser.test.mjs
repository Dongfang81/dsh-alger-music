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

test('parseLrc terminates and parses a single timestamped lyric line', () => {
	const client = loadClientModule();
	assert.equal(typeof client.parseLrc, 'function');
	assert.deepEqual(
		Array.from(client.parseLrc('[00:01.38]测试歌词'), (line) => ({ ...line })),
		[{ t: 1.38, text: '测试歌词' }]
	);
});

test('parseLrc handles multi-line lyrics, no-timestamp lines and metadata', () => {
	const client = loadClientModule();
	const lrc = [
		'[ti:测试]',
		'[ar:歌手]',
		'[00:01.00]第一句',
		'普通无时间戳行',
		'[00:03.50]第二句'
	].join('\n');
	assert.deepEqual(
		Array.from(client.parseLrc(lrc), (line) => ({ ...line })),
		[
			{ t: 1, text: '第一句' },
			{ t: 3.5, text: '第二句' }
		]
	);
});

test('parseLrc does not drop lines after a timestamp-only line (lastIndex carryover regression)', () => {
	const client = loadClientModule();
	const lrc = ['[00:01.00]第一句', '[00:02.00]', '[00:03.00]第二句'].join('\n');
	const lines = Array.from(client.parseLrc(lrc));
	assert.equal(lines.length, 3, '应解析出 3 行（含纯时间戳行）');
	assert.deepEqual(lines.map((l) => l.t), [1, 2, 3]);
	assert.equal(lines[2].text, '第二句');
});

test('parseLrc handles multiple timestamps on one line', () => {
	const client = loadClientModule();
	const lines = Array.from(client.parseLrc('[00:01.00][00:02.00]同一句'));
	assert.equal(lines.length, 2);
	assert.deepEqual(lines.map((l) => l.t), [1, 2]);
	assert.equal(lines[0].text, '同一句');
});

test('parseLrc terminates on pathological input (many timestamps, huge text)', () => {
	const client = loadClientModule();
	const line = Array.from({ length: 200 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}.00]`).join('') + 'x'.repeat(10000);
	const start = Date.now();
	const lines = Array.from(client.parseLrc(line));
	assert.ok(Date.now() - start < 5000, '病态输入必须在 5s 内结束');
	assert.ok(lines.length > 0 && lines.length <= 50, '每行时间戳应被上限截断');
});
