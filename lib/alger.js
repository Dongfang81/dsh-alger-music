/**
 * dsh-alger-music/lib/alger.js —— AlgerMusicPlayer 本地客户端。
 *
 * AlgerMusicPlayer 自带两个本地服务 + 一个可选的 CDP 调试口：
 *  1. 网易云音乐 API 服务（默认 30488，仅回环）—— 搜索 / 歌曲详情 / 歌词 / 播放地址 / 歌单；
 *  2. 远程控制服务（默认 31888，默认关闭）—— /api/status、/api/toggle-play、/api/prev、
 *     /api/next、/api/volume-up、/api/volume-down、/api/toggle-favorite；
 *  3. CDP（--remote-debugging-port=9333）—— 用于把指定歌曲塞进 App 播放器直接开播。
 *
 * 本模块只做两件事：HTTP 调用两个本地服务、通过注入的 subprocess spawn 启动/退出 App、
 * 读写 App 的 electron-store 配置文件（开启远程控制）。
 *
 * @module dsh-alger-music/lib/alger
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** App 的 electron-store 配置文件路径（macOS）。 */
export function configFilePath() {
	return join(homedir(), 'Library', 'Application Support', 'AlgerMusicPlayer', 'config.json');
}

/** 读 App 配置文件；文件不存在/损坏时返回空对象。 */
export function readAppConfig() {
	try {
		return JSON.parse(readFileSync(configFilePath(), 'utf8'));
	} catch {
		return {};
	}
}

/** 写回 App 配置文件（保留制表符缩进，与 electron-store 默认一致）。 */
export function writeAppConfig(cfg) {
	writeFileSync(configFilePath(), JSON.stringify(cfg, null, '\t') + '\n', 'utf8');
}

/** 确保远程控制已开启：写 remoteControl 配置（仅允许本机回环访问）。返回是否发生了写入。 */
export function enableRemoteControl(remotePort) {
	const cfg = readAppConfig();
	const cur = cfg.remoteControl ?? {};
	const next = {
		enabled: true,
		port: Number(remotePort) || 31888,
		allowedIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1']
	};
	const changed =
		cur.enabled !== next.enabled || cur.port !== next.port ||
		JSON.stringify(cur.allowedIps ?? null) !== JSON.stringify(next.allowedIps);
	if (!changed) return false;
	cfg.remoteControl = next;
	writeAppConfig(cfg);
	return true;
}

/** 读取当前 remoteControl 配置（不存在时返回默认关闭态）。 */
export function readRemoteControlConfig() {
	return readAppConfig().remoteControl ?? { enabled: false, port: 31888, allowedIps: [] };
}

/**
 * 构造 AlgerMusicPlayer 客户端。
 * @param {object} cfg - 插件配置（见 index.js DEFAULTS）
 * @param {(opts:object)=>object} spawn - 宿主 subprocess 服务（ctx.subprocess.spawn），
 *   handle.done 提供 {exitCode, signal}，handle.collected.<fd>.readFrom(0).text 提供输出。
 */
