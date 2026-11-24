# dsh-go-files

dsh-go 手机 App 里的「工作区」原生面板：在侧栏「插件」页签里逛主机的工区，看文本 / 图片 / 视频预览，把手机里的文件传进工作区，还能移动和删除。

- **在哪看**：对话详情页 → 插件页签（`session.tab`），也出现在「全部功能」和聊天页的「插件」弹层。
- **浏览**：文件夹在前；图片按两列缩略图卡片排（点卡片进详情，再点图全屏缩放、保存），视频给封面 + 无声小动图，其他文件点开看预览。
- **上传**：系统选择器选文件 → 落到工作区 `artifacts/uploads/<日期>/`（父目录不存在会自动建），同名自动加序号不覆盖。单个 ≤ 8 MiB，一次最多 4 个、合计 ≤ 16 MiB。
- **移动**：文件详情页「移动到…」→ 选目标文件夹 → 移动；不覆盖同名文件。
- **删除**：文件详情页「删除」要确认；空文件夹在它自己的页面能删；非空文件夹不允许删；符号链接和工作区外的路径一律不碰。
- **边界**：所有文件操作都限制在工作区根目录内，`../`、绝对路径、指向外面的符号链接都会被拒。

## 安装

```sh
dsh plugin --profile web add dsh-go-files
# 或指定版本：dsh plugin --profile web add dsh-go-files@0.2.8
```

卸载：

```sh
dsh plugin --profile web remove dsh-go-files
```

## 工作区根目录

默认取 DSH 工作区注册表里的第一个工作区（本机就是 `/opt/miao/dev/workspace`），取不到才退回引擎当前目录；可用环境变量 `DSH_WORKSPACE_ROOT` 强制指定。

## 预览缓存

图片 / 视频预览会转存到插件自己的 `assets/preview/`（App 的 `asset:` 只能引用这里），最多留 64 个、7 天自动清理，不进 git。视频预览和超大图压缩需要主机有 `ffmpeg` / `ffprobe`，没有时退化成只显示文件信息；超过 1080p 的视频只给封面，避免拖过面板 3 秒窗口。

## 开发

```sh
npm test
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" . --load   # 需要本机装 dsh-go-plugin 技能
```

改了 `lib/` 里的代码，要在 App 的「引擎」页重启引擎才生效；只改 `package.json` 里的清单会自动重读。

## 发布

```sh
node scripts/release.mjs 0.2.7
```

推 `main` + `v*` tag 后由 GitHub Actions 跑测试并 `npm publish --provenance`、建 Release。市场条目见 `docs/market-entry.json`。

MIT License.
