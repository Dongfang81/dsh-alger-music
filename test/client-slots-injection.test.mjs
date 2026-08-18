import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const UI_SLOTS_PACKAGE = '@deepseek-ai/dsh-client-ui-slots';

function toChildren(children) {
	return children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
}

function loadClientHarness() {
	let definition;
	let mountedPlayer;
	const react = {
		createElement(type, props, ...children) {
			return { type, props: { ...(props || {}), children: toChildren(children) } };
		},
		useCallback(fn) {
			return fn;
		},
		useEffect() {},
		useRef(value) {
			return { current: value };
		},
		useState(value) {
			return [typeof value === 'function' ? value() : value, () => {}];
		}
	};
	const reactDom = {
		render(element) {
			mountedPlayer = element;
		},
		unmountComponentAtNode() {}
	};
	const document = {
		body: { appendChild() {} },
		head: { appendChild() {} },
		createElement() {
			return { dataset: {}, parentNode: { removeChild() {} } };
		}
	};
	const sandbox = {
		clearInterval() {},
		clearTimeout() {},
		document,
		fetch() {
			throw new Error('effects must stay inactive in this client render test');
		},
		localStorage: { getItem() { return null; }, setItem() {} },
		setInterval() { return 1; },
		setTimeout() { return 1; },
		window: {
			__ModuleLoader__: {
				load(value) {
					definition = value;
				}
			},
			addEventListener() {},
			innerHeight: 900,
			innerWidth: 1440,
			removeEventListener() {}
		}
	};
	vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
	const client = definition.factory((name) => {
		if (name === 'react') return react;
		if (name === 'react-dom') return reactDom;
		throw new Error(`unexpected client dependency: ${name}`);
	});
	return { client, mountedPlayer: () => mountedPlayer };
}

function mountClient(harness) {
	const profile = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	const registrations = [];
	const hostProvidesSlots = profile.dsh?.client?.inject?.includes(UI_SLOTS_PACKAGE) === true;
	const services = {
		effect(callback) {
			callback();
		},
		slots: hostProvidesSlots
			? {
					inject(name, callback) {
						assert.equal(name, 'sidebar.footer.action');
						callback();
					},
					register(descriptor, component) {
						registrations.push({ descriptor, component });
					}
				}
			: undefined
	};
	const ctx = new Proxy(services, {
		get(target, property) {
			if (property === 'slots' && !harness.client.inject.includes('slots')) {
				throw new Error('cannot get property "slots" without inject');
			}
			return target[property];
		}
	});
	harness.client.apply(ctx);
	return registrations;
}

function toggleButtonOf(registrations) {
	const entry = registrations.find(({ descriptor }) => descriptor.id === 'moony-singer-pet-toggle');
	assert.ok(entry, 'Moony footer action must be registered');
	let element = entry.component({ wide: true });
	while (element && typeof element.type === 'function') element = element.type(element.props);
	return element;
}

test('client adds the Moony toggle through the additive sidebar footer slot', () => {
	const harness = loadClientHarness();
	const registrations = mountClient(harness);

	assert.deepEqual(
		registrations.map(({ descriptor: { name, id, order } }) => ({ name, id, order })),
		[{ name: 'sidebar.footer.action', id: 'moony-singer-pet-toggle', order: 999 }]
	);
});

test('Moony toggle uses the same full-width footer action shape as one-click restart', () => {
	const toggle = toggleButtonOf(mountClient(loadClientHarness()));
	assert.equal(toggle.type, 'div');
	assert.deepEqual(
		{ padding: toggle.props.style.padding, width: toggle.props.style.width },
		{ padding: '4px 2px 2px', width: '100%' }
	);
	const button = toggle.props.children;
	assert.equal(button.type, 'button');
	assert.equal(button.props.children, '♪ 音乐宠物');
	assert.deepEqual(
		{
			borderRadius: button.props.style.borderRadius,
			display: button.props.style.display,
			fontSize: button.props.style.fontSize,
			lineHeight: button.props.style.lineHeight,
			padding: button.props.style.padding,
			width: button.props.style.width
		},
		{
			borderRadius: 10,
			display: 'flex',
			fontSize: 13,
			lineHeight: '20px',
			padding: '8px 12px',
			width: '100%'
		}
	);
});

test('closing Moony renders no floating ghost and leaves the footer toggle as the reopen control', () => {
	const harness = loadClientHarness();
	const toggle = toggleButtonOf(mountClient(harness));
	const button = toggle.type === 'button' ? toggle : toggle.props.children;
	button.props.onClick();

	const mountedPlayer = harness.mountedPlayer();
	assert.equal(typeof mountedPlayer.type, 'function');
	assert.equal(mountedPlayer.type(), null);
});
