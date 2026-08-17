/**
 * dsh-alger-music —— 本地音乐控制插件（服务端工具型 + Web 路由，零运行时依赖）。
 *
 * 驱动开源播放器 AlgerMusicPlayer（macOS /Applications/AlgerMusicPlayer.app）：
 *  - 工具（给模型用）：alger_status / alger_setup / alger_search / alger_song /
 *    alger_playlist / alger_play / alger_control；
 *  - Web 路由（给浏览器浮动窗口 client.js 用）：
 *    GET  /dsh-alger/state    播放器状态快照
 *    POST /dsh-alger/command  远程控制命令 { action }
 *    POST /dsh-alger/search   搜索 { keywords, type?, limit? }
 *    POST /dsh-alger/play     点歌 { keyword? | songId? }
 *    POST /dsh-alger/setup    一键就绪 { action: check|enable|launch|relaunch }
 *
 * 三条本地通道（App 自带）：
 *  - 30488 网易云音乐 API（搜索/详情/歌词/直链/歌单）
 *  - 31888 远程控制（播放/暂停/切歌/音量/收藏/状态；需写入 App 配置开启，仅回环）
 *  - 9333  CDP 调试口（点歌直达播放；需带 --remote-debugging-port 启动）
 *
 * 依赖注入：ctx.subprocess（进程执行）、ctx.tools（工具注册）、ctx.webServer（路由）。
 *
 * @module dsh-alger-music
 */
import { createClient, enableRemoteControl, readRemoteControlConfig } from './lib/alger.js';
import { buildPlayScript, buildGetQueueScript, buildQueueScript, buildQueueJumpScript, buildTogglePlayModeScript, cdpEvaluate } from './lib/cdp.js';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'dsh-alger-music';
export const inject = ['subprocess', 'tools', 'webServer'];

/** 默认配置（可被 cordis.patch.yml 的 config 覆盖）。 */
const DEFAULTS = {
	appName: 'AlgerMusicPlayer',
	appPath: '/Applications/AlgerMusicPlayer.app',
	musicApiPort: 30488,
	remotePort: 31888,
	cdpPort: 9333,
	enableCdp: true,
	timeoutMs: 20000,
	// alger_install 自动安装用的发布版本与镜像（GitHub 被墙时依次兜底）
	installRelease: 'v5.1.0',
	installMirrors: ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/']
};

function resolveConfig(config) {
	const c = config && typeof config === 'object' ? config : {};
	const out = { ...DEFAULTS };
	for (const key of Object.keys(DEFAULTS)) {
		if (c[key] !== undefined && c[key] !== null) out[key] = c[key];
	}
	return out;
}

