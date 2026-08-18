import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function toChildren(children) {
	return children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
}

function loadClient() {
	let definition;
	const react = {
		createElement(type, props, ...children) {
			return { type, props: { ...(props || {}), children: toChildren(children) } };
		},
		useCallback(fn) { return fn; }, useEffect() {},
		useRef(value) { return { current: value }; },
		useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; }
	};
	const sandbox = {
		clearInterval() {}, clearTimeout() {},
		document: { body: { appendChild() {} }, head: { appendChild() {} }, createElement() { return { dataset: {}, parentNode: { removeChild() {} } }; } },
		fetch() { throw new Error('effects stay inactive in unit tests'); },
		localStorage: { getItem() { return null; }, setItem() {} },
		setInterval() { return 1; }, setTimeout() { return 1; },
		window: { __ModuleLoader__: { load(value) { definition = value; } }, addEventListener() {}, removeEventListener() {}, innerHeight: 900, innerWidth: 1440 }
	};
	vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
	return definition.factory((name) => {
		if (name === 'react') return react;
		if (name === 'react-dom') return { render() {}, unmountComponentAtNode() {} };
		throw new Error(`unexpected client dependency: ${name}`);
	});
}

test('catalog contains Classic plus the six approved first-wave characters', () => {
	const { MOONY_CATALOG } = loadClient();
	assert.deepEqual(Array.from(MOONY_CATALOG, (pet) => pet.id), ['classic', 'pulse', 'echo', 'drift', 'spark', 'chorus', 'hush']);
	assert.equal(new Set(Array.from(MOONY_CATALOG, (pet) => pet.id)).size, 7);
	for (const pet of MOONY_CATALOG) {
		assert.match(pet.name, /^Moony/);
		assert.match(pet.colors.ear, /^#[0-9A-F]{6}$/);
		assert.match(pet.colors.highlight, /^#[0-9A-F]{6}$/);
		assert.match(pet.colors.rim, /^#[0-9A-F]{6}$/);
	}
});

test('resolver falls back to Classic, idle, and a blank face', () => {
	const { resolveMoonyState } = loadClient();
	const value = resolveMoonyState({ petId: 'missing', agentStatus: 'unknown', mediaUrl: '' });
	assert.equal(value.pet.id, 'classic');
	assert.equal(value.status, 'idle');
	assert.equal(value.faceMode, 'blank');
	assert.equal(value.mediaUrl, null);
});

test('resolver accepts approved states and trimmed media URLs', () => {
	const { resolveMoonyState } = loadClient();
	const value = resolveMoonyState({ petId: 'echo', agentStatus: 'review', mediaUrl: ' https://img.test/a.jpg ' });
	assert.equal(value.pet.id, 'echo');
	assert.equal(value.status, 'review');
	assert.equal(value.faceMode, 'media');
	assert.equal(value.mediaUrl, 'https://img.test/a.jpg');
});

function flattenChildren(value) {
	if (Array.isArray(value)) return value.flatMap(flattenChildren);
	return value === undefined || value === null || value === false ? [] : [value];
}

function findNodes(root, predicate) {
	const found = [];
	(function visit(node) {
		if (!node || typeof node !== 'object') return;
		if (predicate(node)) found.push(node);
		for (const child of flattenChildren(node.props?.children)) visit(child);
	})(root);
	return found;
}

test('idle Classic has a blank face with no image, Emoji, or tail', () => {
	const { MoonyPet } = loadClient();
	const tree = MoonyPet({ petId: 'classic', agentStatus: 'idle', mediaUrl: null, isPlaying: false });
	assert.equal(findNodes(tree, (node) => node.type === 'img').length, 0);
	assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-pet-emoji')).length, 0);
	assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-moony-tail')).length, 0);
	assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-moony-face')).length, 1);
});

test('Echo renders one tail and media only inside the face layer', () => {
	const { MoonyPet } = loadClient();
	const tree = MoonyPet({ petId: 'echo', agentStatus: 'running', mediaUrl: 'https://img.test/singer.jpg', isPlaying: true });
	const images = findNodes(tree, (node) => node.type === 'img');
	assert.equal(images.length, 1);
	assert.equal(images[0].props.src, 'https://img.test/singer.jpg');
	assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-moony-tail')).length, 1);
	const target = { hidden: false };
	images[0].props.onError({ currentTarget: target });
	assert.equal(target.hidden, true);
});

test('Moony CSS defines every skin, tail, signal, and reduced-motion fallback', () => {
	const { MOONY_CSS } = loadClient();
	for (const ear of ['classic', 'pulse', 'echo', 'drift', 'spark', 'chorus', 'hush']) {
		assert.match(MOONY_CSS, new RegExp(`data-moony-ear=["']${ear}["']`));
	}
	for (const tail of ['orbit', 'comet', 'curl']) {
		assert.match(MOONY_CSS, new RegExp(`data-moony-tail=["']${tail}["']`));
	}
	assert.match(MOONY_CSS, /--moony-signal/);
	assert.match(MOONY_CSS, /prefers-reduced-motion:\s*reduce/);
	assert.match(MOONY_CSS, /dsa-agent-running \.dsa-moony-tail/);
	assert.match(MOONY_CSS, /dsa-agent-failed \.dsa-moony-tail/);
	assert.doesNotMatch(MOONY_CSS, /dsa-agent-running[^}]*background:/);
});

test('Moony signal states glow at the ear outline without replacing base ear color', () => {
	const { MOONY_CSS } = loadClient();
	for (const state of ['running', 'waiting', 'failed', 'review']) {
		assert.match(MOONY_CSS, new RegExp(`dsa-agent-${state} \\.dsa-moony-ear`));
		assert.doesNotMatch(MOONY_CSS, new RegExp(`dsa-agent-${state}[^}]*background:`));
	}
	assert.match(MOONY_CSS, /border-color:var\(--moony-signal\)/);
	assert.match(MOONY_CSS, /drop-shadow\(0 0 5px var\(--moony-signal\)\)/);
	assert.match(MOONY_CSS, /dsa-agent-failed \.dsa-moony-ear\{[^}]*animation:dsa-moony-failed \.24s linear 3/);
	assert.doesNotMatch(MOONY_CSS, /@keyframes dsa-moony-(?:running|waiting|failed|review)[^{]*\{[^}]*transform:/);
});

test('Hush exposes its complete signal above the media face without raising ears over it', () => {
	const { MOONY_CSS } = loadClient();
	const hushRule = MOONY_CSS.match(/data-moony-ear='hush'\] \.dsa-moony-ear\{([^}]*)\}/)?.[1];
	const earRule = MOONY_CSS.match(/\.dsa-moony-ear\{([^}]*)\}/)?.[1];
	const faceRule = MOONY_CSS.match(/\.dsa-moony-face\{([^}]*)\}/)?.[1];
	const signalRule = MOONY_CSS.match(/\.dsa-moony-signal\{([^}]*)\}/)?.[1];
	assert.ok(hushRule && earRule && faceRule && signalRule);
	const hushTop = Number(hushRule.match(/top:(-\d+)px/)?.[1]);
	const signalTop = Number(signalRule.match(/top:(\d+)px/)?.[1]);
	const signalHeight = Number(signalRule.match(/height:(\d+)px/)?.[1]);
	assert.ok(-hushTop >= signalTop + signalHeight, 'Hush must expose the full ear signal above the face');
	assert.match(earRule, /z-index:1/);
	assert.match(faceRule, /z-index:3/);
});

test('running reversal only targets the Moony right ear', () => {
	const { MOONY_CSS } = loadClient();
	assert.match(MOONY_CSS, /\.dsa-agent-running \.dsa-moony-ear\.right\{animation-direction:alternate-reverse/);
	assert.doesNotMatch(MOONY_CSS, /\.dsa-agent-running \.right\{/);
});
