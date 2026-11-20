# dsh-go-workspace

dsh-go 手机 App 里的「工作区」原生面板：在侧栏「插件」页签里浏览主机的工区，看文本文件预览，把手机里的文件传到工作区。

- **在哪看**：对话详情页 → 插件页签（`session.tab`），也出现在「全部功能」和聊天页的「插件」弹层。
- **浏览**：目录列表，文件夹在前；点文件夹进去，点文件看预览。
- **文本**：代码块预览，最多 6000 字。
- **图片**：图集缩略图（同目录的图排一起），点图进 App 看图页，可全屏、左右滑、缩放、保存、分享；超限的图自动压缩。
- **视频**：显示封面 + 前 3 秒无声小动图；App 原生面板还不能播原片，视图里会写明。视频预览和超大图压缩需要主机有 `ffmpeg`/`ffprobe`，没有时退化成只显示文件信息；超过 1080p 的视频只给封面（解码太慢会拖过面板的 3 秒窗口）。
- **上传**：面板里的「上传文件」会打开手机系统选择器，选中的文件经桥接传到主机，落在工作区 `uploads/<日期>/`，同名自动加序号、不覆盖。单个 ≤ 8 MiB，一次最多 4 个、合计 ≤ 16 MiB。
- **安全边界**：只读/写工作区根目录以内；`../`、绝对路径、指向外面的符号链接都会被拒。
- **App 要求**：上传需要 App 协商 `files` 能力（原生插件协议 v1.3，较新的 App）。App 不支持时面板照常浏览，只把上传按钮换成一行提示。

## 预览缓存

图片 / 视频的预览把文件转存到插件自己的 `assets/preview/`（App 的 `asset:` 只能引用这里），最多留 64 个、7 天自动清理，已进 `.gitignore`。

## 工作区根目录

默认取 DSH 工作区注册表里的第一个工作区（本机就是 `/opt/miao-workspace`），取不到才退回引擎当前目录；可用环境变量 `DSH_WORKSPACE_ROOT` 强制指定。

## 安装

```sh
dsh plugin --profile web add /opt/miao-workspace/plugins/dsh-go-workspace
```

卸载：

```sh
dsh plugin --profile web remove dsh-go-workspace
```

## 开发

```sh
node --test test/*.test.js
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" . --load
```

改了 `lib/` 里的代码，要在 App 的「引擎」页重启引擎才生效；只改 `package.json` 里的清单会自动重读。
