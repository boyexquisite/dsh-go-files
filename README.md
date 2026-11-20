# dsh-go-workspace

dsh-go 手机 App 里的「工作区」原生面板：在侧栏「插件」页签里浏览主机的工区，看文本文件预览，把手机里的文件传到工作区。

- **在哪看**：对话详情页 → 插件页签（`session.tab`），也出现在「全部功能」和聊天页的「插件」弹层。
- **浏览**：目录列表，文件夹在前；点文件夹进去，点文件看预览（文本；二进制和超大文件只显示信息）。
- **上传**：面板里的「上传文件」会打开手机系统选择器，选中的文件经桥接传到主机，落在工作区 `uploads/<日期>/`，同名自动加序号、不覆盖。单个 ≤ 8 MiB，一次最多 4 个、合计 ≤ 16 MiB。
- **安全边界**：只读/写工作区根目录以内；`../`、绝对路径、指向外面的符号链接都会被拒。
- **App 要求**：上传需要 App 协商 `files` 能力（原生插件协议 v1.3，较新的 App）。App 不支持时面板照常浏览，只把上传按钮换成一行提示。

## 工作区根目录

默认是引擎进程的当前目录（本机就是 `/opt/miao-workspace`），可用环境变量 `DSH_WORKSPACE_ROOT` 覆盖。

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
