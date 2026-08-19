/**
 * Copyright (C) 2026 DongfangXie (dongfangxie)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * dsh-moony-singer —— 本地音乐播放插件（服务端工具型 + Web 路由）。
 *
 * 自带开源网易云音乐 API 服务（netease-cloud-music-api-alger，MIT），
 * 浮窗内置 <audio> 播放引擎，无需安装任何桌面播放器即可搜索与播放：
 *  - 工具（给模型用）：alger_status / alger_setup / alger_search / alger_song /
 *    alger_playlist / alger_play / alger_control / alger_recommend；
 *  - Web 路由（给浏览器浮动窗口 client.js 用）：
 *    GET  /dsh-alger/state    播放器状态快照
 *    POST /dsh-alger/command  播放控制命令 { action }
 *    POST /dsh-alger/search   搜索 { keywords, type?, limit? }
 *    POST /dsh-alger/play     点歌 { keyword? | songId? }
 *    POST /dsh-alger/url      取歌曲直链 { id }
 *    POST /dsh-alger/playback 播放进度上报（客户端 <audio>）
 *    POST /dsh-alger/setup    内置服务管理 { action: check|start|stop }
 *
 * 单条本地通道：插件自启的音乐 API 服务（默认 30588，仅回环）。
 * 播放状态由内置状态机（lib/player.js）维护，浏览器只负责出声。
 *
 * 依赖注入：ctx.subprocess（进程执行）、ctx.tools（工具注册）、ctx.webServer（路由）。
 *
 * @module dsh-moony-singer
 */
import { createRequire } from 'node:module';
import { createClient } from './lib/alger.js';
import { createPlayer } from './lib/player.js';
import { startApiServer, stopApiServer } from './lib/api-server.js';
import { matchSourceUrl, matchSourceByKeyword } from './lib/source-match.js';

export const name = 'dsh-moony-singer';
export const inject = ['subprocess', 'tools', 'webServer'];

