/**
 * dsh-alger-music —— Client half（浏览器浮动播放器）。
 *
 * 由 DSH web 的模块加载器（window.__ModuleLoader__.load）挂载：右下角浮动小窗，
 * 实时展示 AlgerMusicPlayer 的播放状态，提供 播放/暂停、上一首、下一首、音量±、
 * 搜索点歌 与“一键就绪”（开启 App 远程控制并带调试口重启）。所有数据经插件
 * 服务端路由 /dsh-alger/* 中转（本机 30488/31888/CDP 不直接暴露给页面）。
 */
window.__ModuleLoader__.load({
	id: "dsh-alger-music",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var ReactDOM = require("react-dom");
		var h = React.createElement;

		/** 轮询间隔（ms）。 */
		var POLL_MS = 1500;
		/** 展开宽度。 */
		var WIDTH = 280;
		/** 本地存储键。 */
		var STORE_COLLAPSED = "dsh-alger:collapsed";
		var STORE_X = "dsh-alger:x";
		var STORE_Y = "dsh-alger:y";

		/* ---------- API ---------- */
		function getState() {
			return fetch("/dsh-alger/state", { cache: "no-store" }).then(function (r) { return r.json(); });
		}
		function post(path, body) {
			return fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {})
			}).then(function (r) { return r.json(); });
		}
		var command = function (action) { return post("/dsh-alger/command", { action: action }); };
		var searchMusic = function (keywords, type) { return post("/dsh-alger/search", { keywords: keywords, type: type || 1, limit: 8 }); };
		var playSong = function (payload) { return post("/dsh-alger/play", payload); };
		var queueApi = function (payload) { return post("/dsh-alger/queue", payload); };
		var setupApp = function (action) { return post("/dsh-alger/setup", { action: action }); };
		var installApp = function () { return post("/dsh-alger/install", {}); };
		var getLyric = function (id) { return post("/dsh-alger/lyric", { id: id }); };
		var getArtist = function (id) { return post("/dsh-alger/artist", { id: id }); };

		/* ---------- LRC 解析与歌词行定位 ----------
		 * 历史事故（教训）：同一个全局正则对象绝不能在 exec() 循环里又被 replace() 使用
		 * （replace 会重置 lastIndex → exec 反复命中同一处 → 无限循环 → 渲染进程崩溃），
		 * 也不能跨行共享 lastIndex（时间戳结束在行尾时残留 lastIndex 会吞掉后续所有行）。
		 * 因此：每行使用独立正则对象，显式重置 lastIndex，并加行数/匹配数上限兜底。
		 */
		function parseLrc(text) {
			var lines = [];
			var MAX_LINES = 5000;
			var MAX_TS_PER_LINE = 50;
			String(text || "").split("\n").forEach(function (line) {
				if (lines.length >= MAX_LINES) return;
				// 1) 每行独立的时间戳正则（绝不复用全局对象）
				var tsRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
				var ts = [];
				var m;
				tsRe.lastIndex = 0;
				while (ts.length < MAX_TS_PER_LINE && (m = tsRe.exec(line))) ts.push(m);
				if (ts.length === 0) return;
				// 2) 去标签用另一个新正则字面量（与 tsRe 互不影响）
				var text2 = line.replace(/\[[^\]]*\]/g, "").trim();
				ts.forEach(function (t) {
					var frac = t[3] ? Number(String(t[3]).padEnd(3, "0")) / 1000 : 0;
					lines.push({ t: Number(t[1]) * 60 + Number(t[2]) + frac, text: text2 });
				});
			});
			lines.sort(function (a, b) { return a.t - b.t; });
			return lines;
		}
		function currentLrcLine(lrc, position) {
			if (!lrc || lrc.length === 0 || typeof position !== "number") return null;
			var cur = null;
			for (var i = 0; i < lrc.length; i++) {
				if (lrc[i].t <= position) cur = lrc[i];
				else break;
			}
			return cur;
		}

		/* ---------- 样式 ---------- */
		var CSS = [
			"#dsh-alger-root{position:fixed;left:0;top:0;z-index:2147483000;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;color:#fff}",
			".dsa-card{width:" + WIDTH + "px;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.03)),rgba(13,15,24,0.66);backdrop-filter:blur(22px) saturate(160%);-webkit-backdrop-filter:blur(22px) saturate(160%);border:1px solid rgba(255,255,255,0.16);box-shadow:0 14px 40px rgba(0,0,0,0.42),inset 0 1px 0 rgba(255,255,255,0.16)}",
			".dsa-drag{cursor:grab}.dsa-drag:active{cursor:grabbing}",
			".dsa-header{display:flex;align-items:center;gap:9px;padding:8px 10px}",
			".dsa-cover{flex:none;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:17px;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.22),0 4px 12px rgba(0,0,0,0.35);overflow:hidden}",
			".dsa-cover img{width:100%;height:100%;object-fit:cover}",
			".dsa-meta{flex:1;min-width:0}",
			".dsa-title{font-size:13px;font-weight:600;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 4px rgba(0,0,0,0.4)}",
			".dsa-artist{font-size:10.5px;line-height:14px;color:rgba(255,255,255,0.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-actions{flex:none;display:flex;align-items:center;gap:2px}",
			".dsa-btn{flex:none;width:26px;height:26px;border:none;border-radius:8px;background:transparent;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;padding:0;text-shadow:0 1px 3px rgba(0,0,0,0.35)}",
			".dsa-btn:hover{background:rgba(255,255,255,0.16)}",
			".dsa-btn:disabled{opacity:0.35;cursor:not-allowed}",
			".dsa-btn-primary{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,rgba(255,255,255,0.95),rgba(255,255,255,0.72));color:#11131f;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,0.35)}",
			".dsa-btn-primary:hover{filter:brightness(1.05)}",
			".dsa-body{padding:2px 12px 12px}",
			".dsa-controls{display:flex;align-items:center;justify-content:center;gap:3px;margin-top:4px}",
			".dsa-search{display:flex;gap:6px;margin-top:8px}",
			".dsa-input{flex:1;min-width:0;background:rgba(255,255,255,0.13);border:1px solid rgba(255,255,255,0.22);border-radius:9px;color:#fff;font-size:12px;padding:5px 9px;outline:none;backdrop-filter:blur(6px)}",
			".dsa-input:focus{border-color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.17)}",
			".dsa-input::placeholder{color:rgba(255,255,255,0.5)}",
			".dsa-go{flex:none;border:none;border-radius:9px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-size:12px;padding:0 12px;cursor:pointer;font-weight:600}",
			".dsa-go:hover{filter:brightness(1.08)}",
			".dsa-go:disabled{opacity:0.5;cursor:not-allowed}",
			".dsa-results{margin-top:6px;max-height:150px;overflow-y:auto}",
			".dsa-item{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:8px;cursor:pointer}",
			".dsa-item:hover{background:rgba(255,255,255,0.10)}",
			".dsa-item .t{flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-item .s{font-size:10px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}",
			".dsa-item .p{font-size:10px;color:rgba(255,255,255,0.45);flex:none}",
			".dsa-notice{margin-top:7px;padding:5px 9px;border-radius:8px;font-size:11px;line-height:1.45;background:rgba(245,158,11,0.16);border:1px solid rgba(245,158,11,0.35);color:#fcd34d}",
			".dsa-notice.ok{background:rgba(52,211,153,0.14);border-color:rgba(52,211,153,0.35);color:#6ee7b7}",
			".dsa-notice.err{background:rgba(239,68,68,0.14);border-color:rgba(239,68,68,0.35);color:#fca5a5}",
			".dsa-ready{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 9px;border-radius:9px;background:rgba(255,255,255,0.06);font-size:11px;color:rgba(255,255,255,0.8)}",
			".dsa-ready .dot{width:8px;height:8px;border-radius:50%;flex:none}",
			".dsa-ready .dot.ok{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,0.8)}",
			".dsa-ready .dot.wait{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,0.8)}",
			".dsa-ready .dot.bad{background:#ef4444;box-shadow:0 0 6px rgba(239,68,68,0.8)}",
			".dsa-ready .txt{flex:1;min-width:0}",
			".dsa-ready .act{flex:none;border:none;border-radius:8px;background:linear-gradient(135deg,#f59e0b,#f97316);color:#1c1200;font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer}",
			".dsa-ready .act:hover{filter:brightness(1.1)}",
			".dsa-ready .act:disabled{opacity:0.5;cursor:wait}",
			".dsa-mini{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;cursor:pointer;background:linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.03)),rgba(13,15,24,0.7);backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);border:1px solid rgba(255,255,255,0.16);box-shadow:0 10px 30px rgba(0,0,0,0.4);white-space:nowrap;max-width:280px}",
			".dsa-mini .dot{width:8px;height:8px;border-radius:50%;flex:none}",
			".dsa-mini .dot.ok{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,0.8)}",
			".dsa-mini .dot.wait{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,0.8)}",
			".dsa-mini .dot.bad{background:#ef4444;box-shadow:0 0 6px rgba(239,68,68,0.8)}",
			".dsa-mini .t{font-size:12px;font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis}",
			".dsa-mini .hint{font-size:10px;color:rgba(255,255,255,0.6)}",
			".dsa-fav{color:#fda4af}.dsa-fav:hover{background:rgba(244,114,182,0.18)}",
			".dsa-types{display:flex;gap:4px;margin-top:7px}",
			".dsa-type{flex:1;border:1px solid rgba(255,255,255,0.18);background:transparent;color:rgba(255,255,255,0.75);border-radius:8px;font-size:11px;padding:3px 0;cursor:pointer}",
			".dsa-type.active{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.4);color:#fff;font-weight:600}",
			".dsa-type:hover{background:rgba(255,255,255,0.08)}",
			".dsa-queue{margin-top:8px;border:1px solid rgba(255,255,255,0.12);border-radius:10px;background:rgba(255,255,255,0.05)}",
			".dsa-queue-title{display:flex;align-items:center;gap:6px;padding:6px 9px;font-size:11px;font-weight:600;color:rgba(255,255,255,0.85);cursor:pointer}",
			".dsa-queue-title .cnt{color:rgba(255,255,255,0.5);font-weight:400}",
			".dsa-queue-title .fold{margin-left:auto;color:rgba(255,255,255,0.5)}",
			".dsa-queue-list{max-height:130px;overflow-y:auto;padding:0 6px 6px}",
			".dsa-qitem{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:7px;font-size:11px;color:rgba(255,255,255,0.8);cursor:pointer}",
			".dsa-qitem:hover{background:rgba(255,255,255,0.08)}",
			".dsa-qitem.cur{background:rgba(59,130,246,0.22);color:#fff}",
			".dsa-qitem.sel{box-shadow:inset 0 0 0 1px rgba(255,255,255,0.5);background:rgba(255,255,255,0.12);color:#fff}",
			".dsa-qitem .n{flex:none;width:16px;text-align:right;color:rgba(255,255,255,0.4);font-size:10px}",
			".dsa-qitem .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-qitem .s{font-size:10px;color:rgba(255,255,255,0.5);max-width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-addall{margin-top:6px;width:100%;border:1px dashed rgba(255,255,255,0.25);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.85);border-radius:8px;font-size:11px;padding:4px 0;cursor:pointer}",
			".dsa-addall:hover{background:rgba(255,255,255,0.12)}",
			".dsa-addall:disabled{opacity:0.5;cursor:not-allowed}",
			".dsa-rowbtn{flex:none;border:none;border-radius:7px;background:rgba(255,255,255,0.12);color:#fff;font-size:10px;padding:2px 7px;cursor:pointer}",
			".dsa-rowbtn:hover{background:rgba(255,255,255,0.22)}",
			".dsa-rowbtn:disabled{opacity:0.5;cursor:not-allowed}",
			".dsa-rowbtn.play{background:linear-gradient(135deg,#3b82f6,#6366f1)}",
			/* ---- 宠物（收起态）：宠物固定，气泡锚定在左/右侧（自动换边） ---- */
			".dsa-pet-wrap{position:fixed;z-index:2147483000;width:64px;height:64px;user-select:none}",
			".dsa-pet-bubble-pos{position:absolute;top:50%;transform:translateY(-50%);display:flex;align-items:center}",
			".dsa-pet-bubble-pos.right{left:74px}",
			".dsa-pet-bubble-pos.left{right:74px}",
			".dsa-pet-bubble{position:relative;background:rgba(13,15,24,0.9);border:1px solid rgba(255,255,255,0.22);border-radius:14px;padding:7px 12px;font-size:12px;line-height:1.4;color:#fff;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.35);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}",
			".dsa-pet-bubble.sing{animation:dsa-bubble-bob .5s ease-in-out infinite alternate}",
			".dsa-pet-bubble .dsa-marquee{display:flex;width:max-content;animation-name:dsa-marquee;animation-timing-function:linear;animation-iteration-count:infinite;will-change:transform}",
			".dsa-pet-bubble .dsa-marquee span{white-space:nowrap;padding-right:28px}",
			"@keyframes dsa-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}",
			".dsa-pet-bubble-tail{position:absolute;top:50%;width:0;height:0;border-top:6px solid transparent;border-bottom:6px solid transparent;transform:translateY(-50%)}",
			".dsa-pet-bubble-pos.right .dsa-pet-bubble-tail{left:-7px;border-right:7px solid rgba(13,15,24,0.9)}",
			".dsa-pet-bubble-pos.left .dsa-pet-bubble-tail{right:-7px;border-left:7px solid rgba(13,15,24,0.9)}",
			".dsa-pet{position:relative;width:64px;height:64px;border-radius:50%;cursor:grab;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border:2px solid rgba(255,255,255,0.65);box-shadow:0 8px 26px rgba(0,0,0,0.45);overflow:visible}",
			".dsa-pet:active{cursor:grabbing}",
			".dsa-pet.singing{animation:dsa-pet-bob .55s ease-in-out infinite alternate}",
			".dsa-pet-face{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}",
			".dsa-pet-emoji{font-size:28px}",
			".dsa-pet-ear{position:absolute;top:-9px;width:18px;height:18px;border-radius:50% 50% 0 0;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border:2px solid rgba(255,255,255,0.65);border-bottom:none}",
			".dsa-pet-ear.left{left:3px}",
			".dsa-pet-ear.right{right:3px}",
			".dsa-pet-notes{position:absolute;top:-24px;right:-10px;display:flex;gap:2px;font-size:14px;color:#fbbf24;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,0.5)}",
			".dsa-pet-notes span{animation:dsa-note-float 1.3s ease-in-out infinite}",
			".dsa-pet-notes span:nth-child(2){animation-delay:.35s}",
			".dsa-pet-notes span:nth-child(3){animation-delay:.7s}",
			"@keyframes dsa-pet-bob{from{transform:translateY(0)}to{transform:translateY(-6px)}}",
			"@keyframes dsa-bubble-bob{from{transform:translateY(0)}to{transform:translateY(-2px)}}",
			"@keyframes dsa-note-float{0%{transform:translateY(0);opacity:0}30%{opacity:1}100%{transform:translateY(-14px);opacity:0}}"
		].join("\n");

		function injectCss() {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-alger-music";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/* ---------- 图标（内联 SVG 字符） ---------- */
		var ICONS = {
			play: "▶",
			pause: "❚❚",
			prev: "⏮",
			next: "⏭",
			volup: "🔊",
			voldown: "🔉",
			collapse: "▾",
			expand: "▸",
			search: "🔍",
			refresh: "↻"
		};

		function readyDot(state) {
			if (!state) return "wait";
			if (!state.installed) return "bad";
			if (!state.running) return "wait";
			if (!state.remoteUp) return "wait";
			return "ok";
		}

		function readyText(state) {
			if (!state) return "连接中…";
			if (!state.installed) return "未安装 AlgerMusicPlayer";
			if (!state.running) return "App 未运行";
			if (!state.remoteUp) return "远程控制未就绪";
			if (!state.cdpUp) return "已就绪（点歌通道待开启）";
			return "已就绪";
		}

		function needSetup(state) {
			return state && state.installed && (!state.running || !state.remoteUp || !state.cdpUp);
		}

		/* ---------- 浮动播放器 ---------- */
		function MusicPlayer() {
			var [state, setState] = React.useState(null);
			var [collapsed, setCollapsed] = React.useState(function () {
				try { return localStorage.getItem(STORE_COLLAPSED) === "1"; } catch { return false; }
			});
			var [pos, setPos] = React.useState(null);
			var posRef = React.useRef(null);
			var dragRef = React.useRef(null);
			var cardRef = React.useRef(null);
			var [query, setQuery] = React.useState("");
			var [searchType, setSearchType] = React.useState(1); // 1=歌曲 1000=歌单
			var [searching, setSearching] = React.useState(false);
			var [results, setResults] = React.useState(null);
			var [queueOpen, setQueueOpen] = React.useState(false);
			var [selectedIdx, setSelectedIdx] = React.useState(null); // 播放列表"单击选中"的行
			var [notice, setNotice] = React.useState(null); // {kind:'ok'|'err'|'', text}
			var [busy, setBusy] = React.useState(false);
			var [lrc, setLrc] = React.useState(null); // [{t,text}] 当前歌歌词
			var [artistInfo, setArtistInfo] = React.useState(null); // {id, avatar}
			var noticeTimer = React.useRef(null);
			var lrcFor = React.useRef(null); // 已取歌词的 songId
			var artistFor = React.useRef(null); // 已取头像的 artistId
			var suppressClickRef = React.useRef(false);

			var flash = function (kind, text) {
				setNotice({ kind: kind || "", text: text });
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(function () { setNotice(null); }, 6000);
			};

			var refresh = React.useCallback(function () {
				getState().then(function (s) { setState(s); }).catch(function () { /* 忽略瞬时失败 */ });
			}, []);

			// 轮询
			React.useEffect(function () {
				refresh();
				var timer = setInterval(refresh, POLL_MS);
				return function () { clearInterval(timer); };
			}, [refresh]);

			// 恢复位置 / 默认右下角
			React.useEffect(function () {
				try {
					var x = localStorage.getItem(STORE_X);
					var y = localStorage.getItem(STORE_Y);
					if (x !== null && y !== null) {
						var p = { x: Number(x), y: Number(y) };
						if (Number.isFinite(p.x) && Number.isFinite(p.y)) { posRef.current = p; setPos(p); return; }
					}
				} catch { /* ignore */ }
				posRef.current = null;
				setPos(null);
			}, []);

			// 视口内钳制（仅展开态生效：收起态宠物锚点不受展开卡尺寸影响，否则会被每轮轮询往左拽）
			React.useEffect(function () {
				if (collapsed) return;
				var height = cardRef.current ? cardRef.current.offsetHeight : 260;
				var p = posRef.current;
				if (!p) return;
				var clamped = {
					x: Math.max(4, Math.min(window.innerWidth - WIDTH - 4, p.x)),
					y: Math.max(4, Math.min(window.innerHeight - height - 4, p.y))
				};
				if (clamped.x !== p.x || clamped.y !== p.y) { posRef.current = clamped; setPos(clamped); }
			}, [collapsed, state]);

			// 拖动
			var onDragStart = function (event) {
				if (event.button !== 0) return;
				dragRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					origX: posRef.current ? posRef.current.x : null,
					origY: posRef.current ? posRef.current.y : null,
					moved: false
				};
				var onMove = function (ev) {
					var drag = dragRef.current;
					if (!drag) return;
					var dx = ev.clientX - drag.startX;
					var dy = ev.clientY - drag.startY;
					if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
					drag.moved = true;
					suppressClickRef.current = true;
					var baseX = drag.origX !== null ? drag.origX : window.innerWidth - WIDTH - 18;
					var baseY = drag.origY !== null ? drag.origY : window.innerHeight - 120;
					posRef.current = { x: baseX + dx, y: baseY + dy };
					setPos(posRef.current);
				};
				var onUp = function () {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					var p = posRef.current;
					if (p) {
						try {
							localStorage.setItem(STORE_X, String(p.x));
							localStorage.setItem(STORE_Y, String(p.y));
						} catch { /* ignore */ }
					}
					dragRef.current = null;
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			};

			var toggleCollapsed = function () {
				var next = !collapsed;
				setCollapsed(next);
				try { localStorage.setItem(STORE_COLLAPSED, next ? "1" : "0"); } catch { /* ignore */ }
			};

			var runCommand = function (action) {
				if (!state || !state.remoteUp) { flash("err", "远程控制未就绪，请先点“一键就绪”"); return; }
				command(action).then(function (r) {
					if (r && r.ok === false) flash("err", r.error || "命令失败");
					setTimeout(refresh, 400);
				}).catch(function () { flash("err", "命令发送失败"); });
			};

			var onSearch = function () {
				var q = query.trim();
				if (!q) return;
				setSearching(true);
				setResults(null);
				searchMusic(q, searchType).then(function (r) {
					setSearching(false);
					if (!r || r.ok === false) { flash("err", (r && r.error) || "搜索失败"); setResults(null); return; }
					setResults(r.items || []);
				}).catch(function () { setSearching(false); flash("err", "搜索失败"); });
			};

			var switchType = function (type) {
				setSearchType(type);
				setResults(null);
				if (query.trim()) setTimeout(onSearch, 0);
			};

			var onPlaySong = function (item) {
				setBusy(true);
				playSong({ songId: item.id }).then(function (r) {
					setBusy(false);
					if (r && r.ok) {
						flash("ok", "已点播：" + (r.playedName || item.name) + (r.confirmed ? "" : "（待确认）"));
						setResults(null);
						setQuery("");
					} else {
						flash("err", (r && r.guidance) || (r && r.error) || "点歌失败");
					}
					setTimeout(refresh, 600);
				}).catch(function () { setBusy(false); flash("err", "点歌失败"); });
			};

			var onAddSong = function (item) {
				setBusy(true);
				queueApi({ action: "add", songId: item.id }).then(function (r) {
					setBusy(false);
					if (r && r.ok) flash("ok", "已加入播放列表：" + (item.name || ""));
					else flash("err", (r && r.guidance) || (r && r.error) || "加入失败");
					setTimeout(refresh, 500);
				}).catch(function () { setBusy(false); flash("err", "加入失败"); });
			};

			var onAddAll = function () {
				var q = query.trim();
				if (!q) return;
				setBusy(true);
				queueApi({ action: "add-all", keyword: q, limit: 20 }).then(function (r) {
					setBusy(false);
					if (r && r.ok) flash("ok", "已把搜索到的 " + (r.added || 0) + " 首全部加入播放列表");
					else flash("err", (r && r.guidance) || (r && r.error) || "加入失败");
					setTimeout(refresh, 500);
				}).catch(function () { setBusy(false); flash("err", "加入失败"); });
			};

			var onPlayPlaylist = function (item) {
				setBusy(true);
				queueApi({ action: "playlist", playlistId: item.id }).then(function (r) {
					setBusy(false);
					if (r && r.ok) flash("ok", "正在播放歌单：" + (item.name || "") + (r.playedName ? "（从 " + r.playedName + " 开始）" : ""));
					else flash("err", (r && r.guidance) || (r && r.error) || "播放歌单失败");
					setTimeout(refresh, 600);
				}).catch(function () { setBusy(false); flash("err", "播放歌单失败"); });
			};

			var onAddPlaylist = function (item) {
				setBusy(true);
				queueApi({ action: "playlist-add", playlistId: item.id }).then(function (r) {
					setBusy(false);
					if (r && r.ok) flash("ok", "歌单已整单加入播放列表：" + (item.name || "") + "（" + (r.added || 0) + " 首）");
					else flash("err", (r && r.guidance) || (r && r.error) || "加入失败");
					setTimeout(refresh, 500);
				}).catch(function () { setBusy(false); flash("err", "加入失败"); });
			};

			// 播放列表：单击选中、双击跳转播放（保留队列）
			var onQueueSelect = function (i) {
				setSelectedIdx(i === selectedIdx ? null : i);
			};
			var onQueueJump = function (i) {
				setBusy(true);
				queueApi({ action: "jump", index: i }).then(function (r) {
					setBusy(false);
					if (r && r.ok) flash("ok", "已跳转播放：" + (r.playedName || ""));
					else flash("err", (r && r.guidance) || (r && r.error) || "播放失败");
					setTimeout(refresh, 600);
				}).catch(function () { setBusy(false); flash("err", "播放失败"); });
			};

			var onSetup = function () {
				setBusy(true);
				flash("", "正在就绪（重启 App 并开启远程控制，约 10~30 秒）…");
				setupApp("relaunch").then(function (r) {
					setBusy(false);
					if (r && r.ok) flash("ok", "已就绪！可以开始点歌了。");
					else flash("err", (r && r.steps && r.steps[r.steps.length - 1]) || "就绪失败，请查看 App 状态");
					refresh();
				}).catch(function () { setBusy(false); flash("err", "就绪失败"); });
			};

			var onInstall = function () {
				setBusy(true);
				flash("", "正在自动下载并安装 AlgerMusicPlayer（约 130MB，需要几分钟）…");
				installApp().then(function (r) {
					setBusy(false);
					if (r && r.ok) {
						flash("ok", r.alreadyInstalled ? "已安装" + (r.version ? " " + r.version : "") + "，无需安装" : "安装完成" + (r.version ? "（" + r.version + "）" : "") + "！点“一键就绪”开始使用");
					} else {
						flash("err", (r && r.guidance) || (r && r.error) || "安装失败");
					}
					refresh();
				}).catch(function () { setBusy(false); flash("err", "安装失败"); });
			};

			var onSearchKey = function (event) {
				if (event.key === "Enter") onSearch();
			};

			// 播放信息：state.playing = {ok, isPlaying, song:{...}}
			var remote = state && state.playing ? state.playing : null;
			var playing = remote && remote.song ? remote.song : null;
			var isPlaying = Boolean(remote && remote.isPlaying);
			var dot = readyDot(state);
			var title = playing ? playing.name : "未在播放";
			var artist = playing ? (playing.artists || "") : (state && state.running ? "AlgerMusicPlayer" : "播放器未连接");
			var canControl = Boolean(state && state.remoteUp);

			// 切歌时拉歌词与作者头像
			var songId = playing ? playing.id : null;
			var artistId = playing && playing.artistList && playing.artistList[0] ? playing.artistList[0].id : null;
			React.useEffect(function () {
				if (!songId || lrcFor.current === songId) return;
				lrcFor.current = songId;
				getLyric(songId).then(function (r) {
					setLrc(r && r.lyric ? parseLrc(r.lyric) : []);
				}).catch(function () { setLrc([]); });
			}, [songId]);
			React.useEffect(function () {
				if (!artistId || artistFor.current === artistId) return;
				artistFor.current = artistId;
				getArtist(artistId).then(function (r) {
					if (r && r.ok && r.avatar) setArtistInfo({ id: artistId, avatar: r.avatar });
				}).catch(function () { /* 保留旧头像 */ });
			}, [artistId]);

			// 折叠态宠物：气泡换边状态（hooks 必须无条件声明，不能在 if 里）
			var bubbleRef = React.useRef(null);
			var [bubbleSide, setBubbleSide] = React.useState("right"); // 气泡在宠物右侧/左侧
			var [bubbleMaxW, setBubbleMaxW] = React.useState(230);
			var [overflowing, setOverflowing] = React.useState(false); // 歌词溢出→marquee 流动
			// 歌词行与宠物锚点（展开/收起都计算，供测宽 effect 使用）
			var position = state && state.playback ? state.playback.position : null;
			var line = currentLrcLine(lrc, position);
			var bubbleText = line && line.text
				? line.text
				: (playing ? title + (artist ? " · " + artist : "") : "未在播放");
			var petX = pos ? pos.x : window.innerWidth - 110; // 与渲染用的默认位置一致
			var marqueeDur = Math.max(6, Math.min(20, (bubbleText || "").length * 0.35)); // 流动速度随词长
			// 宠物固定不动；气泡锚定右侧，宠物靠右（右侧可用空间不足阈值）则稳定换到左侧。
			// 判定只看宠物几何位置，不随歌词长度变化——避免换边后又被下一句顶回右侧。
			React.useEffect(function () {
				if (!collapsed || !bubbleRef.current) return;
				var measure = function () {
					var el = bubbleRef.current;
					if (!el) return;
					var GAP = 12;
					var petW = 64;
					var MARGIN = 8;
					var MIN_RIGHT = 160; // 右侧可用空间低于此阈值就固定放左侧
					var spaceRight = window.innerWidth - (petX + petW + GAP) - MARGIN;
					var side = spaceRight >= MIN_RIGHT ? "right" : "left";
					var max = side === "right" ? spaceRight : petX - GAP - MARGIN;
					max = Math.max(120, Math.min(230, Math.floor(max)));
					setBubbleSide(function (prev) { return prev === side ? prev : side; });
					setBubbleMaxW(function (prev) { return prev === max ? prev : max; });
					// 歌词溢出检测（marquee）：不依赖气泡实际渲染宽度（左右两侧 abs-pos 收缩方式
					// 不同会导致 clientWidth 不可靠），直接对比【歌词文本自然宽度】vs【已知气泡宽度上限】。
					var inner = el.querySelector(".dsa-pet-bubble");
					var textEl = inner ? inner.querySelector("span") : null;
					var over = textEl ? textEl.scrollWidth > bubbleMaxW + 2 : false;
					setOverflowing(function (prev) { return prev === over ? prev : over; });
				};
				measure();
				window.addEventListener("resize", measure);
				return function () { window.removeEventListener("resize", measure); };
			}, [bubbleText, bubbleMaxW, collapsed, pos]);

			// 折叠态：会唱歌的宠物（作者形象 + 歌词气泡）
			if (collapsed) {
				var petImg = artistInfo && artistInfo.avatar ? artistInfo.avatar : (playing ? playing.albumPic : null);
				return h("div", {
					className: "dsa-pet-wrap",
					style: { left: petX, top: pos ? pos.y : window.innerHeight - 180 }
				}, [
					h("div", {
						ref: bubbleRef,
						className: "dsa-pet-bubble-pos " + bubbleSide
					}, [
						h("div", {
							className: "dsa-pet-bubble" + (isPlaying ? " sing" : "") + (overflowing ? " flowing" : ""),
							style: { maxWidth: bubbleMaxW }
						}, [
							overflowing
								? h("div", { className: "dsa-marquee", style: { animationDuration: marqueeDur + "s" } }, [
										h("span", null, bubbleText || ""),
										h("span", null, bubbleText || "")
									])
								: h("span", null, bubbleText || "♪ ~ ♪ ~ ♪"),
							h("span", { className: "dsa-pet-bubble-tail" })
						])
					]),
					isPlaying
						? h("div", { className: "dsa-pet-notes" }, [h("span", null, "♪"), h("span", null, "♫"), h("span", null, "♪")])
						: null,
					h("div", {
						className: "dsa-pet" + (isPlaying ? " singing" : ""),
						title: "展开播放器",
						onPointerDown: onDragStart,
						onClick: function (e) {
							e.stopPropagation();
							if (suppressClickRef.current) { suppressClickRef.current = false; return; }
							toggleCollapsed();
						}
					}, [
						h("span", { className: "dsa-pet-ear left" }),
						h("span", { className: "dsa-pet-ear right" }),
						petImg
							? h("img", { className: "dsa-pet-face", src: petImg, alt: "", draggable: false })
							: h("span", { className: "dsa-pet-emoji" }, "🎵")
					])
				]);
			}

			return h("div", {
				ref: cardRef,
				style: { position: "fixed", left: pos ? pos.x : window.innerWidth - WIDTH - 18, top: pos ? pos.y : window.innerHeight - 300, zIndex: 2147483000 }
			}, [
				h("div", { className: "dsa-card" }, [
					// 头部（拖动手柄）
					h("div", { className: "dsa-header dsa-drag", onPointerDown: onDragStart }, [
						h("div", { className: "dsa-cover" },
							playing && playing.albumPic
								? h("img", { src: playing.albumPic, alt: "", draggable: false })
								: h("span", null, "🎵")
						),
						h("div", { className: "dsa-meta" }, [
							h("div", { className: "dsa-title", title: title }, title),
							h("div", { className: "dsa-artist" }, artist)
						]),
						h("div", { className: "dsa-actions" }, [
							h("button", { className: "dsa-btn", title: "刷新", onClick: refresh }, ICONS.refresh),
							h("button", { className: "dsa-btn", title: collapsed ? "展开" : "折叠", onClick: toggleCollapsed }, ICONS.collapse)
						])
					]),
					// 主体
					h("div", { className: "dsa-body" }, [
						// 传输控制（含收藏）
						h("div", { className: "dsa-controls" }, [
							h("button", { className: "dsa-btn", title: "音量-", disabled: !canControl, onClick: function () { runCommand("volume-down"); } }, ICONS.voldown),
							h("button", { className: "dsa-btn", title: "上一首", disabled: !canControl, onClick: function () { runCommand("prev"); } }, ICONS.prev),
							h("button", {
								className: "dsa-btn dsa-btn-primary",
								title: "播放/暂停",
								disabled: !canControl,
								onClick: function () { runCommand("toggle-play"); }
							}, isPlaying ? ICONS.pause : ICONS.play),
							h("button", { className: "dsa-btn", title: "下一首", disabled: !canControl, onClick: function () { runCommand("next"); } }, ICONS.next),
							h("button", { className: "dsa-btn", title: "音量+", disabled: !canControl, onClick: function () { runCommand("volume-up"); } }, ICONS.volup),
							h("button", { className: "dsa-btn dsa-fav", title: "收藏/取消收藏当前歌曲", disabled: !canControl || !playing, onClick: function () { runCommand("toggle-favorite"); } }, "♥")
						]),
						// 播放列表
						state && state.queue && Array.isArray(state.queue.items)
							? h("div", { className: "dsa-queue" }, [
									h("div", { className: "dsa-queue-title", onClick: function () { setQueueOpen(!queueOpen); } }, [
										h("span", null, "播放列表"),
										h("span", { className: "cnt" }, "(" + state.queue.items.length + " 首)"),
										h("span", { className: "fold" }, queueOpen ? "▾" : "▸")
									]),
									queueOpen
										? h("div", { className: "dsa-queue-list" }, state.queue.items.map(function (item, i) {
												return h("div", {
													key: item.id + "-" + i,
													className: "dsa-qitem" +
														(i === state.queue.index ? " cur" : "") +
														(i === selectedIdx && i !== state.queue.index ? " sel" : ""),
													title: "单击选中，双击播放",
													onClick: function () { onQueueSelect(i); },
													onDoubleClick: function () { onQueueJump(i); }
												}, [
													h("span", { className: "n" }, (i + 1) + "."),
													h("span", { className: "t" }, item.name),
													h("span", { className: "s" }, item.artists || "")
												]);
											}))
										: null
								])
							: null,
						// 就绪提示 / 一键安装 / 一键就绪
						state && !state.installed
							? h("div", { className: "dsa-ready" }, [
									h("span", { className: "dot bad" }),
									h("span", { className: "txt" }, "未安装 AlgerMusicPlayer"),
									h("button", { className: "act", disabled: busy, onClick: onInstall }, busy ? "安装中…" : "一键安装")
								])
							: needSetup(state)
								? h("div", { className: "dsa-ready" }, [
										h("span", { className: "dot " + dot }),
										h("span", { className: "txt" }, readyText(state)),
										h("button", { className: "act", disabled: busy, onClick: onSetup }, busy ? "处理中…" : "一键就绪")
									])
								: h("div", { className: "dsa-ready" }, [
										h("span", { className: "dot ok" }),
										h("span", { className: "txt" }, readyText(state) + (state && state.version ? "（" + state.version + "）" : ""))
									]),
						// 搜索类型切换
						h("div", { className: "dsa-types" }, [
							h("button", { className: "dsa-type" + (searchType === 1 ? " active" : ""), onClick: function () { switchType(1); } }, "歌曲"),
							h("button", { className: "dsa-type" + (searchType === 1000 ? " active" : ""), onClick: function () { switchType(1000); } }, "歌单")
						]),
						// 搜索点歌
						h("div", { className: "dsa-search" }, [
							h("input", {
								className: "dsa-input",
								placeholder: searchType === 1 ? "搜歌名/歌手，回车或点搜索" : "搜歌单名，回车或点搜索",
								value: query,
								disabled: busy,
								onChange: function (e) { setQuery(e.target.value); },
								onKeyDown: onSearchKey
							}),
							h("button", { className: "dsa-go", disabled: searching || busy || !query.trim(), onClick: onSearch }, searching ? "…" : ICONS.search)
						]),
						// 搜索结果（歌曲：双击播放 + 加入；歌单：双击播放歌单 + 整单加入）
						results && results.length > 0
							? h("div", { className: "dsa-results" }, [
									searchType === 1
										? h("button", { className: "dsa-addall", disabled: busy, onClick: onAddAll }, "＋ 把搜索到的 " + results.length + " 首全部加入播放列表")
										: null,
									results.map(function (item) {
										if (searchType === 1) {
											return h("div", {
												key: item.id,
												className: "dsa-item",
												title: "双击播放：" + item.name,
												onDoubleClick: function () { onPlaySong(item); }
											}, [
												h("span", { className: "t" }, item.name),
												h("span", { className: "s" }, item.artists || ""),
												h("span", { className: "p" }, item.durationMs ? Math.floor(item.durationMs / 60000) + ":" + String(Math.floor(item.durationMs / 1000) % 60).padStart(2, "0") : ""),
												h("button", { className: "dsa-rowbtn", title: "加入播放列表（双击整行可播放）", disabled: busy, onClick: function (e) { e.stopPropagation(); onAddSong(item); } }, "＋加入")
											]);
										}
										return h("div", {
											key: item.id,
											className: "dsa-item",
											title: "双击播放歌单：" + item.name,
											onDoubleClick: function () { onPlayPlaylist(item); }
										}, [
											h("span", { className: "t" }, item.name),
											h("span", { className: "s" }, item.desc || ""),
											h("button", { className: "dsa-rowbtn", title: "歌单整单加入播放列表（双击整行可播放）", disabled: busy, onClick: function (e) { e.stopPropagation(); onAddPlaylist(item); } }, "＋加入")
										]);
									})
								])
							: null,
						// 通知
						notice
							? h("div", { className: "dsa-notice" + (notice.kind ? " " + notice.kind : "") }, notice.text)
							: null
					])
				])
			]);
		}

		/**
		 * 客户端插件入口：挂载浮动播放器与样式。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(function () {
				var root = document.createElement("div");
				root.id = "dsh-alger-root";
				document.body.appendChild(root);
				injectCss();
				ReactDOM.render(h(MusicPlayer), root);
				return function () {
					ReactDOM.unmountComponentAtNode(root);
					if (root.parentNode) root.parentNode.removeChild(root);
				};
			});
		}

		var inject = [];
		exports.apply = apply;
		exports.inject = inject;
		exports.name = "dsh-alger-music";
		exports.parseLrc = parseLrc;
		return module.exports;
	}
});
