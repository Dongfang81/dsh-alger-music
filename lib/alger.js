/**
 * dsh-music/lib/alger.js —— 内置音乐 API 客户端。
 *
 * 新架构：插件自带开源网易云音乐 API 服务（netease-cloud-music-api-alger），
 * 本模块只做 HTTP 调用：搜索 / 歌曲详情 / 歌词 / 播放地址 / 歌单 / 推荐。
 * 不再管理任何桌面播放器 App。
 *
 * @module dsh-music/lib/alger
 */

/**
 * 构造内置音乐 API 客户端。
 * @param {object} cfg - 插件配置（见 index.js DEFAULTS）
 */
export function createClient(cfg) {
	const apiBase = `http://${cfg.musicApiHost || '127.0.0.1'}:${cfg.musicApiPort}`;

	/** GET 并解析 JSON；失败抛带上下文的中文错误。 */
	async function getJson(url, timeoutMs = cfg.timeoutMs) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error('请求超时: ' + url)), timeoutMs);
		let res;
		try {
			res = await fetch(url, { signal: controller.signal });
		} catch (error) {
			throw new Error('无法连接音乐服务 ' + url + '：' + ((error && error.message) || String(error)));
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

	return {
		apiBase,
		getJson,

		/** 音乐服务是否可用（探活）。 */
		async musicApiUp() {
			try {
				await getJson(`${apiBase}/search?keywords=test&limit=1`, 3000);
				return true;
			} catch {
				return false;
			}
		},

		// ---------- 网易云 API ----------
		async search(keywords, type = 1, limit = 10) {
			const data = await getJson(
				`${apiBase}/search?keywords=${encodeURIComponent(keywords)}&type=${type}&limit=${limit}`
			);
			if (data.code !== 200) throw new Error('搜索失败: ' + JSON.stringify(data).slice(0, 200));
			return data.result || {};
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
			const item = data?.data?.[0];
			// 无直链或试听（freeTrialInfo 存在）都视为不可播
			if (!item?.url) return null;
			if (item.freeTrialInfo || item.type === 0) return null;
			return item.url;
		},
		async playlist(id, limit = 100) {
			const data = await getJson(`${apiBase}/playlist/detail?id=${id}&limit=${limit}`);
			if (data.code !== 200) throw new Error('获取歌单失败: ' + JSON.stringify(data).slice(0, 200));
			return data.playlist ?? null;
		}
	};
}
