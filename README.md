# dsh-moony-singer（月宝 Moony）

DSH（DeepSeek Harness）本地音乐播放插件：**自带开源音乐 API 服务 + 浏览器内置播放引擎**，
无需安装任何桌面播放器，装完即用——搜索、点歌、歌单、歌词、推荐一键播放。

## 🎬 演示视频

[`demo/moony-singer-demo.mp4`](./demo/moony-singer-demo.mp4)：63 秒功能介绍
（默认宠物形态 → 播放器 → 搜索/播放/换歌 → 播放模式/收藏 → 播放列表 → 宠物歌词）。
录制脚本与说明见 [`demo/README.md`](./demo/README.md)。

## 🐰 宠物 IP：月宝 Moony

Moony 现在包含常驻初代 **Moony Classic** 与六只 First Wave 成员。展开音乐浮窗即可切换角色；选择保存在浏览器本地，异常值自动回退 Classic。

![Moony Classic 与 First Wave](docs/moony-series.png)

核心规则：空闲脸完全留白；播放时圆脸只显示歌手或唱片内容；身份和状态由月化耳朵、可选尾巴、耳尖信号灯及动作表达。完整规范见 [docs/IP.md](docs/IP.md)。

## 许可与致谢

- 本插件（dsh-moony-singer）以 **GPL-3.0** 许可发布，见 [LICENSE](./LICENSE)。
  你可以自由使用、修改与分发，但**任何分发或衍生作品（包括商用）都必须以相同许可开源**。
- 音乐数据与播放地址来自插件内置的**开源音乐 API 项目**（`netease-cloud-music-api-alger`，MIT 许可），
  上游为 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)（ISC）。
- 仅搜索与播放无版权限制的音乐资源；请遵守你所用音乐平台的服务条款。

## 工作原理

插件启动时自动拉起一个本机音乐 API 服务（默认 30588，仅 127.0.0.1），
搜索 / 歌曲详情 / 歌词 / 播放地址 / 歌单 / 推荐全部走它；播放由浮窗内的浏览器 `<audio>` 引擎出声。

| 组件 | 说明 |
| --- | --- |
| 内置音乐 API | 端口 30588（仅回环），插件自动启动/停止，无需任何外部依赖 |
| 播放状态机 | 服务端内存态：队列 / 当前曲 / 播放模式 / 收藏 / 进度 |
| 浏览器播放引擎 | 浮窗内 `<audio>` 元素播放直链，进度定时上报回服务端 |

## 工具与浮动窗口

插件分两个半身：

**工具（给模型用，对话里说"播放××"即可触发）：**

| 工具 | 说明 |
| --- | --- |
| `alger_status` | 检查音乐服务、当前播放、进度、收藏与播放模式 |
| `alger_setup` | 音乐服务管理：`check` 检查 / `start` 启动 / `stop` 停止（插件加载时自动启动，一般无需手动） |
| `alger_search` | 搜索歌曲/专辑/歌单/歌手（type=1/10/1000/1004） |
| `alger_song` | 单曲详情 + 歌词 + 播放直链 |
| `alger_playlist` | 歌单歌曲列表 |
| `alger_play` | 点歌：`songId` 或 `keyword`，立即播放 |
| `alger_queue` | 播放列表：`add` 追加单曲 / `add-all` 整批加入 / `add-next` 插入下一首 / `playlist` 整单播放歌单 / `jump` 跳转 |
| `alger_control` | 播放/暂停/切歌/音量/收藏/播放模式 |
| `alger_recommend` | 推荐播放：随机推荐歌单整单播放 |
| `alger_say` | 让音乐宠物开口说一句话（气泡提示约 6 秒，播报点歌/状态） |

**浮动播放窗口（浏览器右下角）：**
- 实时显示当前歌曲 / 歌手 / 播放状态与**播放列表**（每 1.5s 轮询）；
- **宠物会说话**：点歌/加入队列时自动播报；`alger_say` 可让宠物开口；
- **agent 状态光环**：DSH 正在处理=蓝色脉冲环、等你审批=橙环、出错=红环、待审查=绿环；
- 播放/暂停、上一首、下一首、**收藏**（♥）、播放模式（列表循环/单曲循环/随机）按钮；
- 搜索框点歌（歌曲/歌单两种模式）；歌曲结果可**单首加入**或**一键全部加入播放列表**；歌单结果**一键整单播放**；
- 右上角**「变身」**可在七只 Moony 间切换；
- 可拖动、可折叠，位置记忆在浏览器 localStorage。

窗口数据经插件服务端路由 `/dsh-alger/state|command|search|play|queue|setup|url|playback` 中转，
页面不直接接触本机音乐 API 端口。

## 安装（到 web profile）

```bash
dsh plugin --profile web add github:Dongfang81/moony-singer   # 或 git 仓库地址
# 然后重启 dsh web 生效
```

**无需安装任何桌面播放器**——插件自带全部能力，装完即用。

## 配置（可选，默认值即可用）

在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: alger-music
  name: 'dsh-moony-singer'
  config:
    musicApiPort: 30588   # 内置音乐 API 端口（改端口需避开占用）
    musicApiHost: '127.0.0.1'
    timeoutMs: 20000      # 单次操作超时（毫秒）
```

## 常见问题

- **音乐服务未就绪**：右上角按钮显示「连接」时点击即可自动启动；插件加载时本应自动启动，
  若失败多半是端口被占用，可改 `musicApiPort` 或重启 dsh web。
- **部分歌曲无法播放**：版权限制的歌曲可能没有可用播放地址（`alger_song` 会返回 `url: null`），换一首即可。
- **播放不出声**：浏览器可能拦截了自动播放，点一下浮窗的播放/暂停按钮即可。
- **内置服务安全**：音乐 API 只监听 `127.0.0.1`，不暴露到局域网。