/** 默认配置（可被 cordis.patch.yml 的 config 覆盖）。 */
const DEFAULTS = {
	// 内置音乐 API 服务（插件自启，无需任何桌面播放器）
	musicApiPort: 30588,
	musicApiHost: '127.0.0.1',
	timeoutMs: 20000
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
/**
 * 所有业务动作（工具与 Web 路由共用）。
 *
 * @param {object} cfg - 插件配置
 * @param {object} client - 内置音乐 API 客户端（lib/alger.js）
 * @param {object} shared - 共享状态（notice / agentStatus）
 * @param {object} player - 内置播放状态机（lib/player.js）
 * @param {object} apiHandle - 内置 API 服务状态（{handle, isUp, serverEntryPath}）
 */
function buildActions(cfg, client, shared, player, apiHandle) {
	// 宠物台词/通知（agent → 宠物气泡，约 6 秒）
	const noticeStore = { text: '', until: 0 };
	shared.setNotice = (text, ms = 6000) => {
		noticeStore.text = String(text ?? '').slice(0, 80);
		noticeStore.until = Date.now() + ms;
	};
	shared.getNotice = () => (noticeStore.until > Date.now() ? noticeStore.text : null);

	// 音乐服务是否在线（2s 探活缓存）
	let apiUpCache = { value: false, at: 0 };
	async function apiUp() {
		if (Date.now() - apiUpCache.at < 2000) return apiUpCache.value;
		const up = await client.musicApiUp();
		apiUpCache = { value: up, at: Date.now() };
		if (apiHandle) apiHandle.isUp = up;
		return up;
	}

	/** 原始关键词 → 拆成「歌名 - 歌手」（支持「歌手 歌名」/「歌名 歌手」/「歌名-歌手」）。 */
	function splitKeyword(kw) {
		const s = String(kw || '').trim();
		if (!s) return { name: '', artist: '' };
		// 「歌名 - 歌手」或「歌名-歌手」
		let m = s.match(/^(.+?)\s*[-–—]\s*(.+)$/);
		if (m) return { name: m[1].trim(), artist: m[2].trim() };
		// 空格分隔：视第一个词为歌手、其余为歌名（如「周杰伦 双截棍」）
		const parts = s.split(/\s+/);
		if (parts.length >= 2) {
			return { name: parts.slice(1).join(' '), artist: parts[0] };
		}
		return { name: s, artist: '' };
	}

	/** 取歌曲直链（多级兜底）：
	 *  1) 音乐 API 直链（有版权且歌手与关键词一致时，避免命中翻唱版的直链）；
	 *  2) 歌曲元数据从其他平台匹配（仅当关键词歌手与歌曲一致时）；
	 *  3) 原始关键词匹配（网易云下架/列表只有翻唱时，按「歌名 - 歌手」拿原版音源）。
	 *  返回 { url, displayName? }；displayName 为关键词匹配到的原版标题（与列表歌名不同时提供）；
	 *  无法播放返回 null。 */
	async function urlFor(song, keyword) {
		const kw = String(keyword || '').trim();
		const parts = splitKeyword(kw);
		// 关键词歌手与歌曲歌手是否一致（如「周杰伦 晴天」vs 列表里的 A-LNK 版 → 不一致）
		const songArtists = ((song && (song.ar || song.artists)) || [])
			.map((a) => a && a.name)
			.filter(Boolean)
			.join(' ');
		const consistent = !parts.artist || !songArtists ||
			songArtists.includes(parts.artist) ||
			parts.artist.includes(songArtists.split(/\s+/)[0] || '');
		// 1) 音乐 API 直链（歌手一致才用，避免拿到翻唱版的直链）
		if (song && song.id && consistent) {
			try {
				const url = await client.songUrl(song.id, 'higher');
				if (url) return { url };
			} catch {
				/* 继续兜底 */
			}
		}
		// 2) 歌曲元数据 → 多平台匹配（歌手一致才用，避免匹配到翻唱版）
		if (song && song.name && consistent) {
			try {
				const url = await matchSourceUrl(song);
				if (url) return { url };
			} catch {
				/* 继续兜底 */
			}
		}
		// 3) 原始关键词 → 多平台匹配（覆盖网易云下架/翻唱场景，按「歌名 - 歌手」拿原版）
		if (kw) {
			try {
				// 带上目标时长（若歌曲歌手与关键词一致），让平台匹配能校验版本，避免命中现场串烧/翻唱
				const duration = consistent && song && song.dt ? Number(song.dt) : 0;
				const hit = await matchSourceByKeyword(parts.name || kw, parts.artist, null, duration);
				if (hit && hit.url) {
					// 关键词匹配到的是原版：显示名用「匹配标题 + 关键词歌手」，替换列表里的翻唱信息
					const listName = song && song.name ? String(song.name).trim() : '';
					const hitName = hit.title ? String(hit.title).trim() : parts.name || '';
					const artistName = parts.artist || '';
					const listArtist = songArtists || '';
					const sameName = !listName || hitName === listName;
					const sameArtist = !artistName || !listArtist || listArtist.includes(artistName) || artistName.includes(listArtist.split(/\s+/)[0] || '');
					// 歌名或歌手任一与列表不一致 → 带上 displayName（「歌名 - 歌手」格式）与结构化信息
					if (!sameName || !sameArtist) {
						return {
							url: hit.url,
							displayName: artistName ? hitName + ' - ' + artistName : hitName,
							matchTitle: hitName,
							matchArtist: artistName
						};
					}
					return { url: hit.url };
				}
			} catch {
				/* 返回 null */
			}
		}
		return null;
	}

	return {
		/** alger_status */
		async status(args) {
			const musicApiUp = await apiUp();
			const snap = player.snapshot();
			const token = args && args.token ? String(args.token) : null;
			return {
				ok: true,
				musicApiUp,
				// 当前页面是否为“播放者”（只有它出声；多页面防串音）
				isAudioOwner: player.isOwner(token),
				playing: snap.playing
					? { ok: true, isPlaying: snap.isPlaying, song: snap.playing }
					: null,
				playback: snap.playing
					? { position: snap.position, duration: snap.duration, playing: snap.isPlaying }
					: null,
				favorite: snap.favorite,
				playMode: snap.playMode,
				volume: snap.volume,
				currentUrl: snap.currentUrl,
				ready: snap.ready,
				notice: shared.getNotice ? shared.getNotice() : null,
				agentStatus: shared.getAgentStatus ? shared.getAgentStatus() : 'idle',
				queue: snap.queue
			};
		},

		/** 页面交互上报：声明/抢占播放者身份（多页面防串音） */
		async claim(args) {
			const token = args && args.token ? String(args.token) : null;
			if (!token) throw new Error('缺少 token。');
			const owned = player.claimOwner(token, Boolean(args && args.force));
			return { ok: true, isAudioOwner: owned && player.isOwner(token) };
		},

		/** alger_say：让宠物开口说一句话（气泡提示约 6 秒） */
		async say(args) {
			const text = String(args?.text ?? '').trim();
			if (!text) throw new Error('请提供要说的台词 text（50 字以内）。');
			shared.setNotice(text);
			return { ok: true, text };
		},

		/** alger_recommend：推荐播放（不知道听什么时用） */
		async recommend() {
			const steps = [];
			const log = (s) => steps.push(String(s));
			if (!(await apiUp())) {
				return { ok: false, steps: [...steps, '音乐服务不可用'], guidance: '请先调用 alger_setup action=start 启动音乐服务。' };
			}
			// 1) 拉推荐歌单列表，随机挑一个合适的歌单（过滤曲目过少的）
			let playlists = [];
			try {
				const data = await client.getJson(`${client.apiBase}/personalized?limit=30`);
				playlists = (data?.result || [])
					.filter((p) => p && p.id && p.name && Number(p.trackCount) >= 3)
					.map((p) => ({ id: p.id, name: p.name, trackCount: Number(p.trackCount) || 0 }));
			} catch {
				/* 降级到热门歌单 */
			}
			if (playlists.length === 0) {
				try {
					const data = await client.getJson(`${client.apiBase}/top/playlist?limit=30`);
					playlists = (data?.playlists || [])
						.filter((p) => p && p.id && p.name && Number(p.trackCount) >= 3)
						.map((p) => ({ id: p.id, name: p.name, trackCount: Number(p.trackCount) || 0 }));
				} catch {
					/* 忽略 */
				}
			}
			if (playlists.length === 0) {
				return { ok: false, steps: [...steps, '推荐接口无结果'], guidance: '请稍后再试，或直接搜索点歌。' };
			}
			const plMeta = playlists[Math.floor(Math.random() * playlists.length)];
			log(`随机命中歌单: [${plMeta.id}] ${plMeta.name}（${plMeta.trackCount} 首）`);

			// 2) 取歌单歌曲，整单替换队列播放
			const pl = await client.playlist(plMeta.id, 500);
			const songs = (pl?.tracks || []).filter((s) => s && s.id && s.name);
			if (songs.length === 0) {
				return { ok: false, steps: [...steps, `歌单「${plMeta.name}」无可播放歌曲`], guidance: '请稍后再试。' };
			}
			log(`歌单「${plMeta.name}」共 ${pl?.trackCount ?? songs.length} 首，取得 ${songs.length} 首，从「${songs[0].name}」开始`);
			const song = player.replaceAndPlay(songs);
			const firstHit = await urlFor(song);
			player.state.currentUrl = firstHit ? firstHit.url : null;
			player.state.playing = true;
			shared.setNotice('♫ 推荐歌单：' + plMeta.name + '（' + songs.length + ' 首）');
			return {
				ok: true,
				steps,
				playedName: song ? song.name : '',
				playlistId: plMeta.id,
				playlistName: plMeta.name,
				added: songs.length,
				queueLength: player.state.queue.length
			};
		},

		/** alger_setup：内置音乐服务管理 */
		async setup(args) {
			const action = String(args?.action ?? 'check');
			const steps = [];
			const log = (s) => steps.push(String(s));
			const musicApiUp = await apiUp();
			if (action === 'check') {
				log(`音乐服务 ${cfg.musicApiPort}: ${musicApiUp ? '在线' : '离线'}`);
				return { ok: musicApiUp, steps, musicApiUp };
			}
			if (action === 'stop') {
				if (apiHandle && apiHandle.handle) {
					log('正在停止音乐服务…');
					await stopApiServer(apiHandle.handle);
					apiHandle.handle = null;
					apiHandle.isUp = false;
				}
				log('音乐服务已停止（搜索/播放将不可用，可用 alger_setup action=start 重新启动）');
				return { ok: true, steps, musicApiUp: false };
			}
			// start（默认）
			if (musicApiUp) {
				log(`音乐服务已在运行（${cfg.musicApiPort}），无需启动`);
				return { ok: true, steps, musicApiUp: true };
			}
			if (!apiHandle || !apiHandle.handle) {
				log(`正在启动音乐服务（${cfg.musicApiHost}:${cfg.musicApiPort}）…`);
				const result = startApiServer({
					spawn: (spec) => apiHandle.spawn(spec),
					serverEntryPath: apiHandle.serverEntryPath,
					port: cfg.musicApiPort,
					host: cfg.musicApiHost
				});
				if (!result.ok) return { ok: false, steps: [...steps, result.error || '启动失败'], guidance: '请检查端口占用或插件依赖是否安装完整。' };
				apiHandle.handle = result.handle;
			}
			try {
				await client.waitUntil(() => client.musicApiUp(), '音乐服务就绪', cfg.timeoutMs, 500);
				log(`音乐服务就绪（${cfg.musicApiPort}）`);
				return { ok: true, steps, musicApiUp: true };
			} catch (error) {
				return { ok: false, steps: [...steps, `音乐服务启动超时: ${error.message}`], guidance: '端口可能被占用，可在配置中调整 musicApiPort 后重试。' };
			}
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
			const detail = await client.songDetail(id);
			if (!detail) throw new Error(`未找到歌曲 id=${id}（详情接口无返回）。`);
			const [lyricText, hit] = await Promise.all([
				client.lyric(id).catch(() => null),
				urlFor(detail)
			]);
			return { ...compactSong(detail), lyric: lyricText, url: hit ? hit.url : null };
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

		/** 取歌曲直链（浮动窗口 <audio> 播放用） */
		async songUrl(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的歌曲 id。');
			const url = await client.songUrl(id, 'higher');
			return { ok: true, id, url: url || null };
		},

		/** 播放进度上报（浮动窗口 <audio> 定时上报） */
		async playback(args) {
			const value = asRecord(args);
			player.reportPlayback({
				position: Number(value.position) || 0,
				duration: Number(value.duration) || 0,
				playing: Boolean(value.playing),
				ready: Boolean(value.ready)
			});
			return { ok: true };
		},

		/** alger_play：点歌播放（内置播放引擎，浏览器 <audio> 出声） */
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
				const parts = splitKeyword(keyword);
				// 关键词含歌手时，优先选歌手匹配的歌曲（避免选中同名翻唱版）
				if (parts.artist) {
					const byArtist = songs.find((s) => {
						const names = ((s.ar || s.artists) || []).map((a) => a && a.name).filter(Boolean);
						return names.some((n) => n.includes(parts.artist) || parts.artist.includes(n));
					});
					if (byArtist) song = byArtist;
				}
				if (!song) song = songs.find((s) => normalize(s.name) === nk) || songs[0];
				log(
					`搜索「${keyword}」命中 ${songs.length} 首，选中: [${song.id}] ${song.name} - ${(song.ar || [])
						.map((a) => a.name)
						.join('/')}`
				);
			} else {
				throw new Error('请提供 keyword 或 songId（二选一）。');
			}

			// 2) 确认可播放（多级兜底：网易云直链 → 元数据匹配 → 原始关键词匹配）
			const hit = await urlFor(song, keyword);
			if (!hit) {
				return {
					ok: false,
					steps: [...steps, `「${song.name}」暂无可用播放地址`],
					guidance: '部分歌曲因版权限制无法直接播放，换一首试试。'
				};
			}
			const url = hit.url;

			// 3) 写入播放状态（客户端轮询到 currentUrl 后自动播放）
			// 关键词匹配到原版时，歌曲信息修正为「原版标题 - 歌手」（如 A-LNK 版 → 晴天 - 周杰伦）
			if (hit.matchTitle) {
				song = {
					...song,
					name: hit.matchTitle,
					ar: hit.matchArtist ? [{ id: 0, name: hit.matchArtist }] : (song.ar || []),
					artists: hit.matchArtist ? [{ id: 0, name: hit.matchArtist }] : (song.artists || [])
				};
			}
			player.playSong(song);
			player.state.currentUrl = url;
			shared.setNotice('♪ 已播放：' + song.name);
			return { ok: true, steps, playedName: song.name, playedId: song.id, confirmed: true };
		},

		/** alger_queue：播放列表操作（追加 / 插入下一首 / 整单播放 / 跳转 / 清空） */
		async queue(args) {
			const action = String(args?.action ?? '');
			if (!['add', 'add-all', 'add-next', 'playlist', 'playlist-add', 'jump', 'clear'].includes(action))
				throw new Error('action 需为 add / add-all / add-next / playlist / playlist-add / jump / clear。');
			const steps = [];
			const log = (s) => steps.push(String(s));

			// 清空播放列表
			if (action === 'clear') {
				player.clearQueue();
				log('播放列表已清空');
				return { ok: true, steps, mode: 'clear', queueLength: 0 };
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
				const idx = Number(args?.index);
				if (!Number.isInteger(idx) || idx < 0) throw new Error('jump 需要有效的 index（0 起的整数）。');
				if (idx >= player.state.queue.length) throw new Error(`队列下标越界: ${idx}（队列共 ${player.state.queue.length} 首）`);
				const song = player.jump(idx);
				const hit = await urlFor(song);
				if (!hit) return { ok: false, steps: [...steps, `「${song.name}」暂无可用播放地址`], guidance: '换一首试试。' };
				player.state.currentUrl = hit.url;
				player.state.playing = true;
				return { ok: true, steps, mode: 'jump', playedName: song ? song.name : '', queueLength: player.state.queue.length };
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

			// 2) 操作播放状态
			if (mode === 'replace') {
				const song = player.replaceAndPlay(songs);
				const hit = await urlFor(song);
				player.state.currentUrl = hit ? hit.url : null;
				player.state.playing = true;
				shared.setNotice('♫ 整单播放：' + (song ? song.name : '') + '（' + songs.length + ' 首）');
				return { ok: true, steps, mode, added: songs.length, queueLength: player.state.queue.length, playedName: song ? song.name : null };
			}
			if (mode === 'next') {
				const n = player.insertNext(songs);
				shared.setNotice('＋ 已插入下一首播放 ' + songs.length + ' 首');
				return { ok: true, steps, mode, added: songs.length, queueLength: n };
			}
			const n = player.append(songs);
			shared.setNotice('＋ 已加入播放列表 ' + songs.length + ' 首');
			return { ok: true, steps, mode, added: songs.length, queueLength: n, playedName: null };
		},

		/** alger_control：播放控制（内置状态机） */
		async control(args) {
			const action = String(args?.action ?? '');
			if (!action)
				throw new Error(
					'请提供 action（toggle-play / play / pause / next / prev / volume-up / volume-down / toggle-favorite / playmode）。'
				);
			if (action === 'toggle-play' || action === 'play' || action === 'pause') {
				const wantPlay = action === 'play' ? true : action === 'pause' ? false : !player.state.playing;
				if (player.state.playing === wantPlay) {
					return { action, message: `当前已是${wantPlay ? '播放' : '暂停'}状态，无需操作` };
				}
				player.state.playing = wantPlay;
				return { action, message: wantPlay ? '已播放' : '已暂停', playing: player.state.playing };
			}
			if (action === 'next' || action === 'prev') {
				const song = action === 'next' ? player.next() : player.prev();
				if (!song) throw new Error('队列为空，无法切换。');
				const hit = await urlFor(song);
				if (!hit) throw new Error(`「${song.name}」暂无可用播放地址。`);
				player.state.currentUrl = hit.url;
				player.state.playing = true;
				return { action, message: '已切到：' + song.name, song: song.name, playing: true };
			}
			if (action === 'volume-up' || action === 'volume-down') {
				const v = action === 'volume-up' ? player.volumeUp() : player.volumeDown();
				return { action, message: '音量：' + Math.round(v * 100) + '%', volume: v };
			}
			if (action === 'toggle-favorite') {
				const r = player.toggleFavorite();
				return { action, message: r.favorite ? '已收藏' : '已取消收藏', favorite: r.favorite };
			}
			if (action === 'playmode') {
				const m = player.togglePlayMode();
				return { action, message: '已切换播放模式', playMode: m };
			}
			throw new Error('不支持的 action: ' + action);
		}
	};
}


/**
 * 构造 7 个面向模型的工具（复用 buildActions）。
 */
/**
 * 构造面向模型的工具（复用 buildActions）。
 */
function buildTools(cfg, actions) {
	const status = {
		name: 'alger_status',
		description:
			'检查内置音乐播放器状态：音乐服务是否在线（端口 ' + cfg.musicApiPort + '）、当前播放的歌曲、播放/暂停、进度、收藏与播放模式。无副作用。',
		parameters: compileParameters({}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [];
				lines.push(`音乐服务 ${cfg.musicApiPort}: ${rec.musicApiUp ? '在线' : '离线'}`);
				if (rec.playing) {
					lines.push(
						`正在${rec.playing.isPlaying ? '播放' : '暂停'}: ${rec.playing.name}${rec.playing.artists ? ' - ' + rec.playing.artists : ''}`
					);
					if (rec.playback && rec.playback.duration) {
						lines.push(
							`进度: ${fmtDuration(rec.playback.position * 1000)} / ${fmtDuration(rec.playback.duration * 1000)}`
						);
					}
				} else {
					lines.push('当前无播放内容');
				}
				if (rec.queue && Array.isArray(rec.queue.items)) lines.push(`播放列表: ${rec.queue.items.length} 首（当前第 ${(rec.queue.index ?? -1) + 1} 首）`);
				if (typeof rec.playMode === 'number') lines.push(`播放模式: ${['列表循环', '单曲循环', '随机'][rec.playMode] || rec.playMode}`);
				if (rec.favorite) lines.push('当前歌曲已收藏');
				if (!rec.musicApiUp) lines.push('提示: 音乐服务未在线，可调用 alger_setup action=start 启动。');
				return lines;
			}
		},
		execute: () => actions.status(),
		timeoutMs: cfg.timeoutMs
	};

	const setup = {
		name: 'alger_setup',
		description:
			'管理插件内置的音乐服务（开源网易云音乐 API，端口 ' + cfg.musicApiPort + '，仅本机回环）：action=check 只检查；action=start 启动（默认）；action=stop 停止。插件加载时服务会自动启动，一般无需手动调用。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['check', 'start', 'stop'],
				required: true,
				description: '操作：check=仅检查；start=启动音乐服务；stop=停止音乐服务。'
			}
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				lines.push(`音乐服务: ${rec.musicApiUp ? '在线' : '离线'}`);
				if (!rec.ok) lines.push('未能就绪，请按提示处理。');
				return lines;
			}
		},
		execute: (rawArgs) => actions.setup(asRecord(rawArgs)),
		timeoutMs: Math.max(cfg.timeoutMs, 45000)
	};

	const search = {
		name: 'alger_search',
		description:
			'用插件内置的开源音乐 API 服务（127.0.0.1:' + cfg.musicApiPort + '）搜索。type=1 歌曲 / 10 专辑 / 1000 歌单 / 1004 歌手 / 1009 MV。返回紧凑列表（含歌曲 id），供 alger_play 点歌。',
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
			'获取单曲详情：歌曲信息、歌词、可播放直链（部分歌曲因版权限制没有可用直链）。',
		parameters: compileParameters({
			id: { type: 'integer', required: true, description: '歌曲 id（来自 alger_search 结果）。' }
		}),
		output: {
			schema: { type: 'object', properties: { id: { type: 'integer' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [`[${rec.id}] ${rec.name}`];
				if (rec.artists) lines.push('歌手: ' + rec.artists);
				if (rec.album) lines.push('专辑: ' + rec.album);
				if (rec.durationMs) lines.push('时长: ' + fmtDuration(rec.durationMs));
				lines.push(`直链: ${rec.url ? '可用（可播放）' : '无（版权限制）'}`);
				if (rec.lyric) lines.push('歌词: 有（' + rec.lyric.split('\n').length + ' 行）');
				return lines;
			}
		},
		execute: (rawArgs) => actions.song(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const playlist = {
		name: 'alger_playlist',
		description:
			'获取歌单详情与歌曲列表（通过插件内置的开源音乐 API，歌单 id 来自 alger_search type=1000 或分享链接的数字部分）。',
		parameters: compileParameters({
			id: { type: 'integer', required: true, description: '歌单 id（来自 alger_search type=1000 或分享链接的数字部分）。' },
			limit: { type: 'integer', description: '最多返回多少首，默认 100，最大 500。' }
		}),
		output: {
			schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [`歌单「${rec.name}」（id=${rec.id}，共 ${rec.trackCount ?? 0} 首，返回 ${(rec.tracks || []).length} 首）：`];
				(rec.tracks || []).slice(0, 20).forEach((t, i) => {
					lines.push(`${i + 1}. [${t.id}] ${t.name} - ${t.artists}`);
				});
				if ((rec.tracks || []).length > 20) lines.push(`…（还有 ${(rec.tracks || []).length - 20} 首）`);
				return lines;
			}
		},
		execute: (rawArgs) => actions.playlist(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const play = {
		name: 'alger_play',
		description:
			'点歌：立即播放指定歌曲（浏览器内置 <audio> 引擎出声，替换当前播放队列为单曲）。给 songId 播指定单曲；只给 keyword 则搜索并播最佳匹配。',
		parameters: compileParameters({
			keyword: { type: 'string', description: '歌名/歌手关键词（与 songId 二选一）。' },
			songId: { type: 'integer', description: '歌曲 id（来自 alger_search，优先于 keyword）。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				if (rec.ok) lines.push('♪ 已播放：' + (rec.playedName || ''));
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return lines;
			}
		},
		execute: (rawArgs) => actions.play(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const queue = {
		name: 'alger_queue',
		description:
			'播放列表操作：action=add 把指定歌曲（songId 或 keyword 最佳匹配）追加到播放列表末尾；action=add-all 把某关键词的全部搜索结果（limit 控制数量）一键加入播放列表；action=add-next 插入到当前歌曲之后；action=playlist 按 playlistId 整单播放歌单（替换队列并立即播放第一首）；action=playlist-add 把歌单全部歌曲追加到播放列表末尾（不播放）；action=jump 按 index 跳转播放队列中指定位置的歌曲（队列不变）；action=clear 清空播放列表。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['add', 'add-all', 'add-next', 'playlist', 'playlist-add', 'jump', 'clear'],
				required: true,
				description: '操作：add=追加单曲；add-all=整批搜索结果加入；add-next=插入下一首；playlist=整单播放歌单；playlist-add=歌单整单追加到播放列表；jump=按 index 跳转播放；clear=清空播放列表。'
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
				if (rec.ok) lines.push(`队列: ${rec.queueLength ?? '?'} 首（本次${rec.added ?? 0} 首，${rec.mode || 'append'}）`);
				if (rec.playedName) lines.push('♪ 开始播放：' + rec.playedName);
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return lines;
			}
		},
		execute: (rawArgs) => actions.queue(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const control = {
		name: 'alger_control',
		description:
			'播放控制：toggle-play 播放/暂停切换、play 播放、pause 暂停、next 下一首、prev 上一首、volume-up 音量加、volume-down 音量减、toggle-favorite 收藏/取消收藏当前歌曲、playmode 切换播放模式（0=列表循环/1=单曲循环/2=随机）。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['toggle-play', 'play', 'pause', 'next', 'prev', 'volume-up', 'volume-down', 'toggle-favorite', 'playmode'],
				required: true,
				description: '要执行的控制动作。'
			}
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [];
				if (rec.message) lines.push(rec.message);
				if (typeof rec.playing === 'boolean') lines.push(rec.playing ? '▶ 播放中' : '⏸ 已暂停');
				if (rec.song) lines.push('当前: ' + rec.song);
				if (typeof rec.playMode === 'number') lines.push(`播放模式: ${['列表循环', '单曲循环', '随机'][rec.playMode] || rec.playMode}`);
				return lines;
			}
		},
		execute: (rawArgs) => actions.control(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const say = {
		name: 'alger_say',
		description:
			'让右下角的音乐宠物开口说一句话（宠物气泡提示约 6 秒），用于播报点歌/状态/鼓励等。台词要简短。',
		parameters: compileParameters({
			text: { type: 'string', required: true, description: '让宠物说的台词，50 字以内。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				return ['宠物说：「' + (rec.text || '') + '」'];
			}
		},
		execute: (rawArgs) => actions.say(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const recommend = {
		name: 'alger_recommend',
		description:
			'推荐播放：不知道听什么时，从音乐 API 的推荐歌单中随机挑一个整单播放（替换当前队列并立即开播，能连续播很久）。',
		parameters: compileParameters({}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				if (rec.ok) lines.push('♫ 推荐歌单：' + (rec.playlistName || '') + '（' + (rec.queueLength ?? '') + ' 首）');
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return lines;
			}
		},
		execute: () => actions.recommend(),
		timeoutMs: Math.max(cfg.timeoutMs, 45000)
	};

	return [status, setup, search, song, playlist, play, queue, control, say, recommend];
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
			handler: async (req, res) => {
				try {
					// 支持 GET /state?token=xxx（页面播放者身份）
					const q = String(req.url || '').split('?')[1] || '';
					const m = q.match(/(?:^|&)token=([^&]+)/);
					const token = m ? decodeURIComponent(m[1]) : null;
					json(res, await actions.status(token ? { token } : {}));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/claim',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.claim(body));
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
			path: '/dsh-alger/say',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.say(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/recommend',
			handler: async (_req, res) => {
				try {
					json(res, await actions.recommend());
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
			path: '/dsh-alger/url',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.songUrl(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/playback',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.playback(body));
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
		console.warn('[dsh-moony-singer] ' + (error instanceof Error ? error.message : String(error)));
		cfg = resolveConfig(null);
	}
	// 注意：不能直接把 ctx.subprocess.spawn 解构出来传参——宿主的 spawn 是类方法，
	// 内部读 this.internals，未绑定调用会抛 “Cannot read properties of undefined (reading 'internals')”。
	// 用箭头包装保持 this 指向 subprocess 服务实例。
	const spawn = (spec) => ctx.subprocess.spawn(spec);

	// 内置播放状态机 + 音乐 API 客户端（不再依赖任何桌面播放器）
	const player = createPlayer();
	const client = createClient(cfg);

	// 内置音乐 API 服务（netease-cloud-music-api-alger）自动启动
	const apiHandle = {
		handle: null,
		isUp: false,
		spawn,
		serverEntryPath: null
	};
	try {
		apiHandle.serverEntryPath = createRequire(import.meta.url).resolve('netease-cloud-music-api-alger/server.js');
	} catch (error) {
		console.warn('[dsh-moony-singer] 未找到内置音乐 API 依赖: ' + ((error && error.message) || String(error)));
	}
	if (apiHandle.serverEntryPath) {
		const result = startApiServer({
			spawn,
			serverEntryPath: apiHandle.serverEntryPath,
			port: cfg.musicApiPort,
			host: cfg.musicApiHost
		});
		if (!result.ok) {
			console.warn('[dsh-moony-singer] 音乐服务启动失败: ' + (result.error || ''));
		} else {
			apiHandle.handle = result.handle;
		}
	}

	// agent 状态跟踪（宠物反映 DSH 在做啥）——订阅宿主事件
	const shared = {};
	const agentState = new Map();
	function sidOf(x) {
		if (!x) return undefined;
		if (typeof x === 'string') return x;
		if (typeof x.id === 'string') return x.id;
		if (typeof x.sessionId === 'string') return x.sessionId;
		if (x.agent) return sidOf(x.agent);
		if (x.session) return sidOf(x.session);
		if (x.info && typeof x.info === 'object') return sidOf(x.info);
		if (x.exec && typeof x.exec === 'object') return sidOf(x.exec);
		return undefined;
	}
	function markAgent(sid, patch) {
		if (!sid) return;
		const e = agentState.get(sid) || { status: 'idle', lastActivity: 0 };
		agentState.set(sid, { ...e, ...patch, lastActivity: Date.now() });
	}
	if (typeof ctx.on === 'function') {
		ctx.on('agent/status', (p) => markAgent(sidOf(p && p.agent), { status: p && p.status === 'running' ? 'running' : 'idle' }));
		ctx.on('agent/turn-stopping', (p) => markAgent(sidOf(p && p.agent), { status: 'review' }));
		ctx.on('agent/error', (p) => markAgent(sidOf(p && p.agent), { status: 'failed' }));
		ctx.on('approval/request', (req, next) => {
			const sid = sidOf(req);
			markAgent(sid, { status: 'waiting' });
			const pr = Promise.resolve(next());
			pr.then(
				() => markAgent(sid, { status: 'idle' }),
				() => markAgent(sid, { status: 'idle' })
			);
			return pr;
		});
	}
	// 取最近活跃会话的状态（超过 60s 未活动视为空闲）
	shared.getAgentStatus = () => {
		const now = Date.now();
		let best = 'idle';
		let bestT = -Infinity;
		for (const e of agentState.values()) {
			if (now - e.lastActivity > 60000) continue;
			if (e.lastActivity > bestT) {
				bestT = e.lastActivity;
				best = e.status;
			}
		}
		return best;
	};

	const actions = buildActions(cfg, client, shared, player, apiHandle);
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
			if (apiHandle && apiHandle.handle) {
				stopApiServer(apiHandle.handle).catch(() => {});
			}
		});
	}
}

