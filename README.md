# dsh-alger-music

DSH（DeepSeek Harness）本地音乐控制插件：驱动开源播放器 **AlgerMusicPlayer** 播放/控制音乐。

不走浏览器播放、不解析音源，而是**调用你本机 App 自己的本地服务**：
音质、歌词、下载、EQ 全部由 App 负责，插件只做“控制”。

## 🎬 演示视频

[`demo/dsh-alger-music-demo.mp4`](./demo/dsh-alger-music-demo.mp4)：63 秒功能介绍
（默认宠物形态 → 播放器 → 搜索/播放/换歌 → 播放模式/收藏 → 播放列表 → 宠物歌词）。
录制脚本与说明见 [`demo/README.md`](./demo/README.md)。

## 🐰 宠物 IP：月宝 Moony

圆脸 + 耳朵 —— 所有宠物共用圆形脸（可装载照片 / 贴图 / 表情），
靠不同耳朵的造型 / 颜色 / 动效区分身份。完整定义见 [docs/IP.md](./docs/IP.md)。

## 许可与致谢

- 本插件（dsh-alger-music）以 **MIT** 许可发布，见 [LICENSE](./LICENSE)。
- 本插件是**独立实现的控制/自动化工具**：不包含、不修改、不分发 AlgerMusicPlayer 及其任何依赖的代码，
  仅通过 App 自身提供的本地 HTTP 服务（30488/31888）与 Chromium CDP 调试协议与其互操作。
- 所驱动的 [AlgerMusicPlayer](https://github.com/algerkong/AlgerMusicPlayer) 以 **MIT** 许可发布
  （Copyright (c) 2026 Alger）；其内置的 `netease-cloud-music-api-alger` 为 **MIT**，
  上游 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 为 **ISC**，
  内置解锁模块 `@unblockneteasemusic/server` 为 **LGPL-3.0**（在 App 内部使用，与本插件无关）。
- 使用本插件前请自行确认：你已安装 AlgerMusicPlayer，并遵守其许可条款及你所用音乐平台的服务条款。

## 工作原理

AlgerMusicPlayer 自带的三个本机通道：

| 通道 | 端口 | 用途 |
| --- | --- | --- |
| 音乐 API（App 内置） | 30488（仅 127.0.0.1） | 搜索 / 歌曲详情 / 歌词 / 播放地址 / 歌单 |
| 远程控制（express） | 31888（默认关闭） | 播放/暂停、上一首/下一首、音量±、收藏、当前状态 |
| CDP 调试口 | 9333（需带参启动） | 点歌：把指定歌曲直接塞进 App 播放器开播 |

插件会在 App 的 `config.json` 写入 `remoteControl` 配置（仅允许本机回环 IP），
并以 `--remote-debugging-port=9333` 启动 App。

## 工具与浮动窗口

插件分两个半身：

**工具（给模型用，对话里说"播放××"即可触发）：**

| 工具 | 说明 |
| --- | --- |
| `alger_status` | 检查 App、三个通道、当前播放状态与播放列表 |
| `alger_setup` | 一键就绪：`check` 检查 / `enable` 开远程控制 / `launch` 启动 / `relaunch` 写配置并以 CDP 重启 |
| `alger_install` | 自动安装 AlgerMusicPlayer（未安装时）：按 CPU 架构下载官方 DMG（镜像兜底）→ 校验 → 装进 /Applications |
| `alger_search` | 搜索歌曲/专辑/歌单/歌手（type=1/10/1000/1004） |
| `alger_song` | 单曲详情 + 歌词 + 播放直链 |
| `alger_playlist` | 歌单歌曲列表 |
| `alger_play` | 点歌：`songId` 或 `keyword`，立即播放 |
| `alger_queue` | 播放列表：`add` 追加单曲 / `add-all` 整批加入 / `add-next` 插入下一首 / `playlist` 整单播放歌单 |
| `alger_control` | 播放/暂停/切歌/音量/收藏/播放模式 |
| `alger_say` | 让音乐宠物开口说一句话（气泡提示约 6 秒，播报点歌/状态） |

**浮动播放窗口（浏览器右下角）：**
- 实时显示当前歌曲 / 歌手 / 播放状态与**播放列表**（每 1.5s 轮询）；
- **宠物会说话**：点歌/加入队列时自动播报；`alger_say` 可让宠物开口；
- **agent 状态光环**（Codex Pets 式）：DSH 正在处理=蓝色脉冲环、等你审批=橙环、出错=红环、待审查=绿环；
- 播放/暂停、上一首、下一首、音量±、**收藏**（♥）按钮；
- 搜索框点歌（歌曲/歌单两种模式）；歌曲结果可**单首加入**或**一键全部加入播放列表**；歌单结果**一键整单播放**；
- **未安装 App 时显示"一键安装"**（自动下载安装 AlgerMusicPlayer）；装好后"一键就绪"开启远程控制并以调试口重启；
- 可拖动、可折叠，位置记忆在浏览器 localStorage。

窗口数据经插件服务端路由 `/dsh-alger/state|command|search|play|queue|setup|install` 中转，
页面不直接接触 App 的本地端口。

## 安装（到 web profile）

```bash
dsh plugin --profile web add /path/to/dsh-alger-music   # 或 git 仓库地址
# 然后重启 dsh web 生效
```

## 依赖说明（安装即用：无需提前安装 App）

插件**驱动**开源播放器 AlgerMusicPlayer（播放/登录/歌词/下载都在 App 内，插件只做控制）。
**新机器无需提前安装 App**，装完插件后全流程自动化：

1. **装插件**：`dsh plugin --profile web add github:Dongfang81/dsh-alger-music` → 重启 dsh web；
2. **装 App**（浮窗右上角按钮显示 **「安装」**，或对话里调 `alger_install`）：
   - 自动按 CPU 架构（arm64/x64）下载官方 DMG（GitHub 直连 + **镜像兜底**，约 130MB）；
   - 校验 DMG 完整性 → 挂载 → 安装进 `/Applications`（若检测到旧版正在运行会先退出，旧版备份为 `.bak`，不删除）→ 清理安装包；
3. **连接**（按钮变 **「连接」**，或 `alger_setup action=relaunch`）：一键开启远程控制并以调试口重启 App；
4. 之后即可对话点歌 / 小窗操作（按钮显示 **「已连接」**）。

**两个前提**：① 需要网络下载（国内自动走镜像）；② 写入 `/Applications` 需要当前用户有管理员权限（个人电脑默认满足）。

## 配置（可选，默认值即可用）

在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: alger-music
  name: 'dsh-alger-music'
  config:
    musicApiPort: 30488   # App 内设置的音乐 API 端口
    remotePort: 31888     # 远程控制端口
    cdpPort: 9333         # CDP 调试端口（点歌用）
    enableCdp: true       # 是否默认以调试端口启动
    appPath: /Applications/AlgerMusicPlayer.app
```

## 常见问题

- **点歌前先就绪**：先 `alger_setup action=relaunch`（会重启 App，中断当前播放），
  之后 `alger_play songId=xxx` 即可直达播放。
- **VIP/版权受限歌曲**：`alger_song` 可能拿不到直链（网易 API 限制），
  但 App 应用内可正常播放；`alger_play` 不受影响（走 App 自身解析）。
- **远程控制安全**：插件写入的 `allowedIps` 只放行本机回环地址；
  该服务默认关闭，仅在插件启用时开启。
