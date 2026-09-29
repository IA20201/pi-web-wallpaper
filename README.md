# Pi Web 壁纸

给 [Pi Web](https://www.npmjs.com/package/@agegr/pi-web) 加自定义壁纸的用户脚本（Tampermonkey / Violentmonkey）。

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

1. 装浏览器扩展：[Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）
2. 打开 [`pi-web-wallpaper.user.js`](./pi-web-wallpaper.user.js)，点 **Raw** —— Tampermonkey 会弹出安装页

   或者手动：Tampermonkey 管理面板 → `+` 新建 → 把文件内容整个粘进去 → `Ctrl+S`

3. 打开 Pi Web → **设置 → 常规** → 滚到底 → 看到「壁纸」小节

### ⚠️ 如果你的 Pi Web 地址不在 `@match` 里

脚本默认只匹配这三条：

```
http://localhost:30141/*
http://127.0.0.1:30141/*
http://192.168.2.103:30141/*
```

**如果你的地址不是这三个，脚本会完全不起作用，而且不会有任何报错。** 请编辑脚本头部，按自己的地址加一行 `@match`，**必须写具体主机**：

```javascript
// @match        http://192.168.2.55:30141/*     ← 对
// @match        http://*:30141/*                ← 能用，但范围大
// @match        http://192.168.*.*:30141/*      ← 非法！会导致脚本不注入，且无报错
```

> 这个坑真踩过：Chrome 的 match pattern 主机部分只支持 `*`、`*.域名`、或完整主机名，
> **中间带通配是非法的**，整条规则会被静默丢弃。

改完 `@match` 后要**刷新页面**，必要时重启浏览器。

### 装完没反应？

在 Pi Web 页面的 Console 里执行：

```javascript
__piWallpaper.status()
```

它会直接告诉你脚本注入没注入、pi-web 水合完没、壁纸小节注入没：

- `started: false` → 脚本没跑起来（多半是 `@match` 没匹配上）
- `started: true, section: false` → 注入了但设置面板还没打开，或有异常

正常启动时控制台会有 `[pi-wallpaper] v1.0.1 启动中…` 和 `[pi-wallpaper] 就绪。` 两行日志。

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

## 许可

[MIT](./LICENSE)