/** 编译参数 DSL 为 JSON Schema（支持 enum / array / required）。 */
function compileParameters(spec) {
	const properties = {};
	const required = [];
	for (const [key, prop] of Object.entries(spec)) {
		if (prop?.required === true) required.push(key);
		const node = {};
		if (typeof prop?.type === 'string') node.type = prop.type;
		if (typeof prop?.description === 'string') node.description = prop.description;
		if (Array.isArray(prop?.enum) && prop.enum.length > 0) node.enum = prop.enum;
		if (prop?.type === 'array' && prop.items && typeof prop.items === 'object') {
			node.items = { type: prop.items.type || 'string' };
		}
		properties[key] = node;
	}
	return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function asRecord(value) {
	return typeof value === 'object' && value !== null ? value : {};
}

/** 网易云歌曲 → 紧凑结构（与 App 自己展示的字段一致）。 */
function compactSong(item) {
	if (!item) return null;
	return {
		id: item.id,
		name: item.name,
		artists: (item.ar || item.artists || []).map((a) => a.name).join(' / '),
		album: item.al?.name || item.album?.name || '',
		durationMs: item.dt ?? null,
		picUrl: item.al?.picUrl || item.picUrl || ''
	};
}

/** 中文时长格式 mm:ss。 */
function fmtDuration(ms) {
	if (!ms && ms !== 0) return '';
	const s = Math.round(ms / 1000);
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** 判断是否命中“点歌”目标（标题归一化后精确匹配）。 */
function normalize(s) {
	return String(s ?? '').trim().toLowerCase();
}

/**
 * 所有业务动作（工具与 Web 路由共用）。
 */
function buildActions(cfg, client) {
	// 已安装版本（缓存 60s，避免状态轮询时反复 spawn）
	let versionCache = { value: null, at: 0 };
	async function installedVersion() {
		if (!client.appInstalled()) return null;
		if (versionCache.value && Date.now() - versionCache.at < 60000) return versionCache.value;
		try {
			const res = await client.run(
				['defaults', 'read', join(cfg.appPath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'],
				5000
			);
			versionCache = { value: res.exitCode === 0 ? res.stdout.trim() : null, at: Date.now() };
		} catch {
			versionCache = { value: null, at: Date.now() };
		}
		return versionCache.value;
	}

	return {
		/** alger_status */
		async status() {
			const installed = client.appInstalled();
			const running = installed ? await client.appRunning() : false;
			const [musicApiUp, remoteUp, cdpUp] = await Promise.all([
				client.musicApiUp(),
				client.remoteUp(),
				client.cdpUp()
			]);
			let playing = null;
			if (remoteUp) {
				try {
					playing = await client.remoteStatus();
				} catch {
					/* 状态查询失败时降级 */
				}
			}
			// 播放列表 + 播放进度（CDP 可用时读取，不可用时降级为 null）
			let queue = null;
			let playback = null;
			if (cdpUp) {
				try {
					queue = await cdpEvaluate(cfg.cdpPort, buildGetQueueScript(100), { timeoutMs: 6000 });
					playback =
						queue && typeof queue.position === 'number'
							? {
									position: queue.position,
									duration: queue.duration,
									playing: Boolean(queue.playing)
								}
							: null;
				} catch {
					/* CDP 读取失败时降级 */
				}
			}
			return {
				ok: true,
				installed,
				version: installed ? await installedVersion() : null,
				running,
				musicApiUp,
				remoteUp,
				cdpUp,
				remoteControl: readRemoteControlConfig(),
				playing,
				playback,
				favorite: queue && typeof queue.favorite === 'boolean' ? queue.favorite : null,
				playMode: queue && typeof queue.playMode === 'number' ? queue.playMode : null,
				queue: queue && Array.isArray(queue.queue) ? { items: queue.queue, index: queue.index ?? -1 } : null
			};
		},

		/** alger_setup */
		async setup(args) {
			const action = String(args?.action ?? 'check');
			const steps = [];
			const log = (s) => steps.push(String(s));
			const installed = client.appInstalled();
			if (!installed) {
				return {
					ok: false,
					steps: [...steps, `未找到 App：${cfg.appPath}。请先安装 AlgerMusicPlayer。`],
					musicApiUp: false,
					remoteUp: false,
					cdpUp: false
				};
			}
			if (action === 'check') {
				const running = await client.appRunning();
				const [musicApiUp, remoteUp, cdpUp] = await Promise.all([
					client.musicApiUp(),
					client.remoteUp(),
					client.cdpUp()
				]);
				return { ok: running && musicApiUp && remoteUp, steps, running, musicApiUp, remoteUp, cdpUp };
			}
			if (action === 'enable') {
				const changed = enableRemoteControl(cfg.remotePort);
				log(changed ? `已写入远程控制配置（端口 ${cfg.remotePort}，仅本机回环）` : '远程控制配置已是最新，无需写入');
				log('注意: 配置需重启 App 生效，可继续调用 alger_setup action=relaunch');
				const [musicApiUp, remoteUp, cdpUp] = await Promise.all([
					client.musicApiUp(),
					client.remoteUp(),
					client.cdpUp()
				]);
				return { ok: remoteUp, steps, musicApiUp, remoteUp, cdpUp };
			}
			// launch / relaunch
			const running = await client.appRunning();
			if (action === 'relaunch' && running) {
				log('正在退出正在运行的 App…');
				await client.quitApp();
				try {
					await client.waitUntil(() => client.appRunning().then((r) => !r), 'App 完全退出', 10000, 500);
				} catch {
					log('等待退出超时，尝试强制结束');
					await client.run(['pkill', '-f', cfg.appName]);
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}
			if (action === 'relaunch') {
				const changed = enableRemoteControl(cfg.remotePort);
				log(changed ? `已写入远程控制配置（端口 ${cfg.remotePort}，仅本机回环）` : '远程控制配置已是最新');
			}
			if (!(await client.appRunning())) {
				await client.launchApp({ cdp: cfg.enableCdp });
				log(`已启动 App${cfg.enableCdp ? `（CDP 调试端口 ${cfg.cdpPort}）` : ''}`);
			} else {
				log('App 已在运行');
			}
			const wait = async (label, fn) => {
				try {
					await client.waitUntil(fn, label, cfg.timeoutMs);
					log(`${label}: 在线`);
					return true;
				} catch (error) {
					log(`${label}: 超时（${error.message}）`);
					return false;
				}
			};
			const musicApiUp = await wait('网易云 API ' + cfg.musicApiPort, () => client.musicApiUp());
			const remoteUp = await wait('远程控制 ' + cfg.remotePort, () => client.remoteUp());
			const cdpUp = await wait('CDP 点歌 ' + cfg.cdpPort, () => client.cdpUp());
			return { ok: musicApiUp && remoteUp && cdpUp, steps, musicApiUp, remoteUp, cdpUp };
		},

		/** alger_install：自动下载并安装 AlgerMusicPlayer（按 CPU 架构选 DMG，镜像兜底） */
		async install() {
			const steps = [];
			const log = (s) => steps.push(String(s));
			if (client.appInstalled()) {
				const ver = await installedVersion();
				log(`已安装 AlgerMusicPlayer${ver ? ' ' + ver : ''}，无需重复安装。`);
				return { ok: true, alreadyInstalled: true, version: ver, steps };
			}
			const release = String(cfg.installRelease || 'v5.1.0').replace(/^v/, 'v');
			const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
			const fileName = `AlgerMusicPlayer-${release.replace(/^v/, '')}-mac-${arch}.dmg`;
			const ghUrl = `https://github.com/algerkong/AlgerMusicPlayer/releases/download/${release}/${fileName}`;
			const candidates = ['', ...(Array.isArray(cfg.installMirrors) ? cfg.installMirrors : [])];
			const downloadPath = join(homedir(), 'Downloads', fileName);
			const MIN_SIZE = 50 * 1024 * 1024;

			// 1) 下载（官方直连 + 镜像兜底）
			let downloaded = false;
			for (const base of candidates) {
				const url = base + ghUrl;
				log(`下载 ${url}`);
				try {
					rmSync(downloadPath, { force: true });
					const res = await client.run(['curl', '-sL', '--retry', '2', '-o', downloadPath, url], 600000);
					if (res.exitCode === 0 && existsSync(downloadPath) && statSync(downloadPath).size > MIN_SIZE) {
						downloaded = true;
						log(`下载完成（${Math.round(statSync(downloadPath).size / 1048576)}MB）`);
						break;
					}
					log('下载不完整或失败，尝试下一个源…');
				} catch (error) {
					log(`下载失败: ${(error && error.message) || error}`);
				}
			}
			if (!downloaded) {
				return {
					ok: false,
					steps,
					guidance: `自动下载失败（网络受限？）。可手动下载安装：https://github.com/algerkong/AlgerMusicPlayer/releases/latest（${release}），装好后重新调用 alger_install 即可。`
				};
			}

			// 2) 校验 DMG 完整性
			log('校验 DMG 完整性…');
			const verify = await client.run(['hdiutil', 'verify', downloadPath], 180000);
			if (verify.exitCode !== 0) {
				return { ok: false, steps: [...steps, 'DMG 校验失败，文件可能损坏'], guidance: '请重试 alger_install 或手动下载安装。' };
			}

			// 3) 挂载并安装到 /Applications（旧版先移为备份，不删除）
			let mountPoint = null;
			try {
				const attach = await client.run(['hdiutil', 'attach', '-nobrowse', '-readonly', downloadPath], 60000);
				const line = String(attach.stdout)
					.split('\n')
					.find((l) => l.includes('/Volumes/'));
				mountPoint = line ? line.slice(line.indexOf('/Volumes/')).trim() : null;
				if (!mountPoint) throw new Error('未解析到挂载点');
				log(`已挂载 ${mountPoint}`);
				const appSrc = join(mountPoint, cfg.appName + '.app');
				if (!existsSync(appSrc)) throw new Error(`卷内未找到 ${cfg.appName}.app`);
				if (existsSync(cfg.appPath)) {
					await client.run(['mv', cfg.appPath, cfg.appPath + '.bak'], 30000);
					log('旧版已移到 .bak 备份');
				}
				const copy = await client.run(['cp', '-R', appSrc, cfg.appPath], 300000);
				if (copy.exitCode !== 0) throw new Error('复制到 /Applications 失败（权限不足？）');
				log('已安装到 ' + cfg.appPath);
			} finally {
				if (mountPoint) {
					try {
						await client.run(['hdiutil', 'detach', mountPoint, '-quiet'], 30000);
					} catch {
						/* 忽略卸载失败 */
					}
				}
			}

			// 4) 清理 dmg + 验证版本
			rmSync(downloadPath, { force: true });
			log('已清理安装包');
			versionCache = { value: null, at: 0 };
			const ver = await installedVersion();
			log(`安装完成：AlgerMusicPlayer${ver ? ' ' + ver : ''}。接下来调用 alger_setup action=relaunch 一键就绪。`);
			return { ok: true, steps, version: ver };
		},

		/** alger_search */
		async search(args) {
			const keywords = String(args?.keywords ?? '').trim();
			if (!keywords) throw new Error('请提供搜索关键词 keywords。');
			const type = Number(args?.type) || 1;
			const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
			const result = await client.search(keywords, type, limit);
			let items = [];
			if (type === 1) {
				items = (result.songs || []).map((s) => compactSong(s));
			} else if (type === 10) {
				items = (result.albums || []).map((a) => ({
					id: a.id,
					name: a.name,
					desc: `${a.artist?.name || ''} ${a.company || ''} ${a.publishTime || ''}`.trim()
				}));
			} else if (type === 1000) {
				items = (result.playlists || []).map((p) => ({
					id: p.id,
					name: p.name,
					desc: `${p.creator?.nickname || ''}（${p.playCount ?? 0} 播放）`
				}));
			} else if (type === 1004) {
				items = (result.artists || []).map((a) => ({ id: a.id, name: a.name, desc: `${a.albumSize ?? 0} 张专辑` }));
			} else {
				items = (result.mvs || []).map((m) => ({
					id: m.id,
					name: m.name,
					desc: (m.artists || []).map((x) => x.name).join('/')
				}));
			}
			return { ok: true, keyword: keywords, type, total: items.length, items };
		},

		/** alger_song */
		async song(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的歌曲 id。');
			const [detail, lyricText, url] = await Promise.all([
				client.songDetail(id),
				client.lyric(id).catch(() => null),
				client.songUrl(id).catch(() => null)
			]);
			if (!detail) throw new Error(`未找到歌曲 id=${id}（详情接口无返回）。`);
			return { ...compactSong(detail), lyric: lyricText, url };
		},

		/** 轻量歌词（浮动窗口歌词气泡用，只取 LRC 文本） */
		async lyric(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的歌曲 id。');
			const text = await client.lyric(id);
			return { ok: true, id, lyric: text || null };
		},

		/** 艺术家头像（浮动窗口宠物形象用） */
		async artist(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的艺术家 id。');
			let avatar = null;
			let name = '';
			try {
				const data = await client.getJson(`${client.apiBase}/artist/detail?id=${id}`);
				const a = data?.data?.artist;
				if (a) {
					name = a.name || '';
					avatar = a.avatar || a.img1v1Url || a.cover || a.picUrl || null;
				}
			} catch {
				/* 降级到搜索 */
			}
			if (!avatar) {
				try {
					const r = await client.search(name, 1004, 3);
					const match = (r.artists || []).find((a) => Number(a.id) === Number(id)) || (r.artists || [])[0];
					if (match) avatar = match.img1v1Url || match.picUrl || null;
				} catch {
					/* 忽略 */
				}
			}
			if (avatar) avatar = String(avatar).replace(/^http:\/\//, 'https://');
			return { ok: true, id, name, avatar };
		},

		/** alger_playlist */
		async playlist(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的歌单 id。');
			const limit = Math.min(500, Math.max(1, Number(args?.limit) || 100));
			const pl = await client.playlist(id, limit);
			if (!pl) throw new Error(`未找到歌单 id=${id}。`);
			const tracks = (pl.tracks || []).map((t) => compactSong(t));
			return { ok: true, id, name: pl.name, trackCount: pl.trackCount ?? tracks.length, tracks };
		},

		/** alger_play */
		async play(args) {
			const keyword = String(args?.keyword ?? '').trim();
			const songId = Number(args?.songId);
			const steps = [];
			const log = (s) => steps.push(String(s));

			// 1) 确定目标歌曲
			let song = null;
			if (Number.isFinite(songId) && songId > 0) {
				song = await client.songDetail(songId);
				if (!song)
					return { ok: false, steps: [...steps, `未找到歌曲 id=${songId}`], guidance: '检查 id 是否来自 alger_search。' };
				log(`目标歌曲: [${song.id}] ${song.name}`);
			} else if (keyword) {
				const result = await client.search(keyword, 1, 8);
				const songs = result.songs || [];
				if (songs.length === 0)
					return { ok: false, steps: [...steps, `搜索「${keyword}」无结果`], guidance: '换个关键词试试。' };
				const nk = normalize(keyword);
				song = songs.find((s) => normalize(s.name) === nk) || songs[0];
				log(
					`搜索「${keyword}」命中 ${songs.length} 首，选中: [${song.id}] ${song.name} - ${(song.ar || [])
						.map((a) => a.name)
						.join('/')}`
				);
			} else {
				throw new Error('请提供 keyword 或 songId（二选一）。');
			}

			// 2) 检查 CDP 通道
			if (!(await client.cdpUp())) {
				const running = await client.appRunning();
				return {
					ok: false,
					steps: [...steps, `CDP 点歌通道（${cfg.cdpPort}）不可用`, `App 运行中: ${running ? '是' : '否'}`],
					guidance: running
						? `App 未带调试端口启动。请调用 alger_setup action=relaunch（会重启 App，中断当前播放），然后重试 alger_play。`
						: `App 未运行。请调用 alger_setup action=relaunch 启动并等待就绪，然后重试 alger_play。`
				};
			}

			// 3) CDP 点歌
			const playKw = keyword || song.name || '';
			const script = buildPlayScript(playKw, song);
			let cdpOut;
			try {
				cdpOut = await cdpEvaluate(cfg.cdpPort, script, { timeoutMs: cfg.timeoutMs });
			} catch (error) {
				return {
					ok: false,
					steps: [...steps, `CDP 执行失败: ${error.message}`],
					guidance: '可尝试 alger_setup action=relaunch 后重试；或直接在 App 内搜索播放。'
				};
			}
			steps.push(...(cdpOut?.steps || []));
			if (!cdpOut?.ok) {
				return {
					ok: false,
					steps,
					guidance: cdpOut?.error || '点歌脚本未成功，可直接在 App 内搜索播放，或用 alger_control 控制播放。'
				};
			}

			// 4) 轮询远程控制确认播放
			let confirmed = false;
			try {
				await client.waitUntil(
					async () => {
						const st = await client.remoteStatus();
						return st.song && Number(st.song.id) === Number(song.id) && st.isPlaying;
					},
					'App 播放确认',
					15000,
					700
				);
				confirmed = true;
			} catch {
				/* 确认超时不算失败（App 可能仍在缓冲） */
			}
			log(confirmed ? 'App 状态已确认正在播放该曲' : '已下发播放指令（App 状态暂未确认，可能仍在缓冲）');
			return { ok: true, steps, playedName: song.name, playedId: song.id, confirmed };
		},

		/** alger_queue：播放列表操作（追加 / 插入下一首 / 整单播放） */
		async queue(args) {
			const action = String(args?.action ?? '');
			if (!['add', 'add-all', 'add-next', 'playlist', 'playlist-add', 'jump'].includes(action))
				throw new Error('action 需为 add / add-all / add-next / playlist / playlist-add / jump。');
			const steps = [];
			const log = (s) => steps.push(String(s));

			if (!(await client.cdpUp())) {
				const running = await client.appRunning();
				return {
					ok: false,
					steps: [...steps, `CDP 点歌通道（${cfg.cdpPort}）不可用`, `App 运行中: ${running ? '是' : '否'}`],
					guidance: running
						? `App 未带调试端口启动。请调用 alger_setup action=relaunch 后重试。`
						: `App 未运行。请调用 alger_setup action=relaunch 启动后重试。`
				};
			}

			// 1) 解析歌曲/歌单数据
			let songs = [];
			let mode = 'append';
			if (action === 'playlist' || action === 'playlist-add') {
				const pid = Number(args?.playlistId);
				if (!Number.isFinite(pid)) throw new Error('播放/加入歌单需要 playlistId（来自 alger_search type=1000）。');
				const pl = await client.playlist(pid, 500);
				if (!pl) return { ok: false, steps: [...steps, `未找到歌单 id=${pid}`], guidance: '检查歌单 id 是否来自 alger_search type=1000。' };
				songs = pl.tracks || [];
				mode = action === 'playlist' ? 'replace' : 'append';
				log(`歌单「${pl.name}」共 ${pl.trackCount ?? songs.length} 首，取得 ${songs.length} 首`);
				if (songs.length === 0) return { ok: false, steps, guidance: '歌单里没有可播放的歌曲。' };
			} else if (action === 'add' || action === 'add-next') {
				const songId = Number(args?.songId);
				const keyword = String(args?.keyword ?? '').trim();
				if (Number.isFinite(songId) && songId > 0) {
					const song = await client.songDetail(songId);
					if (!song) return { ok: false, steps: [...steps, `未找到歌曲 id=${songId}`], guidance: '检查 id 是否来自 alger_search。' };
					songs = [song];
					log(`目标歌曲: [${song.id}] ${song.name}`);
				} else if (keyword) {
					const r = await client.search(keyword, 1, 8);
					const list = r.songs || [];
					if (list.length === 0) return { ok: false, steps: [...steps, `搜索「${keyword}」无结果`], guidance: '换个关键词试试。' };
					const nk = normalize(keyword);
					const song = list.find((s) => normalize(s.name) === nk) || list[0];
					songs = [song];
					log(`搜索「${keyword}」选中: [${song.id}] ${song.name} - ${(song.ar || []).map((a) => a.name).join('/')}`);
				} else {
					throw new Error('add / add-next 需要 songId 或 keyword。');
				}
				if (action === 'add-next') mode = 'next';
			} else if (action === 'jump') {
				// 跳转队列位置播放：不解析歌曲数据，直接按 index 走 CDP
				const idx = Number(args?.index);
				if (!Number.isInteger(idx) || idx < 0) throw new Error('jump 需要有效的 index（0 起的整数）。');
				steps.push(`目标队列位置: #${idx}`);
				const script = buildQueueJumpScript(idx);
				let jout;
				try {
					jout = await cdpEvaluate(cfg.cdpPort, script, { timeoutMs: cfg.timeoutMs });
				} catch (error) {
					return { ok: false, steps: [...steps, `CDP 执行失败: ${error.message}`], guidance: '可尝试 alger_setup action=relaunch 后重试。' };
				}
				steps.push(...(jout?.steps || []));
				if (!jout?.ok) return { ok: false, steps, guidance: jout?.error || '跳转播放失败' };
				return { ok: true, steps, mode: 'jump', playedName: jout.playedName, queueLength: jout.queueLength };
			} else {
				// add-all：整批搜索结果加入
				const keyword = String(args?.keyword ?? '').trim();
				if (!keyword) throw new Error('add-all 需要 keyword。');
				const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
				const r = await client.search(keyword, 1, limit);
				songs = r.songs || [];
				log(`搜索「${keyword}」命中 ${songs.length} 首（limit=${limit}）`);
				if (songs.length === 0) return { ok: false, steps, guidance: '换个关键词试试。' };
			}

			// 2) CDP 操作播放列表
			const script = buildQueueScript(songs, mode);
			let out;
			try {
				out = await cdpEvaluate(cfg.cdpPort, script, { timeoutMs: cfg.timeoutMs });
			} catch (error) {
				return { ok: false, steps: [...steps, `CDP 执行失败: ${error.message}`], guidance: '可尝试 alger_setup action=relaunch 后重试。' };
			}
			steps.push(...(out?.steps || []));
			if (!out?.ok) return { ok: false, steps, guidance: out?.error || '播放列表操作失败' };
			return { ok: true, steps, mode, added: out.added, queueLength: out.queueLength, playedName: out.playedName ?? null };
		},

		/** alger_control */
		async control(args) {
			const action = String(args?.action ?? '');
			if (!action)
				throw new Error(
					'请提供 action（toggle-play / play / pause / next / prev / volume-up / volume-down / toggle-favorite / playmode）。'
				);
			// 播放模式切换走 CDP（0=列表循环 / 1=单曲循环 / 2=随机）
			if (action === 'playmode') {
				if (!(await client.cdpUp())) {
					throw new Error(`CDP 点歌通道（${cfg.cdpPort}）未就绪。请先调用 alger_setup action=relaunch。`);
				}
				const out = await cdpEvaluate(cfg.cdpPort, buildTogglePlayModeScript(), { timeoutMs: cfg.timeoutMs });
				if (!out?.ok) throw new Error(out?.error || '切换播放模式失败');
				return { action, message: '已切换播放模式', playMode: out.playMode };
			}
			if (!(await client.remoteUp())) {
				throw new Error(`远程控制（${cfg.remotePort}）未就绪。请先调用 alger_setup action=relaunch 开启远程控制并重启 App。`);
			}
			let effective = action;
			if (action === 'play' || action === 'pause') {
				const st = await client.remoteStatus();
				const wantPlay = action === 'play';
				if (st.isPlaying === wantPlay) {
					return { action, message: `当前已是${wantPlay ? '播放' : '暂停'}状态，无需操作`, status: st };
				}
				effective = 'toggle-play';
			}
			const res = await client.remoteCommand(effective);
			await new Promise((resolve) => setTimeout(resolve, 500));
			let status = null;
			try {
				status = await client.remoteStatus();
			} catch {
				/* 状态可选 */
			}
			return { action, message: (res && res.message) || '已发送', status };
		}
	};
}

/**
 * 构造 7 个面向模型的工具（复用 buildActions）。
 */
function buildTools(cfg, actions) {
	const status = {
		name: 'alger_status',
		description:
			'检查 AlgerMusicPlayer 播放器状态：App 是否安装/运行、本地网易云 API(30488)、远程控制(31888)、CDP 点歌通道(9333) 是否在线，以及当前正在播放的歌曲与播放/暂停状态。无副作用。',
		parameters: compileParameters({}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [];
				lines.push(`App 安装: ${rec.installed ? '是' : '否'} | 运行中: ${rec.running ? '是' : '否'}`);
				lines.push(
					`网易云 API ${cfg.musicApiPort}: ${rec.musicApiUp ? '在线' : '离线'} | ` +
						`远程控制 ${cfg.remotePort}: ${rec.remoteUp ? '在线' : '离线'} | ` +
						`CDP 点歌 ${cfg.cdpPort}: ${rec.cdpUp ? '在线' : '离线'}`
				);
				if (rec.remoteControl) {
					const rc = rec.remoteControl;
					lines.push(
						`远程控制配置: ${rc.enabled ? '已开启' : '未开启'}(端口 ${rc.port}，允许 IP: ${(rc.allowedIps || []).join(', ') || '全部'})`
					);
				}
				if (rec.playing) {
					lines.push(
						`正在${rec.playing.isPlaying ? '播放' : '暂停'}: ${rec.playing.name}${rec.playing.artists ? ' - ' + rec.playing.artists : ''}`
					);
				} else {
					lines.push('当前无播放信息（远程控制未就绪或未在播放）');
				}
				if (rec.installed && !rec.running) lines.push('提示: App 未运行，可调用 alger_setup action=launch 启动。');
				if (rec.running && !rec.remoteUp) lines.push('提示: 远程控制未就绪，可调用 alger_setup action=relaunch 一键开启并重启 App。');
				if (rec.running && !rec.cdpUp) lines.push('提示: CDP 点歌通道未就绪（App 未带调试端口启动），点歌前请先 alger_setup action=relaunch。');
				return lines;
			}
		},
		execute: () => actions.status(),
		timeoutMs: cfg.timeoutMs
	};

	const setup = {
		name: 'alger_setup',
		description:
			'让 AlgerMusicPlayer 处于“可被 DSH 控制”的就绪状态：写入 App 配置开启远程控制（仅允许本机回环）、必要时退出并以 CDP 调试端口重启 App、等待 30488/31888/CDP 端口在线。action=check 只检查不动手；action=enable 只写配置（需重启生效）；action=relaunch 一步到位（会退出正在运行的 App，注意会中断当前播放）；action=launch 仅启动 App 并等端口。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['check', 'enable', 'launch', 'relaunch'],
				required: true,
				description: '操作：check=仅检查；enable=开启远程控制配置；launch=启动 App；relaunch=写配置并以 CDP 重启 App（推荐一步到位）。'
			}
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				lines.push(
					`就绪状态: 30488=${rec.musicApiUp ? '在线' : '离线'} 31888=${rec.remoteUp ? '在线' : '离线'} CDP=${rec.cdpUp ? '在线' : '离线'}`
				);
				if (!rec.ok) lines.push('未能完全就绪，请按提示处理。');
				return lines;
			}
		},
		execute: (rawArgs) => actions.setup(asRecord(rawArgs)),
		timeoutMs: Math.max(cfg.timeoutMs, 60000)
	};

	const install = {
		name: 'alger_install',
		description:
			'安装 AlgerMusicPlayer（未安装时）：自动按 CPU 架构（arm64/x64）下载官方 DMG（GitHub 被墙时依次走配置的镜像）、校验完整性、挂载并安装到 /Applications（旧版自动备份为 .bak，不删除）、清理安装包。已安装则直接返回版本。安装完成后调用 alger_setup action=relaunch 一键就绪。',
		parameters: compileParameters({}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				if (rec.ok) lines.push(`安装状态: ${rec.alreadyInstalled ? '已安装（无需操作）' : '完成'}${rec.version ? '，版本 ' + rec.version : ''}`);
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return lines;
			}
		},
		execute: () => actions.install(),
		timeoutMs: 600000
	};

	const search = {
		name: 'alger_search',
		description:
			'用 AlgerMusicPlayer 自带的网易云音乐 API（127.0.0.1:' + cfg.musicApiPort + '）搜索。type=1 歌曲 / 10 专辑 / 1000 歌单 / 1004 歌手 / 1009 MV。返回紧凑列表（含歌曲 id），供 alger_play 点歌。',
		parameters: compileParameters({
			keywords: { type: 'string', required: true, description: '搜索关键词（歌名 / 歌手 / 歌单名）。' },
			type: { type: 'integer', description: '搜索类型：1=歌曲(默认)，10=专辑，1000=歌单，1004=歌手，1009=MV。' },
			limit: { type: 'integer', description: '返回条数，默认 10，最大 50。' }
		}),
		output: {
			schema: { type: 'object', properties: { keyword: { type: 'string' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [`搜索「${rec.keyword}」（type=${rec.type}）共 ${rec.total ?? 0} 条，返回 ${(rec.items || []).length} 条：`];
				(rec.items || []).forEach((item, i) => {
					if (rec.type === 1) {
						lines.push(
							`${i + 1}. [${item.id}] ${item.name} - ${item.artists}（${item.album}${item.durationMs ? '，' + fmtDuration(item.durationMs) : ''}）`
						);
					} else {
						lines.push(`${i + 1}. [${item.id}] ${item.name}${item.desc ? ' - ' + item.desc : ''}`);
					}
				});
				if (!rec.items?.length) lines.push('（无结果）');
				lines.push('提示: 想播放某一首，用 alger_play songId=<id> 或 keyword=<歌名>。');
				return lines;
			}
		},
		execute: (rawArgs) => actions.search(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const song = {
		name: 'alger_song',
		description:
			'获取单曲详情：歌曲信息、歌词、可播放直链（VIP/版权受限歌曲可能拿不到直链，但 AlgerMusicPlayer 应用内可正常播放）。',
		parameters: compileParameters({
			id: { type: 'integer', required: true, description: '歌曲 id（来自 alger_search 结果）。' }
		}),
		output: {
			schema: { type: 'object', properties: { id: { type: 'integer' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [`[${rec.id}] ${rec.name} - ${rec.artists}（${rec.album}，${fmtDuration(rec.durationMs)}）`];
				lines.push(`播放直链: ${rec.url || '（无/受限，请在 App 内播放）'}`);
				if (rec.lyric) {
					const first = String(rec.lyric).split('\n').slice(0, 4).join(' | ');
					lines.push(`歌词(节选): ${first}`);
				} else {
					lines.push('歌词: （无）');
				}
				return lines;
			}
		},
		execute: (rawArgs) => actions.song(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const playlist = {
		name: 'alger_playlist',
		description:
			'获取歌单详情与歌曲列表（通过 App 自带网易云 API，歌单 id 来自 alger_search type=1000 或分享链接的数字部分）。',
		parameters: compileParameters({
			id: { type: 'integer', required: true, description: '歌单 id。' },
			limit: { type: 'integer', description: '返回歌曲数，默认 100，最大 500。' }
		}),
		output: {
			schema: { type: 'object', properties: { id: { type: 'integer' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [
					`歌单「${rec.name}」共 ${rec.trackCount ?? (rec.tracks || []).length} 首，返回前 ${(rec.tracks || []).length} 首：`
				];
				(rec.tracks || []).forEach((t, i) => {
					lines.push(`${i + 1}. [${t.id}] ${t.name} - ${t.artists}${t.durationMs ? '（' + fmtDuration(t.durationMs) + '）' : ''}`);
				});
				return lines;
			}
		},
		execute: (rawArgs) => actions.playlist(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const play = {
		name: 'alger_play',
		description:
			'点歌：让 AlgerMusicPlayer 立即播放指定歌曲。给 songId 播指定单曲；只给 keyword 则搜索并播最佳匹配。走 CDP 通道（与 App 内“播放全部”同一路径），需要 App 已带调试端口运行（alger_setup action=relaunch 可一键就绪）。',
		parameters: compileParameters({
			keyword: { type: 'string', description: '歌名/歌手关键词（与 songId 二选一）。' },
			songId: { type: 'integer', description: '歌曲 id（来自 alger_search，优先于 keyword）。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				if (rec.ok) {
					lines.push(`已点播: ${rec.playedName}${rec.confirmed ? '（App 状态已确认播放）' : '（播放状态待确认）'}`);
				}
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return lines;
			}
		},
		execute: (rawArgs) => actions.play(asRecord(rawArgs)),
		timeoutMs: Math.max(cfg.timeoutMs, 45000)
	};

	const queue = {
		name: 'alger_queue',
		description:
			'播放列表操作（走 CDP，需 App 带调试端口运行）：action=add 把指定歌曲（songId 或 keyword 最佳匹配）追加到播放列表末尾；action=add-all 把某关键词的全部搜索结果（limit 控制数量）一键加入播放列表；action=add-next 插入到当前歌曲之后；action=playlist 按 playlistId 整单播放歌单（替换队列并立即播放第一首）；action=playlist-add 把歌单全部歌曲追加到播放列表末尾（不播放）；action=jump 按 index 跳转播放队列中指定位置的歌曲（队列不变）。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['add', 'add-all', 'add-next', 'playlist', 'playlist-add', 'jump'],
				required: true,
				description: '操作：add=追加单曲；add-all=整批搜索结果加入；add-next=插入下一首；playlist=整单播放歌单；playlist-add=歌单整单追加到播放列表；jump=按 index 跳转播放。'
			},
			songId: { type: 'integer', description: '歌曲 id（add/add-next 用，与 keyword 二选一）。' },
			keyword: { type: 'string', description: '歌名/歌手关键词（add/add-next/add-all 用）。' },
			playlistId: { type: 'integer', description: '歌单 id（playlist/playlist-add 用，来自 alger_search type=1000）。' },
			index: { type: 'integer', description: '队列下标 0 起（jump 用）。' },
			limit: { type: 'integer', description: 'add-all 时最多加入多少首，默认 20，最大 50。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				if (rec.ok) {
					lines.push(
						`已${rec.mode === 'replace' ? '整单播放' : rec.mode === 'next' ? '插入下一首' : '加入播放列表'} ${rec.added} 首，当前队列共 ${rec.queueLength ?? '?'} 首`
					);
					if (rec.playedName) lines.push(`正在播放: ${rec.playedName}`);
				}
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return lines;
			}
		},
		execute: (rawArgs) => actions.queue(asRecord(rawArgs)),
		timeoutMs: Math.max(cfg.timeoutMs, 45000)
	};

	const control = {
		name: 'alger_control',
		description:
			'远程控制 AlgerMusicPlayer 播放：toggle-play 播放/暂停切换、play 播放、pause 暂停、next 下一首、prev 上一首、volume-up 音量加、volume-down 音量减、toggle-favorite 收藏/取消收藏当前歌曲、playmode 切换播放模式（0=列表循环/1=单曲循环/2=随机）。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['toggle-play', 'play', 'pause', 'next', 'prev', 'volume-up', 'volume-down', 'toggle-favorite', 'playmode'],
				required: true,
				description: '要执行的控制动作。'
			}
		}),
		output: {
			schema: { type: 'object', properties: { action: { type: 'string' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [`动作 ${rec.action} 已执行：${rec.message}`];
				if (rec.status) {
					lines.push(
						`当前: ${rec.status.isPlaying ? '播放中' : '已暂停'}${rec.status.song ? ' - ' + rec.status.song.name + (rec.status.song.artists ? '（' + rec.status.song.artists + '）' : '') : ''}`
					);
				}
				return lines;
			}
		},
		execute: (rawArgs) => actions.control(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	return [status, setup, install, search, song, playlist, play, queue, control];
}

/** 读取 POST body（JSON 文本）。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk) => {
			data += chunk;
			if (data.length > 1e6) {
				req.destroy();
				reject(new Error('body too large'));
			}
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

function json(res, body, status = 200) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

/** 注册浏览器浮动窗口用的 Web 路由。 */
function registerRoutes(webServer, actions) {
	const routes = [
		{
			kind: 'exact',
			path: '/dsh-alger/state',
			handler: async (_req, res) => {
				try {
					json(res, await actions.status());
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/command',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.control(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/search',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.search(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/play',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.play(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/queue',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.queue(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/lyric',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.lyric(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/artist',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.artist(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/setup',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.setup(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/install',
			handler: async (_req, res) => {
				try {
					json(res, await actions.install());
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		}
	];
	for (const route of routes) webServer.register(route);
}

/**
 * 插件入口：解析配置、构造客户端、注册 7 个工具与浮动窗口的 Web 路由。
 * @param ctx - 宿主上下文（含 subprocess.spawn、tools.register、webServer.register）。
 * @param config - 插件配置（cordis.patch.yml 中 id=alger-music 的 config）。
 */
export function apply(ctx, config) {
	let cfg;
	try {
		cfg = resolveConfig(config);
	} catch (error) {
		console.warn('[dsh-alger-music] ' + (error instanceof Error ? error.message : String(error)));
		cfg = resolveConfig(null);
	}
	// 注意：不能直接把 ctx.subprocess.spawn 解构出来传参——宿主的 spawn 是类方法，
	// 内部读 this.internals，未绑定调用会抛 “Cannot read properties of undefined (reading 'internals')”。
	// 用箭头包装保持 this 指向 subprocess 服务实例。
	const spawn = (spec) => ctx.subprocess.spawn(spec);
	const client = createClient(cfg, spawn);
	const actions = buildActions(cfg, client);
	const disposers = [];
	for (const definition of buildTools(cfg, actions)) {
		disposers.push(ctx.tools.register(definition));
	}
	const webServer = ctx.get('webServer');
	if (webServer) {
		registerRoutes(webServer, actions);
	}
	if (typeof ctx.on === 'function') {
		ctx.on('dispose', () => {
			for (const dispose of disposers) dispose();
		});
	}
}