export function createClient(cfg, spawn) {
	const apiBase = `http://127.0.0.1:${cfg.musicApiPort}`;
	const remoteBase = `http://127.0.0.1:${cfg.remotePort}`;
	const cdpBase = `http://127.0.0.1:${cfg.cdpPort}`;

	/** 运行一个 argv 命令（无 shell）。 */
	async function run(argv, timeoutMs = cfg.timeoutMs) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error('命令超时: ' + argv.join(' '))), timeoutMs);
		try {
			const handle = spawn({
				argv,
				cwd: process.cwd(),
				stdio: {
					stdin: 'ignore',
					stdout: { maxBytes: 4 * 1024 * 1024 },
					stderr: { maxBytes: 4 * 1024 * 1024 }
				},
				graceMs: 2000,
				signal: controller.signal
			});
			const outcome = await handle.done;
			return {
				exitCode: outcome.exitCode,
				signal: outcome.signal,
				stdout: handle.collected.stdout?.readFrom(0).text ?? '',
				stderr: handle.collected.stderr?.readFrom(0).text ?? ''
			};
		} finally {
			clearTimeout(timer);
		}
	}

	/** GET 并解析 JSON；失败抛带上下文的中文错误。 */
	async function getJson(url, timeoutMs = cfg.timeoutMs) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error('请求超时: ' + url)), timeoutMs);
		let res;
		try {
			res = await fetch(url, { signal: controller.signal });
		} catch (error) {
			throw new Error('无法连接 ' + url + '：' + ((error && error.message) || String(error)));
		} finally {
			clearTimeout(timer);
		}
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status} ${url}：${text.slice(0, 200)}`);
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	/** POST（远程控制命令）。 */
	async function postJson(url, timeoutMs = cfg.timeoutMs) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error('请求超时: ' + url)), timeoutMs);
		let res;
		try {
			res = await fetch(url, { method: 'POST', signal: controller.signal });
		} catch (error) {
			throw new Error('无法连接 ' + url + '：' + ((error && error.message) || String(error)));
		} finally {
			clearTimeout(timer);
		}
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status} ${url}：${text.slice(0, 200)}`);
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	/** 轮询直到条件成立或超时。 */
	async function waitUntil(check, label, timeoutMs = cfg.timeoutMs, intervalMs = 400) {
		const deadline = Date.now() + timeoutMs;
		let lastError = null;
		while (Date.now() < deadline) {
			try {
				if (await check()) return true;
			} catch (error) {
				lastError = error;
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
		const hint = lastError ? `（最近错误: ${lastError.message}）` : '';
		throw new Error(`等待 ${label} 超时（${Math.round(timeoutMs / 1000)}s）${hint}`);
	}

	return {
		apiBase,
		remoteBase,
		cdpBase,
		run,
		getJson,
		postJson,
		waitUntil,

		// ---------- App 本体 ----------
		appInstalled() {
			return existsSync(cfg.appPath);
		},
		async appRunning() {
			const res = await run(['pgrep', '-f', cfg.appName]);
			return res.exitCode === 0;
		},
		async quitApp() {
			return run(['osascript', '-e', `tell application "${cfg.appName}" to quit`]);
		},
		async launchApp({ cdp = cfg.enableCdp } = {}) {
			const argv = ['open', '-a', cfg.appName];
			if (cdp) {
				argv.push('--args', `--remote-debugging-port=${cfg.cdpPort}`);
				await run(argv, 15000);
				// 个别环境（如受限 shell）open 不传 --args：等几秒，CDP 没起就退回直接启动二进制
				const deadline = Date.now() + 8000;
				while (Date.now() < deadline) {
					if (await this.cdpUp()) return { method: 'open', cdp: true };
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				const bin = join(cfg.appPath, 'Contents', 'MacOS', cfg.appName);
				if (existsSync(bin)) {
					await run([bin, '--no-sandbox', `--remote-debugging-port=${cfg.cdpPort}`], 15000);
					return { method: 'binary', cdp: true };
				}
				return { method: 'open', cdp: true };
			}
			await run(argv, 15000);
			return { method: 'open', cdp: false };
		},

		// ---------- 服务探活 ----------
		async musicApiUp() {
			try {
				await getJson(`${apiBase}/search?keywords=test&limit=1`, 3000);
				return true;
			} catch {
				return false;
			}
		},
		async remoteUp() {
			try {
				await getJson(`${remoteBase}/api/status`, 3000);
				return true;
			} catch {
				return false;
			}
		},
		async cdpUp() {
			try {
				await getJson(`${cdpBase}/json/list`, 3000);
				return true;
			} catch {
				return false;
			}
		},

		// ---------- 远程控制（31888） ----------
		async remoteStatus() {
			const data = await getJson(`${remoteBase}/api/status`);
			return {
				ok: true,
				isPlaying: Boolean(data.isPlaying),
				song: data.currentSong
					? {
							id: data.currentSong.id,
							name: data.currentSong.name,
							artists: (data.currentSong.ar || data.currentSong.artists || [])
								.map((a) => a.name)
								.join(', '),
							album: data.currentSong.al?.name || data.currentSong.album?.name || ''
						}
					: null
			};
		},
		async remoteCommand(action) {
			const allowed = ['toggle-play', 'prev', 'next', 'volume-up', 'volume-down', 'toggle-favorite'];
			if (!allowed.includes(action)) throw new Error('不支持的远程控制动作: ' + action);
			return postJson(`${remoteBase}/api/${action}`);
		},

		// ---------- 网易云 API（30488） ----------
		async search(keywords, type = 1, limit = 10) {
			const data = await getJson(
				`${apiBase}/search?keywords=${encodeURIComponent(keywords)}&type=${type}&limit=${limit}`
			);
			if (data.code !== 200) throw new Error('搜索失败: ' + JSON.stringify(data).slice(0, 200));
			const r = data.result || {};
			return r;
		},
		async songDetail(ids) {
			const data = await getJson(`${apiBase}/song/detail?ids=${ids}`);
			if (data.code !== 200) throw new Error('获取歌曲详情失败: ' + JSON.stringify(data).slice(0, 200));
			return (data.songs || [])[0] ?? null;
		},
		async lyric(id) {
			const data = await getJson(`${apiBase}/lyric?id=${id}`);
			return data?.lrc?.lyric ?? null;
		},
		async songUrl(id, level = 'higher') {
			const data = await getJson(`${apiBase}/song/url?id=${id}&level=${level}`);
			return data?.data?.[0]?.url ?? null;
		},
		async playlist(id, limit = 100) {
			const data = await getJson(`${apiBase}/playlist/detail?id=${id}&limit=${limit}`);
			if (data.code !== 200) throw new Error('获取歌单失败: ' + JSON.stringify(data).slice(0, 200));
			return data.playlist ?? null;
		}
	};
}
