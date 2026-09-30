# Pi Web 壁纸

给 [Pi Web](https://www.npmjs.com/package/@agegr/pi-web) 加自定义壁纸的用户脚本（ScriptCat / Tampermonkey / Violentmonkey）。

[项目主页](https://github.com/IA20201/pi-web-wallpaper) · [反馈问题](https://github.com/IA20201/pi-web-wallpaper/issues) · [更新记录](./CHANGELOG.md)

在「设置 → 常规」里注入一个**和原生外观完全一致**的「壁纸」小节，不需要 fork 或修改 pi-web 本体。

> 针对 **pi-web 0.9.3** 实测开发。它靠的是 pi-web 的 CSS 变量契约（`--bg` / `--bg-panel` 等），
> 官方若改掉这套变量名，脚本会失效 —— 详见下面的「原理」。

---

## 特性

| 功能 | 说明 |
| --- | --- |
| **本机图片** | 从本地选图，存进浏览器 IndexedDB。**不会上传到任何地方** |
| **壁纸透明度** | 0–100%，只影响壁纸图片本身 |
| **面板透明度** | 0–100%，控制侧栏 / 顶栏 / 右栏 / 设置弹窗的不透明度 |
| **壁纸模糊** | 0–30 px，只作用于壁纸图片（边缘做了负 `inset` 补偿，不发虚） |
| **面板磨砂** | 0–30 px，`backdrop-filter` 毛玻璃（限侧栏与右栏，见限制） |
| **填充方式** | 覆盖 / 包含 / 原尺寸 |
| **图片位置** | 九宫格选点 |
| **导出 / 导入** | 设置和图片打包成一个 JSON，用于换地址、换机器时搬运 |
| **恢复默认** | 完整撤销所有覆盖，回到 pi-web 原样 |

聊天区始终能透出壁纸；**消息气泡保持不透明**，保证文字可读性。

---

## 安装

脚本是可直接运行的 `.user.js`，**不需要 npm、编译或下载整个仓库**。GitHub 显示源码是正常的；安装时用 **Raw 原始文件地址**。

1. 安装浏览器扩展：[脚本猫 ScriptCat](https://scriptcat.org/) / [Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开下面的链接，在管理器弹出的页面确认安装：

   **[安装 / 升级 Pi Web 壁纸](https://raw.githubusercontent.com/IA20201/pi-web-wallpaper/main/pi-web-wallpaper.user.js)**

   ```text
   https://raw.githubusercontent.com/IA20201/pi-web-wallpaper/main/pi-web-wallpaper.user.js
   ```

   如果浏览器只显示代码或下载文件：到脚本管理器使用「从 URL 安装」（名称因管理器而异），粘贴上述地址；也可以新建脚本、粘贴整个文件内容后保存。
3. 刷新 Pi Web → **设置 → 常规** → 滚到底 → 看到「壁纸」小节。

> 浏览器必须允许扩展在 Pi Web 地址上运行。手机需要支持该扩展的浏览器；普通手机 Chrome 不能直接安装桌面扩展。

### 地址变化与运行范围

从 **1.0.2** 起，默认匹配：

```javascript
// @match        http://*:30141/*
// @match        https://*:30141/*
```

- 覆盖 localhost、IPv4 / IPv6、主机名及任意 DHCP 地址；换 Wi-Fi / 热点无需改脚本。
- 部分管理器可能忽略匹配规则中的端口。脚本还会在运行时检查 HTTP/HTTPS 协议与 **30141** 端口；其他端口立即退出，不读取存储、不挂观察器。
- 在符合端口的页面上，等待 `#session-sidebar` 或 `.chat-content` 出现后才注入样式；同端口的无关页面不会被修改，但会保留等待 Pi Web 的引导观察器与轮询。
- **匹配变宽不等于搬迁存储。** 地址变化后，图片和设置仍按 origin 隔离；需要「导出 / 导入」搬运。
- 默认不匹配 HTTPS 反向代理的 443 端口，也不会给 Pi Web 提供 HTTPS 或网络访问能力。

**自定义端口：** 同时改头部的两条 `@match` 和代码里的 `PI_WEB_PORT`。例如使用 3000，把三处的 `30141` 改成 `3000`。仅添加域名匹配而不修改运行时端口检查是不够的。

如果只想允许自己的地址，可以在管理器中配置自定义匹配 / 排除规则（具体功能因管理器而异）。避免直接修改发布脚本：自动更新可能覆盖手动改动。

> `192.168.*.*` 不是合法的 `@match` 主机模式；主机部分使用 `*`、`*.域名` 或完整主机名。

### 自动更新与旧版升级

脚本的 `@updateURL` 和 `@downloadURL` 均指向上面的 GitHub Raw 地址。管理器启用定期检查更新后，会比较 `@version`；也可在管理器里手动「检查更新」。

- **已装 1.0.1：** 旧版缺少明确的更新地址，建议从安装链接手动升级一次到 1.0.2。升级时确认替换现有脚本；如管理器创建了副本，禁用 / 删除旧副本，只保留一份。
- 保留旧版的 `@name` 和 `@namespace`（其中的 `local` 是兼容标识），避免改名导致管理器把它当成新脚本。主页、反馈地址和作者信息已指向本仓库。
- 如果更新后管理器提示新增网站权限，需要确认授权并刷新 Pi Web。
- 更新脚本本身不清空同一 origin 下的壁纸及设置。重要图片仍建议先导出备份。
- GitHub Raw 需要可访问；打不开时检查网络 / 代理。推送后有缓存，更新不一定立即可见。

### 发布到 ScriptCat 脚本站 / Greasy Fork

可注册登录脚本托管网站，创建脚本并提交 **整个 `pi-web-wallpaper.user.js` 内容**，填写说明与 MIT 许可。不上传仓库 ZIP，也不需要构建。

**选择一种更新来源：**

- **GitHub 分发：** 保留仓库里的 `@updateURL` / `@downloadURL`，使用本 README 的安装链接。
- **网站托管：** 在提交给网站的副本中移除这两行，遵循网站的发布要求，让管理器通过网站提供的安装 / 更新地址更新。不要覆盖仓库里的 GitHub 地址，也不要同时维护两个不同版本的更新入口。

发布新版本要提高 `@version`，同时同步代码内的 `VERSION`；仅改代码而不提高版本，管理器通常不会自动升级。

### 装完没反应？

先确认脚本已启用、扩展有当前站点权限，以及页面使用的是 30141 端口。然后在 Pi Web 页面的 Console 里执行：

```javascript
window.__piWallpaper && window.__piWallpaper.status()
```

- 返回 `undefined` → 脚本没有运行（检查安装、匹配、扩展权限、运行时端口限制）。
- `started: false` → 已运行，但还没识别到 Pi Web 的 DOM（登录页 / 水合未完成）。
- `started: true, section: false` → 已识别 Pi Web，但设置面板未打开，或设置 DOM 结构已变化。

正常启动时控制台会有 `[pi-wallpaper] v1.0.2 启动中…` 和 `[pi-wallpaper] 就绪。` 两行日志。

---

## 纯 CSS 兜底版

[`pi-web-wallpaper.user.css`](./pi-web-wallpaper.user.css) 是给 **Stylus** 用的纯 CSS 版本：
没有图形界面，只铺壁纸 + `body` 透明，图片要自己放到 `public/` 目录里。

适合不想装用户脚本、或者只要「一张图铺满」这种最简需求的场景。

---

## 原理

这部分是给后续维护者看的。**下面每条都是在真实页面上实测出来的，不是读构建产物猜的。**

### 1. 为什么壁纸层必须把 `body` 和 app 根容器变透明

pi-web 有**三个**铺满全屏、背景均为 `var(--bg)` 的不透明层：

| 元素 | 备注 |
| --- | --- |
| `html.__variable_*` | Next.js 字体变量类 |
| `body.notranslate` | |
| **app 根容器** | **无类名无 id**，`style="display:flex;width:100%;height:var(--app-viewport-height,100dvh)"` |

壁纸层用 `position:fixed; z-index:-1`（负 z-index 的元素绘制在 in-flow 块级背景**之前**），
所以只把壁纸层塞进去是不够的 —— `body` 和 app 根容器都必须变成透明，否则它们会盖住壁纸。

app 根容器没有类名，无法用 CSS 选中，脚本用语义定位：**body 的子元素里，包含 `#session-sidebar`
或 `.chat-content` 的那个**，然后打上 `pi-wp-app-root` 标记。

### 2. 为什么「面板半透明」是改写变量而不是选元素

主列的顶栏（1105×36）**完全没有类名**，选不到；但它的背景是 `var(--bg-panel)`。

所以脚本的做法是：**读取当前主题下 `--bg` / `--bg-panel` 的计算值，解析成 RGB，
改写为带 alpha 的版本，写回 `<html>` 的内联样式。** 所有引用这两个变量的元素
（包括那个无类名的顶栏）会一并变半透明，而且自动适配全部 5 套主题，不用硬编码调色板。

这也正是 pi-web 自己的做法 —— 它把用户设置写成 `<html>` 的内联 style
（例如 `--chat-content-max-width: 820px`）。

### 3. 为什么切换主题要「先摘掉自己的覆盖」

内联覆盖的优先级高于样式表。如果不处理，切换主题后 `--bg` 仍然停留在旧主题的 alpha 版本。

所以读值走的是一个「穿透」过程：**暂时 `removeProperty` 掉自己的覆盖 → 读 cascade 值 → 再写回**。
主题观察器只监听 `data-theme`（真正的主题切换信号），**不监听 `class`** —— 因为脚本自己就会改
`class`，监听它会自我触发。

### 4. 为什么需要 MutationObserver

设置弹窗由 React 挂载/卸载，注入的小节会被重渲染冲掉。脚本用**幂等 + 节流（200ms）**的
观察器兜住：小节还在就什么都不做，被冲掉了才重建。

### 5. 为什么启动要等

Next.js 的水合可能**晚于 `document-idle`**。脚本刚开始的版本在这里早退过一次 ——
结果就是「pi-web 还没水合 → 直接 return → 后面的观察器根本没建立 → 永远不启动」。
现在的写法是先挂引导观察器 + 400ms 轮询，等 `#session-sidebar` 或 `.chat-content` 出现才真正初始化，
并且**初始化时立刻注入一次**（设置面板可能已经开着，不能只等 DOM 变化）。

---

## 已知限制

- **面板磨砂只作用于侧栏和右栏。** 主列顶栏没有类名，`backdrop-filter` 无法选中它。
- **存储按 origin 隔离。** `192.168.2.103:30141`、`localhost:30141`、某个主机名是**三套独立的
  localStorage / IndexedDB**。换地址或换端口后，图片和设置不会自己跟过去 —— 用「导出设置」搬运。
- **浏览器存储被清空就会丢。** 图片存在 IndexedDB 里，清站点数据就没了。重要的话定期导出。
- **依赖 pi-web 的 CSS 变量契约。** 官方若改名 `--bg` / `--bg-panel`，面板透明度会失效
  （壁纸本身仍然有效，因为它只依赖 `body` 透明 + 负 z-index）。
- **只在 pi-web 0.9.3 上验证过。** 更新 pi-web 后建议重跑一遍 Console 里的 `__piWallpaper.status()`。
- **图片大小上限 16 MB。** 再大就提示拒绝，避免 IndexedDB 写入过慢。
- iOS 上 Safari 用户脚本需用 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)；
  Stylus 版本同理。

---

## 文件

```
pi-web-wallpaper.user.js    用户脚本本体（Tampermonkey）
pi-web-wallpaper.user.css   Stylus 用的纯 CSS 兜底版
```

---

## 开发与发布检查

使用 Node.js 22 或更新版本；测试不需要安装依赖，也不需要 npm 构建：

```bash
node --check pi-web-wallpaper.user.js
node --test tests/userscript.test.cjs
```

测试覆盖发布元信息与文档一致性、非目标端口提前退出、多个主机 / IP、延迟水合及重复注入。DOM 使用轻量模拟，**不代替实际管理器的安装 / 自动更新验证**。

发布前先在真实 Pi Web 上检查「设置 → 常规 → 壁纸」及 `__piWallpaper.status()`；提高头部 `@version` 和内部 `VERSION`，更新 [CHANGELOG.md](./CHANGELOG.md)，运行测试后再推送。GitHub Raw 主分支地址就是更新入口，GitHub Release 不是自动更新的必要条件。

---


## 许可

[MIT](./LICENSE)
