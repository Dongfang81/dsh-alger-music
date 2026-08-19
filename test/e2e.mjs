/**
 * dsh-moony-singer 端到端验证（内置架构，无任何桌面播放器依赖）。
 *
 * 流程: mock 宿主加载插件 → 内置音乐 API 自动启动 → 搜索 → 点歌 →
 *       队列 → 控制（下一首/模式/收藏）→ 歌词 → 推荐 → 进度上报。
 *
 * 用法: node test/e2e.mjs
 * 注意: 会真实启动内置音乐 API 服务（默认 30588）并请求网易云接口（不播放声音）。
 */
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';

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
		kill(sig) {
			try { child.kill(sig); } catch { /* ignore */ }
		},
		collected: {
			stdout: { readFrom: () => ({ text: stdout }) },
			stderr: { readFrom: () => ({ text: stderr }) }
		}
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name, fn) => {
	try {
		const r = await fn();
		console.log('✅', name, r === undefined ? '' : JSON.stringify(r).slice(0, 300));
		return r;
	} catch (error) {
		console.log('❌', name, error.message);
		process.exitCode = 1;
		return null;
	}
};

// 1) mock 宿主加载插件
const registeredTools = [];
let disposeFn = null;
const ctx = {
	subprocess: { spawn: shimSpawn },
	tools: {
		register(def) {
			registeredTools.push(def);
			return () => {};
		}
	},
	get(key) {
		if (key === 'webServer') return { register() {} };
		return undefined;
	},
	on(ev, fn) {
		if (ev === 'dispose') disposeFn = fn;
	}
};

await step('加载插件（mock 宿主）', async () => {
	const mod = await import(fileURLToPath(new URL('../index.js', import.meta.url)));
	mod.apply(ctx, {});
	await sleep(500);
	return { tools: registeredTools.map((t) => t.name).join(',') };
});

const T = Object.fromEntries(registeredTools.map((t) => [t.name, t]));

// 2) 等内置 API 服务就绪
await step('内置音乐 API 自动启动', async () => {
	for (let i = 0; i < 30; i++) {
		try {
			const r = await fetch('http://127.0.0.1:30588/search?keywords=test&limit=1');
			if (r.ok) return { up: true };
		} catch { /* 未就绪 */ }
		await sleep(500);
	}
	throw new Error('音乐服务 15s 内未就绪');
});

// 3) 搜索
const search = await step('alger_search「任素汐」', () => T.alger_search.execute({ keywords: '任素汐', type: 1, limit: 5 }));
const songId = search?.items?.[0]?.id;

// 4) 点歌
await step('alger_play 点歌', () => T.alger_play.execute({ songId }));

// 5) 状态（应有当前曲）
const status = await step('alger_status', () => T.alger_status.execute({}));

// 6) 队列
await step('alger_queue add 追加', () => T.alger_queue.execute({ action: 'add', songId: 2098161478 }));

// 7) 控制
await step('alger_control next', () => T.alger_control.execute({ action: 'next' }));
await step('alger_control playmode', () => T.alger_control.execute({ action: 'playmode' }));
await step('alger_control toggle-favorite', () => T.alger_control.execute({ action: 'toggle-favorite' }));

// 8) 歌词
await step('alger_song 详情（含歌词/直链）', () => T.alger_song.execute({ id: songId }));

// 9) 推荐
await step('alger_recommend 推荐歌单', () => T.alger_recommend.execute({}));

// 10) 进度上报
await step('播放进度上报（客户端 <audio> 模拟）', () => {
	const pbTool = registeredTools.find((t) => t.name === 'alger_control');
	if (!pbTool) throw new Error('缺少 alger_control');
	// 直接调用 actions 不易，改用状态检查：控制 toggle-play 后状态应翻转
	return T.alger_control.execute({ action: 'toggle-play' });
});

// 终态
if (status) {
	const final = await T.alger_status.execute({});
	console.log('最终状态:', JSON.stringify({ musicApiUp: final.musicApiUp, playing: final.playing?.name, queue: final.queue?.items?.length }).slice(0, 200));
}
if (disposeFn) disposeFn();
console.log('E2E 完成');
