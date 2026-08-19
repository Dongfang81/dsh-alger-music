/**
 * dsh-moony-singer/lib/player.js —— 内置播放状态机（服务端内存态）。
 *
 * 新架构：插件自带网易云音乐 API 服务 + 浏览器内置 <audio> 播放引擎，
 * 不再依赖 AlgerMusicPlayer App / CDP / 远程控制通道。
 *
 * 本模块维护"播放状态"的唯一事实来源：
 *  - 播放队列（歌曲对象数组，与 API 返回结构一致）
 *  - 当前下标、播放/暂停、音量、播放模式（0 列表循环 / 1 单曲循环 / 2 随机）
 *  - 收藏列表（歌曲 id 集合）
 *  - 播放进度（由客户端 <audio> 上报）
 *
 * 客户端浏览器只负责"出声"（<audio> 元素播放直链），一切控制命令
 * 都回到本状态机，保证工具（模型）与浮窗（浏览器）看到同一份状态。
 *
 * @module dsh-moony-singer/lib/player
 */

/** 创建内置播放器状态机。 */
export function createPlayer() {
	const state = {
		queue: [], // 歌曲对象数组 {id,name,ar?,al?,dt?,...}
		index: -1, // 当前播放下标（-1 = 无）
		playing: false,
		volume: 0.8,
		playMode: 0, // 0=列表循环 1=单曲循环 2=随机
		favoriteIds: [], // 收藏歌曲 id 列表
		position: 0, // 当前进度（秒，客户端上报）
		duration: 0, // 当前时长（秒，客户端上报）
		currentUrl: null, // 当前直链（客户端取用后播放）
		ready: false, // 播放引擎是否就绪（客户端上报）
		ownerToken: null, // 当前“播放者”页面 token（多页面防串音：只有它出声）
		ownerAt: 0 // 播放者最后声明时间
	};

	/** 播放者身份过期时间（毫秒）：页面关闭后 N 秒内未续期，其他页面可接管。 */
	const OWNER_TTL = 60000;

	/** 声明播放者身份。force=false 时仅当无有效 owner 才接管（页面加载温和声明）；
	 *  force=true 时无条件抢占（用户交互）。返回是否成为 owner。 */
	function claimOwner(token, force) {
		if (!token) return false;
		const t = String(token);
		const expired = !state.ownerToken || !state.ownerAt || Date.now() - state.ownerAt > OWNER_TTL;
		if (force || expired || state.ownerToken === t) {
			state.ownerToken = t;
			state.ownerAt = Date.now();
			return true;
		}
		return false;
	}

	/** 当前页面是否拥有播放权（含过期判断）。 */
	function isOwner(token) {
		if (!token || !state.ownerToken || state.ownerToken !== String(token)) return false;
		if (Date.now() - (state.ownerAt || 0) > OWNER_TTL) return false; // 过期：视为无 owner
		return true;
	}

	/** 当前歌曲对象（无则 null）。 */
	function current() {
		return state.index >= 0 && state.index < state.queue.length ? state.queue[state.index] : null;
	}

	/** 当前歌曲是否已收藏。 */
	function isFavorite(id) {
		return state.favoriteIds.includes(Number(id));
	}

	/** 切到队列第 idx 首（-1 清空）。返回切换后的当前曲。 */
	function setIndex(idx) {
		if (idx < 0 || idx >= state.queue.length) {
			state.index = -1;
			state.currentUrl = null;
			return null;
		}
		state.index = idx;
		state.currentUrl = null; // 客户端取直链后播放
		return current();
	}

	/** 整单替换队列并播放第一首（与旧版 action=playlist 同语义）。 */
	function replaceAndPlay(songs) {
		state.queue = Array.isArray(songs) ? songs : [];
		if (state.queue.length === 0) {
			state.index = -1;
			state.playing = false;
			return null;
		}
		state.index = 0;
		state.playing = true;
		return current();
	}

	/** 清空播放列表（停止播放）。 */
	function clearQueue() {
		state.queue = [];
		state.index = -1;
		state.playing = false;
		state.position = 0;
		state.duration = 0;
		state.currentUrl = null;
		return true;
	}

	/** 追加到队列末尾（保持当前播放）。 */
	function append(songs) {
		state.queue = state.queue.concat(songs);
		return state.queue.length;
	}

	/** 插入到当前歌曲之后。 */
	function insertNext(songs) {
		const at = state.index >= 0 ? state.index + 1 : state.queue.length;
		state.queue = state.queue.slice(0, at).concat(songs, state.queue.slice(at));
		return state.queue.length;
	}

	/** 单曲播放：替换队列为单曲并播放。 */
	function playSong(song) {
		state.queue = [song];
		state.index = 0;
		state.playing = true;
		return song;
	}

	/** 播放/暂停切换。 */
	function togglePlay() {
		if (state.index < 0 && state.queue.length > 0) state.index = 0;
		state.playing = !state.playing;
		return state.playing;
	}

	/** 下一首（按播放模式：随机时随机选；列表循环到尾回 0）。 */
	function next() {
		if (state.queue.length === 0) return null;
		if (state.playMode === 2) {
			const candidates = state.queue.map((_, i) => i).filter((i) => i !== state.index);
			const pick = candidates[Math.floor(Math.random() * candidates.length)] ?? 0;
			return setIndex(pick);
		}
		const idx = state.index + 1 >= state.queue.length ? 0 : state.index + 1;
		return setIndex(idx);
	}

	/** 上一首（回到队列开头）。 */
	function prev() {
		if (state.queue.length === 0) return null;
		const idx = state.index - 1 < 0 ? 0 : state.index - 1;
		return setIndex(idx);
	}

	/** 跳转队列第 idx 首。 */
	function jump(idx) {
		return setIndex(idx);
	}

	/** 切换播放模式（0/1/2 循环）。 */
	function togglePlayMode() {
		state.playMode = (state.playMode + 1) % 3;
		return state.playMode;
	}

	/** 收藏/取消收藏当前歌曲。返回 {favorite, favoriteIds}。 */
	function toggleFavorite() {
		const song = current();
		if (!song) return { favorite: false, favoriteIds: state.favoriteIds };
		const id = Number(song.id);
		if (isFavorite(id)) {
			state.favoriteIds = state.favoriteIds.filter((f) => f !== id);
			return { favorite: false, favoriteIds: state.favoriteIds };
		}
		state.favoriteIds = state.favoriteIds.concat(id);
		return { favorite: true, favoriteIds: state.favoriteIds };
	}

	/** 音量 +/-。 */
	function volumeUp() {
		state.volume = Math.min(1, Math.round((state.volume + 0.1) * 10) / 10);
		return state.volume;
	}
	function volumeDown() {
		state.volume = Math.max(0, Math.round((state.volume - 0.1) * 10) / 10);
		return state.volume;
	}

	/** 客户端上报播放进度（position/duration/ready；不覆盖 playing——服务端是唯一事实来源）。 */
	function reportPlayback(info) {
		const value = info && typeof info === 'object' ? info : {};
		if (typeof value.position === 'number' && Number.isFinite(value.position)) state.position = value.position;
		if (typeof value.duration === 'number' && Number.isFinite(value.duration)) state.duration = value.duration;
		if (typeof value.ready === 'boolean') state.ready = value.ready;
		return true;
	}

	/** 供状态快照使用的紧凑视图。 */
	function snapshot(extra) {
		const song = current();
		const queueView = state.queue.map((s) => ({
			id: s.id,
			name: s.name,
			artists: (s.ar || s.artists || []).map((a) => a.name).join(' / ')
		}));
		return {
			queue: { items: queueView, index: state.index },
			playing: song
				? {
						id: song.id,
						name: song.name,
						artists: (song.ar || song.artists || []).map((a) => a.name).join(', '),
						artistList: (song.ar || song.artists || []).map((a) => ({ id: a.id, name: a.name })),
						album: song.al?.name || song.album?.name || '',
						albumPic: song.al?.picUrl || song.picUrl || ''
					}
				: null,
			isPlaying: state.playing,
			position: state.position,
			duration: state.duration,
			volume: state.volume,
			playMode: state.playMode,
			favorite: song ? isFavorite(song.id) : false,
			favoriteIds: state.favoriteIds.slice(),
			currentUrl: state.currentUrl,
			ready: state.ready,
			...(extra || {})
		};
	}

	return {
		state,
		current,
		isFavorite,
		setIndex,
		replaceAndPlay,
		clearQueue,
		append,
		insertNext,
		playSong,
		togglePlay,
		next,
		prev,
		jump,
		togglePlayMode,
		toggleFavorite,
		volumeUp,
		volumeDown,
		claimOwner,
		isOwner,
		reportPlayback,
		snapshot
	};
}
