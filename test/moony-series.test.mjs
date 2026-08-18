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

test('prototype property pet IDs fall back to Classic', () => {
	const { getMoony, resolveMoonyState } = loadClient();
	for (const id of ['constructor', 'toString', '__proto__']) {
		assert.equal(getMoony(id).id, 'classic');
		assert.equal(resolveMoonyState({ petId: id }).pet.id, 'classic');
	}
});

test('storage keeps valid choices and rejects invalid or unavailable storage', () => {
	const { readStoredMoonyId, writeStoredMoonyId } = loadClient();
	const values = new Map();
	const storage = { getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); } };
	assert.equal(readStoredMoonyId(storage), 'classic');
	assert.equal(writeStoredMoonyId(storage, 'drift'), 'drift');
	assert.equal(readStoredMoonyId(storage), 'drift');
	values.set('dsh-moony-singer:pet-id:v1', 'not-a-pet');
	assert.equal(readStoredMoonyId(storage), 'classic');
	const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
	assert.equal(readStoredMoonyId(blocked), 'classic');
	assert.equal(writeStoredMoonyId(blocked, 'echo'), 'echo');
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

function loadMusicPlayerHarness({ storedId = null, storageUnavailable = false } = {}) {
	let definition;
	let mountedPlayer;
	let tree;
	let hookIndex = 0;
	let effectIndex = 0;
	let activeHooks;
	const musicHooks = [];
	const footerHooks = [];
	const listeners = {};
	const registrations = [];
	const values = new Map(storedId ? [['dsh-moony-singer:pet-id:v1', storedId]] : []);
	const storage = {
		getItem(key) { return values.get(key) ?? null; },
		setItem(key, value) { values.set(key, value); }
	};
	const playerState = {
		agentStatus: 'review',
		playing: { isPlaying: true, song: { id: 'song-1', name: 'Paper Moon', artists: 'Ella', albumPic: 'https://img.test/moon.jpg' } }
	};
	const rerender = function () {
		activeHooks = musicHooks;
		hookIndex = 0;
		effectIndex = 0;
		tree = mountedPlayer.type(mountedPlayer.props);
	};
	const footerToggle = function () {
		const registration = registrations.find(({ descriptor }) => descriptor.id === 'moony-singer-pet-toggle');
		assert.ok(registration, 'Moony footer toggle must be registered');
		activeHooks = footerHooks;
		hookIndex = 0;
		effectIndex = 0;
		let element = registration.component({ wide: true });
		while (element && typeof element.type === 'function') element = element.type(element.props);
		return element;
	};
	const react = {
		createElement(type, props, ...children) {
			return { type, props: { ...(props || {}), children: toChildren(children) } };
		},
		useCallback(fn) { hookIndex++; return fn; },
		useEffect(callback) {
			hookIndex++;
			if (effectIndex++ === 0) callback();
		},
		useRef(value) {
			const index = hookIndex++;
			if (!(index in activeHooks)) activeHooks[index] = { current: value };
			return activeHooks[index];
		},
		useState(value) {
			const index = hookIndex++;
			const hookSet = activeHooks;
			if (!(index in hookSet)) hookSet[index] = hookSet === musicHooks && index === 0 ? playerState : (typeof value === 'function' ? value() : value);
			return [hookSet[index], (next) => {
				hookSet[index] = typeof next === 'function' ? next(hookSet[index]) : next;
				if (hookSet === musicHooks) rerender(); else footerToggle();
			}];
		}
	};
	const document = {
		body: { appendChild() {} },
		head: { appendChild() {} },
		createElement() { return { dataset: {}, parentNode: { removeChild() {} } }; }
	};
	const sandbox = {
		clearInterval() {}, clearTimeout() {}, document,
		fetch() { throw new Error('effects stay inactive in MusicPlayer integration tests'); },
		setInterval() { return 1; }, setTimeout() { return 1; },
		window: {
			__ModuleLoader__: { load(value) { definition = value; } },
			addEventListener(name, callback) { listeners[name] = callback; },
			removeEventListener(name) { delete listeners[name]; },
			innerHeight: 900, innerWidth: 1440
		}
	};
	if (storageUnavailable) {
		Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('storage unavailable'); } });
		Object.defineProperty(sandbox.window, 'localStorage', { get() { throw new Error('storage unavailable'); } });
	} else {
		sandbox.localStorage = storage;
		sandbox.window.localStorage = storage;
	}
	vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
	const client = definition.factory((name) => {
		if (name === 'react') return react;
		if (name === 'react-dom') return { render(element) { mountedPlayer = element; rerender(); }, unmountComponentAtNode() {} };
		throw new Error(`unexpected client dependency: ${name}`);
	});
	client.apply({
		effect(callback) { callback(); },
		slots: {
			inject(name, callback) { assert.equal(name, 'sidebar.footer.action'); callback(); },
			register(descriptor, component) { registrations.push({ descriptor, component }); }
		}
	});
	const renderPickers = function () {
		const render = function (node) {
			if (Array.isArray(node)) return node.map(render);
			if (!node || typeof node !== 'object') return node;
			if (node.type === client.MoonyPicker) return render(node.type(node.props));
			return { ...node, props: { ...node.props, children: render(node.props?.children) } };
		};
		return render(tree);
	};
	return { client, footerToggle, listeners, renderPickers, storage, tree: () => tree };
}

