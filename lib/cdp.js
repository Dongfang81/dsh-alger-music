/**
 * dsh-alger-music/lib/cdp.js —— Chrome DevTools Protocol 自动化。
 *
 * AlgerMusicPlayer 以 --remote-debugging-port=<port> 启动后，暴露本地 CDP 端点
 * （仅监听 127.0.0.1）。本模块通过 CDP 在 App 的渲染页面里执行 JS：
 *  1. 用 history.pushState + PopStateEvent 把 App 导航到 /search?keyword=…（App 会自动搜索）；
 *  2. 从 #app 根组件拿到 pinia，取 player store，调用 setPlayList + setPlay 把指定歌曲
 *     直接塞进播放器开播——与 App 自己“播放全部”按钮走的是同一条路径。
 *
 * @module dsh-alger-music/lib/cdp
 */

/** 拿到主窗口的 CDP 页面目标。 */
export async function cdpPageTarget(port) {
	const res = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
	const list = await res.json();
	const pages = (Array.isArray(list) ? list : []).filter(
		(t) => t.type === 'page' && t.webSocketDebuggerUrl
	);
	if (pages.length === 0) throw new Error('CDP 端口上没有页面目标');
	// 主窗口优先：url 含 index.html 且不是歌词窗
	const main =
		pages.find((t) => /index\.html|file:/.test(t.url) && !/lyric/i.test(t.url)) || pages[0];
	return main;
}

/** 在页面里执行一段 JS，等待 Promise 完成并返回 by-value 结果。 */
export async function cdpEvaluate(port, expression, { timeoutMs = 20000 } = {}) {
	const target = await cdpPageTarget(port);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	const reply = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			try { ws.close(); } catch { /* ignore */ }
			reject(new Error('CDP 求值超时（' + Math.round(timeoutMs / 1000) + 's）'));
		}, timeoutMs);
		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id: 1,
					method: 'Runtime.evaluate',
					params: { expression, awaitPromise: true, returnByValue: true }
				})
			);
		};
		ws.onmessage = (ev) => {
			const msg = JSON.parse(String(ev.data));
			if (msg.id === 1) {
				clearTimeout(timer);
				resolve(msg);
			}
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error('CDP WebSocket 连接失败'));
		};
	});
	try { ws.close(); } catch { /* ignore */ }
	const r = reply.result;
	if (r?.exceptionDetails) {
		const desc =
			r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown error';
		throw new Error('页面执行出错: ' + String(desc).slice(0, 300));
	}
	return r?.result?.value;
}

/**
 * 构造“点歌”脚本：导航到搜索页 + 通过 pinia player store 直接播放指定歌曲。
 * @param {string} keyword - 搜索关键词（同时用于 App 内搜索页展示）
 * @param {object} song - 歌曲对象（与 App 自己使用的 /search、/song/detail 返回结构一致：
 *   id、name、ar[{id,name}]、al{id,name,picUrl}、dt 等）
 */
export function buildPlayScript(keyword, song) {
	const songJson = JSON.stringify(song ?? null);
	const kwJson = JSON.stringify(String(keyword ?? ''));
	return `(async () => {
		const out = { ok: false, steps: [] };
		const log = (m) => out.steps.push(String(m));
		try {
			const KW = ${kwJson};
			const SONG = ${songJson};
			// 1) 跳转到搜索页（失败不影响播放，仅作展示）
			try {
				history.pushState({}, '', '/search?keyword=' + encodeURIComponent(KW));
				window.dispatchEvent(new PopStateEvent('popstate'));
				log('已跳转搜索页 /search?keyword=' + KW);
			} catch (e) {
				log('跳转搜索页失败（忽略）: ' + (e && e.message));
			}
			// 2) 从根组件找 pinia player store
			const app = document.querySelector('#app');
			const g = app && app.__vue_app__ && app.__vue_app__.config && app.__vue_app__.config.globalProperties;
			const pinia = g && g.$pinia;
			const player = pinia && pinia._s && pinia._s.get('player');
			if (!player || typeof player.setPlay !== 'function' || typeof player.setPlayList !== 'function') {
				out.error = '未找到播放器 store（页面未加载完成或 App 版本不兼容）';
				return out;
			}
			log('已获取播放器 store（pinia: player）');
			// 3) 播放指定歌曲：与 App 内“播放全部”同一路径（setPlayList + setPlay）
			if (!SONG || typeof SONG.id === 'undefined') {
				out.error = '歌曲对象无效';
				return out;
			}
			player.setPlayList([SONG]);
			player.setPlay(SONG);
			out.playedName = SONG.name || String(SONG.id);
			out.playedId = SONG.id;
			out.ok = true;
			log('已调用 setPlayList + setPlay: ' + out.playedName);
		} catch (e) {
			out.error = String((e && e.message) || e);
		}
		return out;
	})()`;
}

/**
 * 构造“播放列表操作”脚本：向 App 播放器队列追加/插入/整单替换播放。
 * @param {Array<object>} songs - 歌曲对象数组（与 App 自己的 /search、/song/detail、
 *   /playlist/detail 返回结构一致：id、name、ar[{id,name}]、al{id,name,picUrl}、dt 等）。
 * @param {'append'|'next'|'replace'} mode - append=追加到队列末尾（保持当前播放）；
 *   next=插入到当前歌曲之后；replace=整单替换队列并立即播放第一首（用于播放歌单）。
 */
