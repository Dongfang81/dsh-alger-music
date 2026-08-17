# 演示视频与录制

`dsh-alger-music-demo.mp4` —— 63 秒功能介绍演示（真实驱动插件与 App）：

> 默认宠物形态（歌词气泡）→ 点击展开播放器 → 搜索 → 双击播放 → 换歌 →
> 切换播放模式 → 收藏 → 加入播放列表 → 收起宠物看新歌歌词。

## 手动查看 / 分享

- 直接播放 `dsh-alger-music-demo.mp4`（H.264，微信/邮件可直接发）。
- 视频无音轨（headless 录制不采集系统音频，实际播放有声音）。
- 已裁掉前 20s、叠加文字水印（底部插件名 + GitHub 地址，中间偏下"作者：@东方"），
  文字图层由 `overlay.html` 生成（`overlay.png` 用 playwright 截图，`omitBackground` 透明背景）。

## 重新录制

```bash
cd demo
# 1) 让 playwright 找到系统 ffmpeg（软链一次即可，pw-cache 已被 gitignore）
mkdir -p pw-cache/ffmpeg-1011
ln -sf "$(command -v ffmpeg)" pw-cache/ffmpeg-1011/ffmpeg-mac

# 2) 录制（需要本机 dsh web 运行中、插件就绪、App 在线）
PLAYWRIGHT_BROWSERS_PATH="$PWD/pw-cache" node record-demo.mjs

# 3) 合成 mp4（裁切到浮窗区域 + 放大 + 淡入淡出）
V=$(ls -t video/*.webm | head -1)
ffmpeg -y -ss 13 -i "$V" -vf "crop=440:580:860:160,scale=880:1160:flags=lanczos,fade=t=in:st=0:d=0.6,fade=t=out:st=61.5:d=0.8" \
  -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart dsh-alger-music-demo.mp4
```

说明：
- `record-demo.mjs` 里的 `createRequire` 基路径是本机 DSH 安装路径，换机器需调整；
- 录制时音乐会真实播放（扬声器出声，但不进视频）。