test('MusicPlayer preserves the selected Moony through the collapsed and expanded player flows', () => {
	const harness = loadMusicPlayerHarness({ storedId: 'drift' });
	let pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.deepEqual(Array.from(harness.client.inject), ['slots']);
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);
	assert.deepEqual(
		{ petId: pet.props.petId, agentStatus: pet.props.agentStatus, mediaUrl: pet.props.mediaUrl, isPlaying: pet.props.isPlaying },
		{ petId: 'drift', agentStatus: 'review', mediaUrl: 'https://img.test/moon.jpg', isPlaying: true }
	);

	pet.props.onClick({ stopPropagation() {} });
	let body = findNodes(harness.tree(), (node) => node.props?.className === 'dsa-body')[0];
	let picker = findNodes(body, (node) => node.type === harness.client.MoonyPicker)[0];
	assert.equal(picker.props.selectedId, 'drift');
	const pickerTree = picker.type(picker.props);
	findNodes(pickerTree, (node) => node.props?.['data-moony-choice'] === 'echo')[0].props.onClick();
	assert.equal(harness.storage.getItem('dsh-moony-singer:pet-id:v1'), 'echo');
	body = findNodes(harness.tree(), (node) => node.props?.className === 'dsa-body')[0];
	picker = findNodes(body, (node) => node.type === harness.client.MoonyPicker)[0];
	assert.equal(picker.props.selectedId, 'echo');

	findNodes(harness.tree(), (node) => node.type === 'button' && node.props?.title === '收起为宠物 / 展开播放器')[0].props.onClick({ stopPropagation() {} });
	pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	pet.props.onPointerDown({ button: 0, clientX: 10, clientY: 10 });
	harness.listeners.pointermove({ clientX: 20, clientY: 10 });
	pet.props.onClick({ stopPropagation() {} });
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);
	pet.props.onClick({ stopPropagation() {} });
	body = findNodes(harness.tree(), (node) => node.props?.className === 'dsa-body')[0];
	assert.equal(findNodes(body, (node) => node.type === harness.client.MoonyPicker).length, 1);
});

test('MusicPlayer keeps character selection usable when acquiring localStorage throws', () => {
	const harness = loadMusicPlayerHarness({ storageUnavailable: true });
	const pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.equal(pet.props.petId, 'classic');
	assert.doesNotThrow(() => pet.props.onClick({ stopPropagation() {} }));
	const picker = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker)[0];
	const pickerTree = picker.type(picker.props);
	assert.doesNotThrow(() => findNodes(pickerTree, (node) => node.props?.['data-moony-choice'] === 'hush')[0].props.onClick());
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker)[0].props.selectedId, 'hush');
});

test('MusicPlayer hides through the footer control and renders one picker only inside the expanded body', () => {
	const harness = loadMusicPlayerHarness({ storedId: 'pulse' });
	let footer = harness.footerToggle();
	footer.props.children.props.onClick();
	assert.equal(harness.tree(), null);

	footer = harness.footerToggle();
	footer.props.children.props.onClick();
	let pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.ok(pet);
	pet.props.onClick({ stopPropagation() {} });
	const rendered = harness.renderPickers();
	const body = findNodes(rendered, (node) => node.props?.className === 'dsa-body')[0];
	const allPickers = findNodes(rendered, (node) => node.props?.className === 'dsa-moony-picker');
	assert.equal(allPickers.length, 1);
	assert.equal(findNodes(body, (node) => node.props?.className === 'dsa-moony-picker').length, 1);
});

test('picker exposes seven buttons and selects the clicked character', () => {
	const { MoonyPicker } = loadClient();
	let selected = null;
	const tree = MoonyPicker({ selectedId: 'classic', onSelect(id) { selected = id; } });
	const buttons = findNodes(tree, (node) => node.type === 'button');
	assert.equal(buttons.length, 7);
	assert.equal(buttons[0].props['aria-pressed'], true);
	buttons.find((button) => button.props['data-moony-choice'] === 'chorus').props.onClick();
	assert.equal(selected, 'chorus');
});

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