export function buildQueueScript(songs, mode) {
	const songsJson = JSON.stringify(Array.isArray(songs) ? songs : []);
	const modeJson = JSON.stringify(mode || 'append');
	return `(async () => {
		const out = { ok: false, steps: [] };
		const log = (m) => out.steps.push(String(m));
		try {
			const SONGS = ${songsJson};
			const MODE = ${modeJson};
			if (!Array.isArray(SONGS) || SONGS.length === 0) {
				out.error = '歌曲列表为空';
				return out;
			}
			const app = document.querySelector('#app');
			const g = app && app.__vue_app__ && app.__vue_app__.config && app.__vue_app__.config.globalProperties;
			const pinia = g && g.$pinia;
			const player = pinia && pinia._s && pinia._s.get('player');
			if (!player || typeof player.setPlayList !== 'function' || typeof player.setPlay !== 'function') {
				out.error = '未找到播放器 store（页面未加载完成或 App 版本不兼容）';
				return out;
			}
			log('已获取播放器 store（pinia: player）');
			if (MODE === 'replace') {
				player.setPlayList(SONGS);
				player.setPlay(SONGS[0]);
				out.playedName = SONGS[0].name || String(SONGS[0].id);
				log('已整单播放: ' + SONGS.length + ' 首，从「' + out.playedName + '」开始');
			} else {
				const cur = Array.isArray(player.playList) ? player.playList : [];
				let next;
				if (MODE === 'next') {
					const idx = Number.isInteger(player.playListIndex) ? player.playListIndex : Math.max(0, cur.length - 1);
					next = [...cur.slice(0, idx + 1), ...SONGS, ...cur.slice(idx + 1)];
					log('已插入下一首播放: ' + SONGS.length + ' 首');
				} else {
					next = cur.concat(SONGS);
					log('已追加到播放列表末尾: ' + SONGS.length + ' 首');
				}
				player.setPlayList(next, true); // keepIndex=true 保持当前播放位置
			}
			out.added = SONGS.length;
			out.queueLength = Array.isArray(player.playList) ? player.playList.length : -1;
			out.ok = true;
		} catch (e) {
			out.error = String((e && e.message) || e);
		}
		return out;
	})()`;
}

/**
 * 构造“跳转队列位置播放”脚本：播放队列中第 index 首（保留队列不变）。
 * @param {number} index - 队列下标（0 起）。
 */
export function buildQueueJumpScript(index) {
	const idx = Number(index);
	return `(async () => {
		const out = { ok: false, steps: [] };
		try {
			const app = document.querySelector('#app');
			const g = app && app.__vue_app__ && app.__vue_app__.config && app.__vue_app__.config.globalProperties;
			const pinia = g && g.$pinia;
			const player = pinia && pinia._s && pinia._s.get('player');
			if (!player || !Array.isArray(player.playList) || typeof player.setPlay !== 'function') {
				out.error = '未找到播放器 store（页面未加载完成或 App 版本不兼容）';
				return out;
			}
			const idx2 = ${idx};
			if (!Number.isInteger(idx2) || idx2 < 0 || idx2 >= player.playList.length) {
				out.error = '队列下标越界: ' + idx2 + '（队列共 ' + player.playList.length + ' 首）';
				return out;
			}
			const song = player.playList[idx2];
			player.setPlay(song);
			out.playedName = song.name || String(song.id);
			out.playedId = song.id;
			out.queueLength = player.playList.length;
			out.ok = true;
		} catch (e) {
			out.error = String((e && e.message) || e);
		}
		return out;
	})()`;
}

/**
 * 构造“读取播放器状态”脚本：返回当前队列（id/name/artists）、当前播放下标、
 * 以及播放进度（经 howler 全局读 position/duration，用于歌词同步）。
 * @param {number} limit - 最多返回多少首队列（默认 100）。
 */
export function buildGetQueueScript(limit = 100) {
	return `(async () => {
		const out = { queue: null, index: -1, position: null, duration: null, playing: false, favorite: null };
		try {
			const app = document.querySelector('#app');
			const g = app && app.__vue_app__ && app.__vue_app__.config && app.__vue_app__.config.globalProperties;
			const pinia = g && g.$pinia;
			const player = pinia && pinia._s && pinia._s.get('player');
			if (player && Array.isArray(player.playList)) {
				out.queue = player.playList.slice(0, ${Number(limit) || 100}).map((s) => ({
					id: s.id,
					name: s.name,
					artists: (s.ar || s.artists || []).map((a) => a.name).join(' / ')
				}));
				out.index = Number.isInteger(player.playListIndex) ? player.playListIndex : -1;
			}
			// 当前歌曲是否已收藏
			if (player) {
				try {
					const curId = player.playMusic && player.playMusic.id;
					out.favorite = Array.isArray(player.favoriteList)
						? player.favoriteList.includes(Number(curId))
						: false;
				} catch {
					out.favorite = false;
				}
			}
			// 播放进度：App 用 howler(Web Audio) 播放，经 window.Howler._howls 取 seek/duration
			const HowlerG = typeof window !== 'undefined' ? window.Howler : undefined;
			const howls = HowlerG && Array.isArray(HowlerG._howls) ? HowlerG._howls : [];
			const active = howls.find((h) => h && h.playing && h.playing()) || howls.find((h) => h && h.duration && h.duration() > 0);
			if (active) {
				try {
					out.position = typeof active.seek === 'function' ? Number(active.seek()) : null;
					out.duration = typeof active.duration === 'function' ? Number(active.duration()) : null;
					out.playing = typeof active.playing === 'function' ? Boolean(active.playing()) : false;
				} catch {
					/* 读取失败则保持 null */
				}
			}
		} catch (e) {
			out.error = String((e && e.message) || e);
		}
		return out;
	})()`;
}

/**
 * 检查 CDP 上是否有主窗口目标。
 * @returns {Promise<boolean>}
 */
export async function cdpHasMainWindow(port) {
	try {
		await cdpPageTarget(port);
		return true;
	} catch {
		return false;
	}
}
