import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('browser module registers with the published package name', () => {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const source = readFileSync(join(root, 'client.js'), 'utf8');
	let registeredId;
	const windowStub = {
		__ModuleLoader__: {
			load(spec) {
				registeredId = spec.id;
			}
		}
	};

	new Function('window', source)(windowStub);

	assert.equal(registeredId, pkg.name);
});

test('npm package contains every local asset linked from the published README', () => {
	const cache = mkdtempSync(join(tmpdir(), 'moony-npm-cache-'));
	try {
		const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, npm_config_cache: cache }
		});
		const packedFiles = new Set(JSON.parse(output)[0].files.map((file) => file.path));
		for (const requiredPath of ['README.md', 'docs/IP.md', 'docs/moony-series.png']) {
			assert.ok(packedFiles.has(requiredPath), `${requiredPath} must be included in the npm tarball`);
		}
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});
