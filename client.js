/**
 * Copyright (C) 2026 DongfangXie (dongfangxie)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * dsh-alger-music —— Client half（浏览器浮动播放器）。
 *
 * 由 DSH web 的模块加载器（window.__ModuleLoader__.load）挂载：右下角浮动小窗，
 * 实时展示 AlgerMusicPlayer 的播放状态，提供 播放/暂停、上一首、下一首、音量±、
 * 搜索点歌 与“一键就绪”（开启 App 远程控制并带调试口重启）。所有数据经插件
 * 服务端路由 /dsh-alger/* 中转（本机 30488/31888/CDP 不直接暴露给页面）。
 */
window.__ModuleLoader__.load({
	id: "dsh-moony-singer",
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
		var STORE_X = "dsh-alger:x";
		var STORE_Y = "dsh-alger:y";
		var MOONY_STATUS = Object.freeze({
			idle: Object.freeze({ signal: "transparent" }),
			running: Object.freeze({ signal: "#3B82F6" }),
			waiting: Object.freeze({ signal: "#F59E0B" }),
			failed: Object.freeze({ signal: "#EF4444" }),
			review: Object.freeze({ signal: "#10B981" })
		});
		var MOONY_CATALOG = Object.freeze([
			Object.freeze({ id: "classic", name: "Moony Classic", role: "初代经典", ear: "classic", tail: "none", colors: Object.freeze({ ear: "#6D5BD0", highlight: "#A99AF2", rim: "#D8D0FF" }) }),
			Object.freeze({ id: "pulse", name: "Moony · Pulse", role: "节拍追逐者", ear: "pulse", tail: "none", colors: Object.freeze({ ear: "#6944C4", highlight: "#C2A5FF", rim: "#DED1FF" }) }),
			Object.freeze({ id: "echo", name: "Moony · Echo", role: "回忆共振者", ear: "echo", tail: "orbit", colors: Object.freeze({ ear: "#394B91", highlight: "#8EA8E8", rim: "#B8C8F5" }) }),
			Object.freeze({ id: "drift", name: "Moony · Drift", role: "沉浸漂流者", ear: "drift", tail: "comet", colors: Object.freeze({ ear: "#6799A2", highlight: "#B9E0E2", rim: "#D5F2F1" }) }),
			Object.freeze({ id: "spark", name: "Moony · Spark", role: "新声探索者", ear: "spark", tail: "none", colors: Object.freeze({ ear: "#C88322", highlight: "#F2D16D", rim: "#FFE4A3" }) }),
			Object.freeze({ id: "chorus", name: "Moony · Chorus", role: "跟唱共鸣者", ear: "chorus", tail: "curl", colors: Object.freeze({ ear: "#B85388", highlight: "#F3A6C7", rim: "#FFD0E3" }) }),
			Object.freeze({ id: "hush", name: "Moony · Hush", role: "安静陪伴者", ear: "hush", tail: "none", colors: Object.freeze({ ear: "#647654", highlight: "#B9C5A6", rim: "#DBE3CE" }) })
		]);
		var MOONY_BY_ID = Object.freeze(MOONY_CATALOG.reduce(function (out, pet) { out[pet.id] = pet; return out; }, {}));

		function getMoony(id) {
			return typeof id === "string" && MOONY_BY_ID[id] ? MOONY_BY_ID[id] : MOONY_BY_ID.classic;
		}

		function resolveMoonyState(input) {
			var value = input && typeof input === "object" ? input : {};
			var status = typeof value.agentStatus === "string" && MOONY_STATUS[value.agentStatus] ? value.agentStatus : "idle";
			var mediaUrl = typeof value.mediaUrl === "string" && value.mediaUrl.trim() ? value.mediaUrl.trim() : null;
			return { pet: getMoony(value.petId), status: status, faceMode: mediaUrl ? "media" : "blank", mediaUrl: mediaUrl };
		}

		function MoonyPet(props) {
			var input = props && typeof props === "object" ? props : {};
			var value = resolveMoonyState({ petId: input.petId, agentStatus: input.agentStatus, mediaUrl: input.mediaUrl });
			var pet = value.pet;
			var style = { "--moony-ear": pet.colors.ear, "--moony-ear-highlight": pet.colors.highlight, "--moony-rim": pet.colors.rim, "--moony-signal": MOONY_STATUS[value.status].signal };
			var parts = [
				pet.tail !== "none" ? h("span", { key: "tail", className: "dsa-moony-tail", "data-moony-tail": pet.tail }) : null,
				h("span", { key: "left", className: "dsa-moony-ear left" }, h("i", { className: "dsa-moony-signal" })),
				h("span", { key: "right", className: "dsa-moony-ear right" }, h("i", { className: "dsa-moony-signal" })),
				h("span", { key: "face", className: "dsa-moony-face" }, value.faceMode === "media" ? h("img", { src: value.mediaUrl, alt: "", draggable: false, onError: function (event) { event.currentTarget.hidden = true; } }) : null)
			];
			return h("div", {
				className: "dsa-pet dsa-moony-pet" + (input.isPlaying ? " singing" : "") + " dsa-agent-" + value.status,
				"data-moony-id": pet.id, "data-moony-ear": pet.ear, style: style,
				title: input.title || pet.name, onPointerDown: input.onPointerDown, onClick: input.onClick
			}, h("span", { className: "dsa-moony-rhythm" }, parts));
		}

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
		var MOONY_CSS = [
			".dsa-pet{position:relative;width:64px;height:64px;cursor:grab;overflow:visible;user-select:none}",
			".dsa-pet:active{cursor:grabbing}.dsa-moony-rhythm{position:absolute;inset:0;display:block}",
			".dsa-pet.singing .dsa-moony-rhythm{animation:dsa-moony-rhythm .55s ease-in-out infinite alternate}",
			".dsa-moony-face{position:absolute;inset:0;z-index:3;display:block;overflow:hidden;border-radius:50%;border:3px solid rgba(255,255,255,.9);background:linear-gradient(145deg,#f5f2f8 4%,#d6cfdf 58%,#aaa1b9);box-shadow:inset 4px 5px 8px rgba(255,255,255,.58),inset -6px -7px 11px rgba(55,40,76,.14),0 8px 18px rgba(0,0,0,.34)}",
			".dsa-moony-face img{width:100%;height:100%;display:block;object-fit:cover}",
			".dsa-moony-ear{position:absolute;z-index:1;display:block;background:linear-gradient(145deg,var(--moony-ear-highlight),var(--moony-ear));border:3px solid var(--moony-rim);box-shadow:inset 3px 3px 6px rgba(255,255,255,.2),inset -4px -5px 7px rgba(30,18,60,.18),0 5px 9px rgba(0,0,0,.2);transform-origin:50% 90%}",
			".dsa-moony-ear::before{content:'';position:absolute;inset:7px;border:1px solid rgba(255,255,255,.18);border-radius:inherit}",
			".dsa-moony-signal{position:absolute;right:6px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--moony-signal);box-shadow:0 0 8px var(--moony-signal)}",
			".dsa-moony-pet[data-moony-ear='classic'] .dsa-moony-ear{top:-8px;width:22px;height:22px;border-radius:55% 45% 25% 30%}.dsa-moony-pet[data-moony-ear='classic'] .left{left:3px}.dsa-moony-pet[data-moony-ear='classic'] .right{right:3px}",
			".dsa-moony-pet[data-moony-ear='pulse'] .dsa-moony-ear{top:-23px;width:27px;height:48px;border-radius:59% 41% 20% 30%;clip-path:polygon(0 0,100% 8%,72% 100%,48% 66%,25% 100%)}.dsa-moony-pet[data-moony-ear='pulse'] .left{left:1px;transform:rotate(-12deg)}.dsa-moony-pet[data-moony-ear='pulse'] .right{right:1px;transform:scaleX(-1) rotate(-12deg)}",
			".dsa-moony-pet[data-moony-ear='echo'] .dsa-moony-ear{top:-12px;width:39px;height:34px;border-radius:65% 35% 58% 42%;clip-path:polygon(0 14%,100% 0,72% 100%,18% 82%)}.dsa-moony-pet[data-moony-ear='echo'] .left{left:-9px;transform:rotate(-18deg)}.dsa-moony-pet[data-moony-ear='echo'] .right{right:-9px;transform:scaleX(-1) rotate(-18deg)}",
			".dsa-moony-pet[data-moony-ear='drift'] .dsa-moony-ear{top:-8px;width:24px;height:54px;border-radius:55% 45% 68% 32%}.dsa-moony-pet[data-moony-ear='drift'] .left{left:-4px;transform:rotate(26deg)}.dsa-moony-pet[data-moony-ear='drift'] .right{right:-4px;transform:rotate(-26deg)}",
			".dsa-moony-pet[data-moony-ear='spark'] .left{left:5px;top:-27px;width:19px;height:50px;border-radius:60% 40% 18% 28%;transform:rotate(-23deg)}.dsa-moony-pet[data-moony-ear='spark'] .right{right:-7px;top:-8px;width:37px;height:29px;border-radius:70% 30% 55% 45%;transform:rotate(8deg)}",
			".dsa-moony-pet[data-moony-ear='chorus'] .dsa-moony-ear{top:-18px;width:39px;height:40px;clip-path:polygon(50% 0,65% 39%,100% 20%,76% 60%,98% 84%,56% 75%,40% 100%,29% 68%,0 75%,25% 47%)}.dsa-moony-pet[data-moony-ear='chorus'] .left{left:-7px;transform:rotate(-9deg)}.dsa-moony-pet[data-moony-ear='chorus'] .right{right:-7px;transform:scaleX(-1) rotate(-9deg)}",
			".dsa-moony-pet[data-moony-ear='hush'] .dsa-moony-ear{top:-24px;width:37px;height:32px;border-radius:70% 30% 62% 38%;clip-path:polygon(0 10%,100% 0,78% 100%,18% 85%)}.dsa-moony-pet[data-moony-ear='hush'] .left{left:-9px;transform:rotate(-22deg)}.dsa-moony-pet[data-moony-ear='hush'] .right{right:-9px;transform:scaleX(-1) rotate(-22deg)}",
			".dsa-moony-tail{position:absolute;z-index:2;pointer-events:none}.dsa-moony-tail[data-moony-tail='orbit']{right:-8px;bottom:-5px;width:38px;height:32px;border:6px solid var(--moony-ear);border-left-color:transparent;border-radius:50%;transform:rotate(25deg)}",
			".dsa-moony-tail[data-moony-tail='comet']{right:-12px;bottom:5px;width:38px;height:17px;border-radius:70% 30% 70% 30%;background:linear-gradient(90deg,var(--moony-ear-highlight),transparent);transform:rotate(24deg)}",
			".dsa-moony-tail[data-moony-tail='curl']{right:-7px;bottom:-6px;width:31px;height:31px;border:6px solid var(--moony-ear);border-left-color:transparent;border-radius:50%;transform:rotate(12deg)}",
			".dsa-agent-running .dsa-moony-ear,.dsa-agent-waiting .dsa-moony-ear,.dsa-agent-failed .dsa-moony-ear,.dsa-agent-review .dsa-moony-ear{border-color:var(--moony-signal);filter:drop-shadow(0 0 5px var(--moony-signal))}",
			".dsa-agent-running .dsa-moony-ear{animation:dsa-moony-running .52s ease-in-out infinite alternate}.dsa-agent-running .dsa-moony-ear.right{animation-direction:alternate-reverse}.dsa-agent-waiting .dsa-moony-ear{animation:dsa-moony-waiting 1.4s ease-in-out infinite}.dsa-agent-failed .dsa-moony-ear{animation:dsa-moony-failed .24s linear 3}.dsa-agent-review .dsa-moony-ear{animation:dsa-moony-review 1s ease-in-out infinite alternate}",
			".dsa-agent-running .dsa-moony-tail{animation:dsa-moony-tail-sway .52s ease-in-out infinite alternate}.dsa-agent-waiting .dsa-moony-tail{animation:dsa-moony-tail-listen 1.4s ease-in-out infinite}.dsa-agent-failed .dsa-moony-tail{animation:dsa-moony-tail-failed .24s linear 3}.dsa-agent-review .dsa-moony-tail{animation:dsa-moony-tail-review 1s ease-in-out infinite alternate}",
			"@keyframes dsa-moony-rhythm{from{translate:0 0}to{translate:0 -4px}}@keyframes dsa-moony-running{from{rotate:-7deg}to{rotate:7deg}}@keyframes dsa-moony-waiting{0%,100%{translate:-1px 0}50%{translate:2px 1px}}@keyframes dsa-moony-failed{0%,100%{translate:0 0}25%{translate:-2px 0}75%{translate:2px 0}}@keyframes dsa-moony-review{from{translate:0 0}to{translate:0 -3px}}",
			"@keyframes dsa-moony-tail-sway{from{rotate:-5deg}to{rotate:7deg}}@keyframes dsa-moony-tail-listen{0%,100%{translate:0 0}50%{translate:0 -2px}}@keyframes dsa-moony-tail-failed{0%,100%{translate:0 0}25%{translate:-2px 0}75%{translate:2px 0}}@keyframes dsa-moony-tail-review{from{translate:0 0}to{translate:0 -2px}}",
			"@media (prefers-reduced-motion:reduce){.dsa-moony-rhythm,.dsa-moony-ear,.dsa-moony-tail{animation:none!important}}"
		].join("\n");
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
			".dsa-mode{font-size:10px;min-width:32px;padding:0 3px;color:rgba(255,255,255,0.85)}",
			".dsa-mode-icon{width:24px;height:24px;color:rgba(255,255,255,0.8)}",
			".dsa-shape{font-size:11px;font-weight:700;min-width:44px;padding:0 8px;border-radius:9px;color:#1c1200;background:linear-gradient(135deg,#fbbf24,#f97316);box-shadow:0 0 10px rgba(251,146,60,0.55),0 2px 8px rgba(0,0,0,0.3);transition:filter .15s,box-shadow .15s}",
			".dsa-shape:hover{filter:brightness(1.12);box-shadow:0 0 16px rgba(251,146,60,0.8),0 2px 10px rgba(0,0,0,0.35)}",
			".dsa-body{padding:2px 12px 12px}",
			".dsa-controls{display:flex;align-items:center;justify-content:center;gap:3px;margin-top:4px}",
			".dsa-search{display:flex;gap:6px;margin-top:8px}",
			".dsa-input{flex:1;min-width:0;background:rgba(255,255,255,0.13);border:1px solid rgba(255,255,255,0.22);border-radius:9px;color:#fff;font-size:12px;padding:5px 9px;outline:none;backdrop-filter:blur(6px)}",
			".dsa-input:focus{border-color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.17)}",
			".dsa-input::placeholder{color:rgba(255,255,255,0.5)}",
			".dsa-go{flex:none;border:none;border-radius:9px;background:transparent;color:#fff;font-size:12px;padding:0 12px;cursor:pointer;font-weight:600}",
			".dsa-go:hover{background:rgba(255,255,255,0.16)}",
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
			".dsa-fav{color:rgba(255,255,255,0.92)}.dsa-fav:hover{background:rgba(255,255,255,0.14);color:#fff}",
			".dsa-fav.active{color:#ef4444;text-shadow:0 0 8px rgba(239,68,68,0.7)}.dsa-fav.active:hover{background:rgba(239,68,68,0.16);color:#ef4444}",
			".dsa-conn{flex:none;display:flex;align-items:center;gap:5px;border:1px solid rgba(255,255,255,0.22);border-radius:999px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.85);font-size:10.5px;padding:3px 9px;cursor:pointer;white-space:nowrap}",
			".dsa-conn:hover{background:rgba(255,255,255,0.16)}",
			".dsa-conn:disabled{opacity:0.55;cursor:wait}",
			".dsa-conn .dot{width:7px;height:7px;border-radius:50%;flex:none}",
			".dsa-conn .dot.ok{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,0.9)}",
			".dsa-conn .dot.wait{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,0.9)}",
			".dsa-conn .dot.bad{background:#ef4444;box-shadow:0 0 6px rgba(239,68,68,0.9)}",
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
			".dsa-pet-bubble.notice{background:rgba(16,45,34,0.92);border-color:rgba(52,211,153,0.55);color:#a7f3d0;font-weight:600}",
			".dsa-pet-bubble-pos.right .dsa-pet-bubble.notice + .dsa-pet-bubble-tail,.dsa-pet-bubble.notice ~ .dsa-pet-bubble-tail{border-right-color:rgba(16,45,34,0.92)}",
			".dsa-pet-bubble-pos.left .dsa-pet-bubble.notice ~ .dsa-pet-bubble-tail{border-left-color:rgba(16,45,34,0.92)}",
			".dsa-pet-bubble .dsa-marquee{display:flex;width:max-content;animation-name:dsa-marquee;animation-timing-function:linear;animation-iteration-count:infinite;will-change:transform}",
			".dsa-pet-bubble .dsa-marquee span{white-space:nowrap;padding-right:28px}",
			"@keyframes dsa-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}",
			".dsa-pet-bubble-tail{position:absolute;top:50%;width:0;height:0;border-top:6px solid transparent;border-bottom:6px solid transparent;transform:translateY(-50%)}",
			".dsa-pet-bubble-pos.right .dsa-pet-bubble-tail{left:-7px;border-right:7px solid rgba(13,15,24,0.9)}",
			".dsa-pet-bubble-pos.left .dsa-pet-bubble-tail{right:-7px;border-left:7px solid rgba(13,15,24,0.9)}",
			".dsa-pet-notes{position:absolute;top:-24px;right:-10px;display:flex;gap:2px;font-size:14px;color:#fbbf24;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,0.5)}",
			".dsa-pet-notes span{animation:dsa-note-float 1.3s ease-in-out infinite}",
			".dsa-pet-notes span:nth-child(2){animation-delay:.35s}",
			".dsa-pet-notes span:nth-child(3){animation-delay:.7s}",
			"@keyframes dsa-bubble-bob{from{transform:translateY(0)}to{transform:translateY(-2px)}}",
			"@keyframes dsa-note-float{0%{transform:translateY(0);opacity:0}30%{opacity:1}100%{transform:translateY(-14px);opacity:0}}"
		].concat(MOONY_CSS).join("\n");

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
			collapse: "—",
			search: "🔍"
		};

		// 播放模式图标（0=列表循环 / 1=单曲循环 / 2=随机），通用描边 SVG，三态切换
		var MODE_ICON_PATHS = [
			// 列表循环
			["M17 1l4 4-4 4", "M3 11V9a4 4 0 0 1 4-4h14", "M7 23l-4-4 4-4", "M21 13v2a4 4 0 0 1-4 4H3"],
			// 单曲循环（带 1）
			["M17 1l4 4-4 4", "M3 11V9a4 4 0 0 1 4-4h14", "M7 23l-4-4 4-4", "M21 13v2a4 4 0 0 1-4 4H3", "M11 10l1-1v4"],
			// 随机（交叉箭头）
			["M16 3h5v5", "M4 20L21 3", "M21 16v5h-5", "M15 15l6 6", "M4 4l5 5"]
		];
		function PlayModeIcon(props) {
			var paths = MODE_ICON_PATHS[(props && props.mode ? props.mode : 0) % 3];
			return h("svg", {
				width: 15,
				height: 15,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}, paths.map(function (d, i) {
				return h("path", { key: i, d: d });
			}));
		}

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

		/* ---------- 宠物显示状态（浮窗与侧边栏开关共享） ---------- */
		var petVis = { hidden: false, subs: [] };
		function setPetHidden(v) {
			petVis.hidden = !!v;
			petVis.subs.forEach(function (fn) { fn(petVis.hidden); });
		}
		function onPetHidden(fn) {
			petVis.subs.push(fn);
			return function () { petVis.subs = petVis.subs.filter(function (f) { return f !== fn; }); };
		}

		/* ---------- 侧边栏底部宠物开关（与一键重启同组） ---------- */
		function PetToggleButton() {
			var [hidden, setHidden] = React.useState(petVis.hidden);
			React.useEffect(function () { return onPetHidden(setHidden); }, []);
			return h("div", {
				style: { padding: "4px 2px 2px", width: "100%" }
			}, h("button", {
				type: "button",
				title: hidden ? "激活月宝音乐宠物" : "关闭月宝音乐宠物",
				onClick: function () { setPetHidden(!petVis.hidden); },
				style: {
					width: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					gap: 6,
					padding: "8px 12px",
					fontFamily: "inherit",
					fontSize: 13,
					lineHeight: "20px",
					color: hidden ? "var(--dsw-alias-label-secondary, #666)" : "#60a5fa",
					background: hidden ? "transparent" : "rgba(96,165,250,.12)",
					border: hidden
						? "1px solid var(--dsw-alias-border-2, rgba(128,128,128,.25))"
						: "1px solid rgba(96,165,250,.4)",
					borderRadius: 10,
					cursor: "pointer"
				}
			}, "♪ 音乐宠物"));
		}

		/* ---------- 浮动播放器 ---------- */
		function MusicPlayer() {
			var [state, setState] = React.useState(null);
			// 默认宠物形态（收起）：每次打开先看到宠物，点击才切换播放器
			var [collapsed, setCollapsed] = React.useState(true);
			var [pos, setPos] = React.useState(null);
			var posRef = React.useRef(null);
			var dragRef = React.useRef(null);
			var cardRef = React.useRef(null);
			var [query, setQuery] = React.useState("");
			var [searchType, setSearchType] = React.useState(1); // 1=歌曲 1000=歌单
			var [searched, setSearched] = React.useState(false); // 是否已搜索过（控制歌曲/歌单 tab 显隐）
			var [searching, setSearching] = React.useState(false);
			var [results, setResults] = React.useState(null);
			var [queueOpen, setQueueOpen] = React.useState(false);
			var [selectedIdx, setSelectedIdx] = React.useState(null); // 播放列表"单击选中"的行
			var [favOptimistic, setFavOptimistic] = React.useState(null); // 收藏乐观状态（null=跟随真实状态）
			// 关闭/激活与侧边栏开关按钮共享（pub/sub）
			var [hidden, setHidden] = React.useState(petVis.hidden);
			React.useEffect(function () { return onPetHidden(setHidden); }, []);
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
				setCollapsed(!collapsed);
			};

			var runCommand = function (action) {
				if (!state || !state.remoteUp) { flash("err", "远程控制未就绪，请先点“连接”"); return; }
				command(action).then(function (r) {
					if (r && r.ok === false) flash("err", r.error || "命令失败");
					setTimeout(refresh, 400);
				}).catch(function () { flash("err", "命令发送失败"); });
			};

			// 收藏：乐观更新——点击立即变红/变白（不等轮询），不弹文字；命令失败才提示
			var onToggleFavorite = function () {
				if (!state || !state.remoteUp || !playing) { flash("err", "没有正在播放的歌曲"); return; }
				var target = !(favOptimistic !== null ? favOptimistic : Boolean(state.favorite));
				setFavOptimistic(target);
				setTimeout(function () { setFavOptimistic(null); }, 2500); // 2.5s 后由轮询的真实状态接管
				command("toggle-favorite").then(function (r) {
					if (r && r.ok === false) { setFavOptimistic(null); flash("err", r.error || "收藏失败"); return; }
					setTimeout(refresh, 300);
				}).catch(function () { setFavOptimistic(null); flash("err", "收藏失败"); });
			};

			// 右上角连接按钮：未安装→一键安装；未就绪→一键就绪；已连接→重查
			var connLabel = !state
				? "…"
				: !state.installed
					? "安装"
					: state.remoteUp && state.cdpUp
						? "已连接"
						: "连接";
			var onConnClick = function () {
				if (!state) return;
				if (!state.installed) { onInstall(); return; }
				if (!(state.remoteUp && state.cdpUp)) { onSetup(); return; }
				refresh();
			};

			// 推荐播放：不知道听什么时一键推荐
			var onRecommend = function () {
				if (!state || !state.remoteUp) { flash("err", "远程控制未就绪，请先点“连接”"); return; }
				setBusy(true);
				post("/dsh-alger/recommend", {}).then(function (r) {
					setBusy(false);
					if (r && !r.ok) flash("err", (r && r.guidance) || (r && r.error) || "推荐失败");
					// 成功时结果由宠物气泡播报（服务端 notice）
					setTimeout(refresh, 600);
				}).catch(function () { setBusy(false); flash("err", "推荐失败"); });
			};

			var onSearch = function (forcedType) {
				var q = query.trim();
				if (!q) return;
				// 切换 tab 重搜时显式传 type，避免 setTimeout 闭包捕获旧的 searchType 导致搜错类型
				var t = typeof forcedType === "number" ? forcedType : searchType;
				setSearched(true);
				setSearching(true);
				setResults(null);
				searchMusic(q, t).then(function (r) {
					setSearching(false);
					if (!r || r.ok === false) { flash("err", (r && r.error) || "搜索失败"); setResults(null); return; }
					setResults(r.items || []);
				}).catch(function () { setSearching(false); flash("err", "搜索失败"); });
			};

			var switchType = function (type) {
				setSearchType(type);
				setResults(null);
				if (query.trim()) setTimeout(function () { onSearch(type); }, 0);
			};

			var onPlaySong = function (item) {
				setBusy(true);
				playSong({ songId: item.id }).then(function (r) {
					setBusy(false);
					if (r && r.ok) {
						flash("ok", "已点播：" + (r.playedName || item.name) + (r.confirmed ? "" : "（待确认）"));
						setResults(null);
						setSearched(false);
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
			// 宠物台词/通知优先（agent 播报），其次歌词
			var isNotice = Boolean(state && state.notice);
			var bubbleText = isNotice
				? state.notice
				: (line && line.text
					? line.text
					: (playing ? title + (artist ? " · " + artist : "") : "未在播放"));
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

			// 已关闭：浮动区域完全不渲染，仅保留侧边栏底部开关作为恢复入口。
			if (hidden) return null;

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
							className: "dsa-pet-bubble" +
								(isPlaying ? " sing" : "") +
								(overflowing ? " flowing" : "") +
								(isNotice ? " notice" : ""),
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
						className: "dsa-pet" +
							(isPlaying ? " singing" : "") +
							(state && state.agentStatus && state.agentStatus !== "idle" ? " dsa-agent-" + state.agentStatus : ""),
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
					// 头部（拖动手柄）：封面 + 标题 + 右侧[已连接][切换形态]
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
							// 连接状态 + 连接/安装/就绪按钮（右上角）
							h("button", {
								className: "dsa-conn" + (state && state.remoteUp && state.cdpUp ? " on" : ""),
								disabled: busy,
								onClick: onConnClick
							}, [
								h("span", { className: "dot " + dot }),
								h("span", null, connLabel)
							]),
							// 切换形态：收起为宠物 / 展开播放器（月宝圆脸 ↔ 播放器卡片）
							h("button", {
								className: "dsa-btn dsa-shape",
								title: "收起为宠物 / 展开播放器",
								onClick: function (e) { e.stopPropagation(); toggleCollapsed(); }
							}, "变身")
						])
					]),
					// 主体
					h("div", { className: "dsa-body" }, [
						// 传输控制（含收藏）
						h("div", { className: "dsa-controls" }, [
							h("button", { className: "dsa-btn dsa-mode", title: "推荐播放（不知道听什么时用）", disabled: !canControl || busy, onClick: onRecommend }, "推荐"),
														h("button", { className: "dsa-btn", title: "上一首", disabled: !canControl, onClick: function () { runCommand("prev"); } }, ICONS.prev),
							h("button", {
								className: "dsa-btn dsa-btn-primary",
								title: "播放/暂停",
								disabled: !canControl,
								onClick: function () { runCommand("toggle-play"); }
							}, isPlaying ? ICONS.pause : ICONS.play),
							h("button", { className: "dsa-btn", title: "下一首", disabled: !canControl, onClick: function () { runCommand("next"); } }, ICONS.next),
							h("button", {
								className: "dsa-btn dsa-fav" + ((favOptimistic !== null ? favOptimistic : Boolean(state && state.favorite)) ? " active" : ""),
								title: "收藏/取消收藏当前歌曲",
								disabled: !canControl || !playing,
								onClick: onToggleFavorite
							}, "♥"),
							h("button", {
								className: "dsa-btn dsa-mode-icon",
								title: "播放模式：单击切换（列表循环 / 单曲循环 / 随机）",
								disabled: !canControl,
								onClick: function () { runCommand("playmode"); }
							}, h(PlayModeIcon, { mode: state && typeof state.playMode === "number" ? state.playMode : 0 }))
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
						// 搜索点歌（未搜索时只显示输入框，不显示歌曲/歌单 tab）
						h("div", { className: "dsa-search" }, [
							h("input", {
								className: "dsa-input",
								placeholder: searchType === 1 ? "搜歌名/歌手，回车或点搜索" : "搜歌单名，回车或点搜索",
								value: query,
								disabled: busy,
								onChange: function (e) { setQuery(e.target.value); },
								onKeyDown: onSearchKey
							}),
							h("button", {
								className: "dsa-go",
								disabled: searching || busy || !query.trim(),
								onClick: onSearch
							}, searching
								? "…"
								: h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }, [
										h("circle", { cx: 11, cy: 11, r: 7 }),
										h("line", { x1: 21, y1: 21, x2: 16.2, y2: 16.2 })
									])
							)
						]),
						// 搜索结果（搜索后出现歌曲/歌单 tab，可左右切换重新搜索；歌曲：双击播放 + 加入；歌单：双击播放歌单 + 整单加入）
						searched
							? h("div", { className: "dsa-types" }, [
									h("button", { className: "dsa-type" + (searchType === 1 ? " active" : ""), onClick: function () { switchType(1); } }, "歌曲"),
									h("button", { className: "dsa-type" + (searchType === 1000 ? " active" : ""), onClick: function () { switchType(1000); } }, "歌单")
								])
							: null,
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
			// 侧边栏设置按钮右边的宠物开关
			if (ctx.slots) {
				ctx.slots.inject('sidebar.footer.action', function () {
					return ctx.slots.register(
						{ name: 'sidebar.footer.action', id: 'moony-singer-pet-toggle', order: 999 },
						function () { return h(PetToggleButton); }
					);
				});
			}
		}

		var inject = ["slots"];
		exports.apply = apply;
		exports.inject = inject;
		exports.name = "dsh-moony-singer";
		exports.parseLrc = parseLrc;
		exports.MOONY_CSS = MOONY_CSS;
		exports.MOONY_CATALOG = MOONY_CATALOG;
		exports.MOONY_STATUS = MOONY_STATUS;
		exports.getMoony = getMoony;
		exports.resolveMoonyState = resolveMoonyState;
		exports.MoonyPet = MoonyPet;
		return module.exports;
	}
});
