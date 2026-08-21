/**
 * dsh-music/lib/api-server.js —— 内置音乐 API 服务管理。
 *
 * 通过 ctx.subprocess.spawn 启动一个独立 node 进程运行开源网易云音乐 API
 * （netease-cloud-music-api-alger，MIT），监听本机回环端口，供搜索/详情/
 * 歌词/直链/歌单/推荐使用。插件卸载或宿主退出时自动停止。
 *
 * @module dsh-music/lib/api-server
 */

/** 生成子进程入口脚本（作为 node -e 传给子进程）。 */
export function buildServerEntry(serverEntryPath, port, host) {
	const js = String.raw`
const { serveNcmApi } = require(${JSON.stringify(serverEntryPath)});
(async () => {
	try {
		const app = await serveNcmApi({ port: ${Number(port)}, host: ${JSON.stringify(host || '127.0.0.1')} });
		process.on('SIGTERM', () => { try { app.server.close(); } catch {} setTimeout(() => process.exit(0), 50); });
		process.on('SIGINT', () => { try { app.server.close(); } catch {} setTimeout(() => process.exit(0), 50); });
	} catch (error) {
		console.error('[moony-api] 启动失败:', error && error.message ? error.message : String(error));
		process.exit(1);
	}
})();`;
	return js;
}

/**
 * 启动内置音乐 API 服务。
 * @param {object} opts - { spawn, serverEntryPath, port, host }
 * @returns {{ok:boolean, handle?:object, error?:string}}
 */
export function startApiServer({ spawn, serverEntryPath, port, host }) {
	const entry = buildServerEntry(serverEntryPath, port, host);
	let handle;
	try {
		handle = spawn({
			argv: ['node', '-e', entry],
			cwd: process.cwd(),
			stdio: {
				stdin: 'ignore',
				stdout: { maxBytes: 1024 * 1024 },
				stderr: { maxBytes: 1024 * 1024 }
			},
			graceMs: 3000
		});
	} catch (error) {
		return { ok: false, error: '无法启动音乐服务进程: ' + ((error && error.message) || String(error)) };
	}
	return { ok: true, handle };
}

/** 停止内置音乐 API 服务（发送 SIGTERM；由宿主 subprocess 管理）。 */
export async function stopApiServer(handle) {
	if (!handle) return;
	try {
		if (typeof handle.kill === 'function') await handle.kill('SIGTERM');
	} catch {
		/* 已退出则忽略 */
	}
}
