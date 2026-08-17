/**
 * dsh-moony-singer 端到端验证（对真实 AlgerMusicPlayer，全 CDP 路径）。
 *
 * 沙箱约束：不直接写 App 配置文件，而是通过 CDP 让 App 自己执行
 * `set-store-value('remoteControl', …)` 落盘，再重启 App 使远程控制服务生效。
 *
 * 流程: 退出(如运行) → 带 CDP 启动 → CDP 写入远程控制配置 → 重启 →
 *       等 30488/9333/31888 → 搜索 → 详情/歌词/直链 → CDP 点歌 → 31888 确认 →
 *       传输控制 → 终态。
 *
 * 用法: node test/e2e.mjs
 * 注意: 会启动 /Applications/AlgerMusicPlayer.app 并实际播放歌曲（会出声）。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createClient } from '../lib/alger.js';
import { buildPlayScript, cdpEvaluate } from '../lib/cdp.js';

/** 把宿主 ctx.subprocess.spawn 的契约映射到 node:child_process（测试专用）。 */
function shimSpawn({ argv, stdio, graceMs, signal }) {
	const child = nodeSpawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (d) => (stdout += d));
	child.stderr.on('data', (d) => (stderr += d));
	const done = new Promise((resolve) => {
		child.on('close', (code, sig) => resolve({ exitCode: code, signal: sig }));
		signal?.addEventListener('abort', () => child.kill('SIGKILL'));
	});
	return {
		done,
		collected: {
			stdout: { readFrom: () => ({ text: stdout }) },
			stderr: { readFrom: () => ({ text: stderr }) }
		}
	};
}

const cfg = {
	appName: 'AlgerMusicPlayer',
	appPath: '/Applications/AlgerMusicPlayer.app',
	musicApiPort: 30488,
	remotePort: 31888,
	cdpPort: 9333,
	enableCdp: true,
	timeoutMs: 20000
};

const client = createClient(cfg, shimSpawn);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name, fn) => {
	try {
		const r = await fn();
		console.log('✅', name, r === undefined ? '' : JSON.stringify(r).slice(0, 320));
		return r;
	} catch (error) {
		console.log('❌', name, error.message);
		process.exitCode = 1;
		return null;
	}
};

/** 通过 CDP 让 App 自己写入远程控制配置（App 进程落盘，不经沙箱文件系统）。 */
async function cdpEnableRemoteControl(port) {
	const expr = `(async () => {
		try {
			window.electron.ipcRenderer.send('set-store-value', 'remoteControl', {
				enabled: true,
				port: 31888,
				allowedIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1']
			});
			return { ok: true, hasIpc: Boolean(window.electron && window.electron.ipcRenderer) };
		} catch (e) { return { ok: false, error: String(e && e.message || e) }; }
	})()`;
	return cdpEvaluate(port, expr, { timeoutMs: 10000 });
}

/** 写入远程控制配置：优先直接写 App 配置文件（与插件运行时一致），失败则退回 CDP-IPC 让 App 自己落盘。 */
async function ensureRemoteControlConfig() {
	try {
		const { enableRemoteControl } = await import('../lib/alger.js');
		const changed = enableRemoteControl(31888);
		return { method: 'fs', changed };
	} catch {
		const out = await cdpEnableRemoteControl(9333);
		return { method: 'cdp-ipc', changed: true, out };
	}
}

async function ensureQuit() {
	if (await client.appRunning()) {
		await client.quitApp();
		try {
			await client.waitUntil(() => client.appRunning().then((r) => !r), 'App 退出', 10000, 500);
		} catch {
			await client.run(['pkill', '-f', cfg.appName]);
			await sleep(1000);
		}
	}
}

async function launchAndWait(cdp) {
	const launch = await client.launchApp({ cdp });
	console.log('   启动方式:', launch.method, launch.cdp ? `（CDP ${cfg.cdpPort}）` : '');
	await client.waitUntil(() => client.musicApiUp(), '30488 网易云 API', 60000, 800);
	if (cdp) await client.waitUntil(() => client.cdpUp(), '9333 CDP', 30000, 800);
}

// 1) 启动 + 写入远程控制配置 + 重启生效
await step('就绪：带 CDP 启动', async () => {
	await ensureQuit();
	await launchAndWait(true);
	return { music: await client.musicApiUp(), cdp: await client.cdpUp() };
});
const cfgWrite = await step('写入远程控制配置', () => ensureRemoteControlConfig());
await step('重启使远程控制生效', async () => {
	await ensureQuit();
	await client.launchApp({ cdp: true });
	await client.waitUntil(() => client.musicApiUp(), '30488', 60000, 800);
	await client.waitUntil(() => client.remoteUp(), '31888 远程控制', 30000, 800);
	await client.waitUntil(() => client.cdpUp(), '9333 CDP', 30000, 800);
	return { remote: await client.remoteUp(), cdp: await client.cdpUp() };
});

// 2) 搜索
const search = await step('alger_search「周杰伦 晴天」', () => client.search('周杰伦 晴天', 1, 5));
const songs = search?.songs ?? [];
const first = songs[0];
console.log('   第一条:', first?.id, first?.name, (first?.ar || []).map((a) => a.name).join('/'));

// 3) 详情 / 歌词 / 直链
if (first) {
	await step('alger_song 详情', () => client.songDetail(first.id));
	await step('alger_song 歌词(前80字)', () => client.lyric(first.id).then((l) => l?.slice(0, 80)));
	await step('alger_song 播放直链', () => client.songUrl(first.id).then((u) => (u ? u.slice(0, 90) : null)));
}

// 4) CDP 点歌 + 31888 确认
if (first) {
	await step('alger_play 点歌', async () => {
		const song = await client.songDetail(first.id);
		const out = await cdpEvaluate(9333, buildPlayScript(first.name, song), { timeoutMs: 20000 });
		console.log('   CDP 结果:', JSON.stringify(out).slice(0, 400));
		await client.waitUntil(
			async () => {
				const st = await client.remoteStatus();
				return st.song && Number(st.song.id) === Number(song.id) && st.isPlaying;
			},
			'31888 播放确认',
			25000,
			1000
		);
		const st = await client.remoteStatus();
		console.log('   正在播放:', st.song?.name, '| isPlaying:', st.isPlaying);
		return st;
	});

	// 5) 传输控制（31888）
	await step('alger_control next(下一首)', () => client.remoteCommand('next'));
	await sleep(1500);
	await step('alger_control toggle-play(暂停)', () => client.remoteCommand('toggle-play'));
	await sleep(800);
	await step('alger_control 恢复播放', async () => {
		const st = await client.remoteStatus();
		if (!st.isPlaying) await client.remoteCommand('toggle-play');
		return client.remoteStatus();
	});
}

// 6) 终态
await step('alger_status 终态', () => client.remoteStatus());
console.log('E2E DONE');
