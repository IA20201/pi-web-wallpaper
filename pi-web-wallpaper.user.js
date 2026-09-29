// ==UserScript==
// @name         Pi Web 壁纸
// @namespace    https://github.com/local/pi-web-wallpaper
// @version      1.0.1
// @description  给 Pi Web 加自定义壁纸：在「设置 → 常规」里注入一个原生外观的「壁纸」小节，支持本机图片、壁纸透明度、面板透明度、壁纸模糊、面板磨砂、填充方式与九宫格定位。图片存在 IndexedDB，设置存在 localStorage，支持导出/导入。
// @author       local
// @match        http://localhost:30141/*
// @match        http://127.0.0.1:30141/*
// @match        http://192.168.2.103:30141/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 如果你的 Pi Web 地址不是上面这三条之一，请自己加一行 @match，并且**必须写具体的
 * 主机**（例如 http://192.168.2.55:30141/*）。注意 `192.168.*.*` 这种写法在 match
 * 规则里是**非法的**，会导致脚本完全不被注入（这个坑真踩过一次）。
 *
 * ---------------------------------------------------------------------------
 * 设计要点（对着 pi-web 0.9.3 的真实 DOM 实测出来的，别凭印象改）：
 *
 * 1) 全屏不透明层有 3 个：html、body.notranslate、以及 app 根容器（无类名无 id）。
 *    壁纸层用 position:fixed; z-index:-1，所以必须干掉后两层的不透明底色，
 *    否则按绘制顺序它们会盖在壁纸层上面。
 *
 * 2) 「面板半透明」不去逐个选元素，而是改写 --bg / --bg-panel 变量本身。
 *    原因：主列顶栏无类名、选不到，而它用的是 var(--bg-panel)。改变量能一并覆盖，
 *    还能自动适配各套主题。这也正是 pi-web 自己的做法（它把用户设置写成 html 内联 style）。
 *
 * 3) 内联覆盖会盖住主题值，所以切换主题时要「先摘掉自己的覆盖 → 读 cascade 值 → 再写回」。
 *
 * 4) 注入的小节会被 React 重渲染冲掉，用幂等的 MutationObserver 兜住。
 *
 * 5) 启动**不能**依赖「脚本跑的时候 pi-web 已经水合完」—— Next.js 水合可能晚于
 *    document-idle。所以这里先挂观察器/轮询，等 #session-sidebar 或 .chat-content
 *    出现才真正初始化。早退一次就再也不会启动了（这个坑也真踩过一次）。
 * ---------------------------------------------------------------------------
 */

(function () {
  'use strict';

  var VERSION = '1.0.1';
  var BOOT_FLAG = '__piWallpaperBooted';

  /* 单实例保护：油猴重复注入 / 手动粘贴时不要跑两遍 */
  if (window[BOOT_FLAG]) {
    console.warn('[pi-wallpaper] 已经启动过了，本次注入被忽略。');
    return;
  }
  window[BOOT_FLAG] = true;

  /* ================= 1. 常量与默认值 ================= */

  var LS_KEY = 'pi-wallpaper:settings:v1';
  var LAYER_ID = 'pi-wp-layer';
  var STYLE_ID = 'pi-wp-style';
  var SECTION_ID = 'pi-wp-section';
  var ROOT_CLASS = 'pi-wp-app-root';

  var DB_NAME = 'pi-wallpaper';
  var DB_STORE = 'assets';
  var DB_KEY = 'image';
  var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

  var DEFAULTS = {
    enabled: true,
    wallpaperOpacity: 100,
    panelAlpha: 82,
    wallpaperBlur: 0,
    panelBlur: 0,
    fit: 'cover',
    position: 'center center'
  };

  var POSITIONS = [
    ['left top', '左上'], ['center top', '上'], ['right top', '右上'],
    ['left center', '左'], ['center center', '中'], ['right center', '右'],
    ['left bottom', '左下'], ['center bottom', '下'], ['right bottom', '右下']
  ];

  var state = loadSettings();
  var objectUrl = null;
  var hasImage = false;
  var started = false;
  var ui = {};

  /* ================= 2. 小工具 ================= */

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function log() {
    var a = ['[pi-wallpaper]'].concat([].slice.call(arguments));
    console.log.apply(console, a);
  }

  function loadSettings() {
    var s = {};
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        for (var k in DEFAULTS) {
          if (Object.prototype.hasOwnProperty.call(parsed, k)) s[k] = parsed[k];
        }
      }
    } catch (e) { /* 存储坏了用默认值 */ }
    for (var k2 in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(s, k2)) s[k2] = DEFAULTS[k2];
    }
    return s;
  }

  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }

  var probeEl = null;
  function toRGB(value) {
    if (!value) return null;
    if (!probeEl) {
      probeEl = document.createElement('span');
      probeEl.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0';
      (document.body || document.documentElement).appendChild(probeEl);
    }
    probeEl.style.color = '';
    probeEl.style.color = value;
    var c = getComputedStyle(probeEl).color;
    var m = c && c.match(/(\d+(?:\.\d+)?)/g);
    if (!m || m.length < 3) return null;
    return { r: Math.round(+m[0]), g: Math.round(+m[1]), b: Math.round(+m[2]) };
  }

  function rgba(rgb, alpha) {
    return 'rgb(' + rgb.r + ' ' + rgb.g + ' ' + rgb.b + ' / ' + alpha + ')';
  }

  /* ================= 3. IndexedDB ================= */

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('此浏览器不支持 IndexedDB'));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
    });
  }

  function idb(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, mode);
        var out;
        try { out = fn(tx.objectStore(DB_STORE)); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
        tx.onerror = function () { reject(tx.error || new Error('IndexedDB 事务失败')); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务被中止')); };
      });
    });
  }

  var imageApi = {
    get: function () { return idb('readonly', function (s) { return s.get(DB_KEY); }); },
    put: function (blob) { return idb('readwrite', function (s) { return s.put(blob, DB_KEY); }); },
    del: function () { return idb('readwrite', function (s) { return s.delete(DB_KEY); }); }
  };

  /* ================= 4. 样式 ================= */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '#' + LAYER_ID + '{',
      '  position:fixed;',
      '  inset:calc(-2.5 * var(--pi-wp-blur,0px));',
      '  z-index:-1;',
      '  pointer-events:none;',
      '  background-image:var(--pi-wp-image,none);',
      '  background-size:var(--pi-wp-size,cover);',
      '  background-position:var(--pi-wp-position,center center);',
      '  background-repeat:no-repeat;',
      '  opacity:var(--pi-wp-opacity,1);',
      '  filter:blur(var(--pi-wp-blur,0px));',
      '}',
      /* 必须干掉这两层不透明底色，否则壁纸被盖住 */
      'html.pi-wp-on body,',
      'html.pi-wp-on .' + ROOT_CLASS + '{background-color:transparent !important;}',
      /* 磨砂只作用于有 id 的两个栏（顶栏无类名，backdrop-filter 选不到） */
      'html.pi-wp-panelblur #session-sidebar,',
      'html.pi-wp-panelblur #file-panel{',
      '  backdrop-filter:blur(var(--pi-wp-panel-blur,0px));',
      '  -webkit-backdrop-filter:blur(var(--pi-wp-panel-blur,0px));',
      '}',
      '#' + SECTION_ID + ' .pi-wp-preview{',
      '  width:100%;max-width:320px;height:96px;border:1px solid var(--border);border-radius:8px;',
      '  background-color:var(--bg-hover);background-size:cover;background-position:center;',
      '  display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:12px;',
      '}',
      '#' + SECTION_ID + ' .pi-wp-grid{display:grid;grid-template-columns:repeat(3,30px);gap:4px;}',
      '#' + SECTION_ID + ' .pi-wp-cell{',
      '  width:30px;height:24px;border:1px solid var(--border);border-radius:4px;',
      '  background-color:var(--bg-panel);cursor:pointer;padding:0;',
      '}',
      '#' + SECTION_ID + ' .pi-wp-cell[aria-pressed="true"]{border-color:var(--accent);background-color:var(--bg-selected);}',
      '#' + SECTION_ID + ' .pi-wp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '#' + SECTION_ID + ' .pi-wp-note{color:var(--text-dim);font-size:12px;margin:6px 0 0;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ================= 5. 应用设置 ================= */

  var html = document.documentElement;
  var PANEL_VARS = ['--bg', '--bg-panel'];

  /* 当前是否应该真正生效：开关开 + 确实有图。没图时保持原样，别乱改页面。 */
  function effectiveOn() {
    return !!(state.enabled && hasImage && objectUrl);
  }

  /* 读变量的「原始 cascade 值」：先摘掉自己的内联覆盖，读完再放回 */
  function readCascadeVar(name) {
    var mine = html.style.getPropertyValue(name);
    if (mine) html.style.removeProperty(name);
    var v = getComputedStyle(html).getPropertyValue(name).trim();
    if (mine) html.style.setProperty(name, mine);
    return v;
  }

  function setVar(name, value) {
    if (value === null || value === undefined) html.style.removeProperty(name);
    else html.style.setProperty(name, value);
  }

  function applyPanelAlpha() {
    var a = clamp(state.panelAlpha, 0, 100);
    if (!effectiveOn() || a >= 100) {
      for (var i = 0; i < PANEL_VARS.length; i++) setVar(PANEL_VARS[i], null);
      return;
    }
    for (var j = 0; j < PANEL_VARS.length; j++) {
      var name = PANEL_VARS[j];
      var rgb = toRGB(readCascadeVar(name));
      if (rgb) setVar(name, rgba(rgb, a / 100));
      else setVar(name, null);
    }
  }

  /* app 根容器无类名，用语义找：里面一定有侧栏或聊天区 */
  function markAppRoot() {
    if (!document.body) return;
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var e = kids[i];
      if (e.tagName !== 'DIV' || e.hidden) continue;
      if (e.querySelector('#session-sidebar') || e.querySelector('.chat-content')) {
        if (!e.classList.contains(ROOT_CLASS)) e.classList.add(ROOT_CLASS);
        return;
      }
    }
  }

  function removeLayer() {
    var lay = document.getElementById(LAYER_ID);
    if (lay && lay.parentNode) lay.parentNode.removeChild(lay);
  }

  function ensureLayer() {
    var el = document.getElementById(LAYER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = LAYER_ID;
      el.setAttribute('aria-hidden', 'true');
      (document.body || html).appendChild(el);
    }
    return el;
  }

  function apply() {
    ensureStyle();
    markAppRoot();

    var on = effectiveOn();
    html.classList.toggle('pi-wp-on', on);
    html.classList.toggle('pi-wp-panelblur', on && clamp(state.panelBlur, 0, 30) > 0);

    setVar('--pi-wp-opacity', String(clamp(state.wallpaperOpacity, 0, 100) / 100));
    setVar('--pi-wp-blur', clamp(state.wallpaperBlur, 0, 30) + 'px');
    setVar('--pi-wp-panel-blur', clamp(state.panelBlur, 0, 30) + 'px');
    setVar('--pi-wp-size', state.fit === 'auto' ? 'auto' : (state.fit === 'contain' ? 'contain' : 'cover'));
    setVar('--pi-wp-position', state.position || 'center center');
    setVar('--pi-wp-image', objectUrl ? 'url("' + objectUrl + '")' : null);

    if (on) ensureLayer(); else removeLayer();

    applyPanelAlpha();
  }

  function loadImage() {
    return imageApi.get().then(function (blob) {
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      if (blob) { objectUrl = URL.createObjectURL(blob); hasImage = true; }
      else { hasImage = false; }
      log('图片已就绪:', hasImage ? '有' : '无');
      apply();
      refreshUI();
    }).catch(function (err) {
      console.warn('[pi-wallpaper] 读图片失败：', err);
      hasImage = false;
      apply();
      refreshUI();
    });
  }

  function setImage(blob) {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    objectUrl = URL.createObjectURL(blob);
    hasImage = true;
    apply();
    refreshUI();
    return imageApi.put(blob).catch(function (err) {
      console.warn('[pi-wallpaper] 存图片失败：', err);
      alert('壁纸已应用，但保存到 IndexedDB 失败，刷新后会丢：' + (err && err.message ? err.message : err));
    });
  }

  function clearImage() {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    hasImage = false;
    apply();
    refreshUI();
    return imageApi.del().catch(function (err) { console.warn('[pi-wallpaper] 删除图片失败：', err); });
  }

  /* ================= 6. 设置界面 ================= */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var RESET_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5"></path></svg>';

  function makeRange(opts) {
    var wrap = el('div', 'settings-chat-option settings-chat-range-option');
    var head = el('div', 'settings-chat-range-header');
    var label = el('label', null, opts.label);
    label.setAttribute('for', opts.id);
    var output = el('output', null, '');
    output.setAttribute('for', opts.id);
    var reset = el('button', 'config-button config-button-ghost config-button-small settings-chat-reset');
    reset.type = 'button';
    reset.title = '重置' + opts.label;
    reset.setAttribute('aria-label', '重置' + opts.label);
    reset.innerHTML = RESET_ICON;
    head.appendChild(label);
    head.appendChild(output);
    head.appendChild(reset);

    var input = document.createElement('input');
    input.id = opts.id;
    input.type = 'range';
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step || 1);
    input.value = String(opts.get());

    function render() {
      output.textContent = opts.format(opts.get());
      input.value = String(opts.get());
      reset.disabled = opts.get() === opts.def;
    }
    input.addEventListener('input', function () {
      opts.set(clamp(parseInt(input.value, 10) || 0, opts.min, opts.max));
      render();
    });
    reset.addEventListener('click', function () { opts.set(opts.def); render(); });

    wrap.appendChild(head);
    wrap.appendChild(input);
    ui[opts.id] = { render: render };
    render();
    return wrap;
  }

  function makeSwitch(key, labelText, get, set) {
    var wrap = el('div', 'settings-chat-option settings-chat-switch-option');
    wrap.appendChild(el('span', null, labelText));
    var btn = el('button', 'config-switch');
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-label', labelText);
    btn.title = labelText;
    var knob = el('span', 'config-switch-knob');
    knob.setAttribute('aria-hidden', 'true');
    btn.appendChild(knob);

    function render() { btn.setAttribute('aria-checked', String(!!get())); }
    btn.addEventListener('click', function () { set(!get()); render(); });
    wrap.appendChild(btn);
    ui[key] = { render: render };
    render();
    return wrap;
  }

  function buildSection() {
    ui = {};
    var sec = el('section', 'settings-general-section');
    sec.id = SECTION_ID;
    sec.appendChild(el('h3', 'settings-general-heading', '壁纸'));
    var opts = el('div', 'settings-chat-options');

    opts.appendChild(makeSwitch('pi-wp-enabled', '启用壁纸',
      function () { return state.enabled; },
      function (v) { state.enabled = v; saveSettings(); apply(); refreshUI(); }));

    var previewBox = el('div', 'settings-chat-option');
    var preview = el('div', 'pi-wp-preview', '尚未选择图片');
    previewBox.appendChild(preview);
    opts.appendChild(previewBox);
    ui.preview = preview;

    var fileRow = el('div', 'settings-chat-option pi-wp-row');
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    var pickBtn = el('button', 'config-button config-button-secondary config-button-small', '选择本地图片');
    pickBtn.type = 'button';
    var clearBtn = el('button', 'config-button config-button-ghost config-button-small', '清除壁纸');
    clearBtn.type = 'button';
    pickBtn.addEventListener('click', function () { fileInput.click(); });
    clearBtn.addEventListener('click', function () { clearImage(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { alert('请选择图片文件。'); return; }
      if (f.size > MAX_IMAGE_BYTES) {
        alert('图片太大（' + (f.size / 1048576).toFixed(1) + ' MB），请选小于 16 MB 的。');
        return;
      }
      setImage(f);
    });
    fileRow.appendChild(pickBtn);
    fileRow.appendChild(clearBtn);
    fileRow.appendChild(fileInput);
    opts.appendChild(fileRow);
    ui.clearBtn = clearBtn;

    opts.appendChild(makeRange({
      id: 'pi-wp-opacity', label: '壁纸透明度', min: 0, max: 100, step: 1, def: DEFAULTS.wallpaperOpacity,
      get: function () { return state.wallpaperOpacity; },
      set: function (v) { state.wallpaperOpacity = v; saveSettings(); apply(); },
      format: function (v) { return v + '%'; }
    }));

    opts.appendChild(makeRange({
      id: 'pi-wp-panel', label: '面板透明度', min: 0, max: 100, step: 1, def: DEFAULTS.panelAlpha,
      get: function () { return state.panelAlpha; },
      set: function (v) { state.panelAlpha = v; saveSettings(); apply(); },
      format: function (v) { return v + '%'; }
    }));

    opts.appendChild(makeRange({
      id: 'pi-wp-blur', label: '壁纸模糊', min: 0, max: 30, step: 1, def: DEFAULTS.wallpaperBlur,
      get: function () { return state.wallpaperBlur; },
      set: function (v) { state.wallpaperBlur = v; saveSettings(); apply(); },
      format: function (v) { return v + 'px'; }
    }));

    opts.appendChild(makeRange({
      id: 'pi-wp-panelblur', label: '面板磨砂', min: 0, max: 30, step: 1, def: DEFAULTS.panelBlur,
      get: function () { return state.panelBlur; },
      set: function (v) { state.panelBlur = v; saveSettings(); apply(); },
      format: function (v) { return v + 'px'; }
    }));

    var fitRow = el('div', 'settings-chat-option pi-wp-row');
    fitRow.appendChild(el('span', null, '填充方式'));
    var fitSel = document.createElement('select');
    [['cover', '覆盖（裁切填满）'], ['contain', '包含（完整显示）'], ['auto', '原尺寸']].forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0];
      o.textContent = pair[1];
      fitSel.appendChild(o);
    });
    fitSel.value = state.fit;
    fitSel.addEventListener('change', function () { state.fit = fitSel.value; saveSettings(); apply(); });
    fitRow.appendChild(fitSel);
    opts.appendChild(fitRow);
    ui.fitSel = fitSel;

    var posRow = el('div', 'settings-chat-option pi-wp-row');
    posRow.appendChild(el('span', null, '图片位置'));
    var grid = el('div', 'pi-wp-grid');
    POSITIONS.forEach(function (pair) {
      var cell = el('button', 'pi-wp-cell');
      cell.type = 'button';
      cell.title = pair[1];
      cell.setAttribute('aria-label', '图片位置：' + pair[1]);
      cell.setAttribute('data-pos', pair[0]);
      cell.addEventListener('click', function () {
        state.position = pair[0];
        saveSettings();
        apply();
        refreshUI();
      });
      grid.appendChild(cell);
    });
    posRow.appendChild(grid);
    opts.appendChild(posRow);
    ui.grid = grid;

    var actionRow = el('div', 'settings-chat-option pi-wp-row');
    var exportBtn = el('button', 'config-button config-button-ghost config-button-small', '导出设置');
    var importBtn = el('button', 'config-button config-button-ghost config-button-small', '导入设置');
    var resetAllBtn = el('button', 'config-button config-button-ghost config-button-small', '恢复默认');
    exportBtn.type = importBtn.type = resetAllBtn.type = 'button';
    exportBtn.addEventListener('click', doExport);
    importBtn.addEventListener('click', doImport);
    resetAllBtn.addEventListener('click', function () {
      if (!confirm('恢复默认？会清除壁纸图片和所有壁纸设置。')) return;
      state = JSON.parse(JSON.stringify(DEFAULTS));
      saveSettings();
      clearImage().then(function () { apply(); refreshUI(); });
    });
    actionRow.appendChild(exportBtn);
    actionRow.appendChild(importBtn);
    actionRow.appendChild(resetAllBtn);
    opts.appendChild(actionRow);

    opts.appendChild(el('p', 'pi-wp-note',
      '「面板透明度」管的是侧栏、顶栏、右栏和设置弹窗；聊天区始终能透出壁纸，消息气泡保持不透明以保证可读。'
      + '图片存在本机浏览器（IndexedDB），不会上传；换地址/端口后存储是隔离的，请用「导出设置」搬运。'));

    sec.appendChild(opts);
    return sec;
  }

  function refreshUI() {
    if (ui.preview) {
      if (hasImage && objectUrl) {
        ui.preview.style.backgroundImage = 'url("' + objectUrl + '")';
        ui.preview.style.backgroundSize = state.fit === 'auto' ? 'auto' : (state.fit === 'contain' ? 'contain' : 'cover');
        ui.preview.style.backgroundPosition = state.position || 'center center';
        ui.preview.textContent = '';
      } else {
        ui.preview.style.backgroundImage = 'none';
        ui.preview.textContent = '尚未选择图片';
      }
    }
    if (ui.clearBtn) ui.clearBtn.disabled = !hasImage;
    if (ui.fitSel) ui.fitSel.value = state.fit;
    if (ui.grid) {
      [].forEach.call(ui.grid.children, function (cell) {
        cell.setAttribute('aria-pressed', String(cell.getAttribute('data-pos') === state.position));
      });
    }
    Object.keys(ui).forEach(function (k) {
      if (ui[k] && typeof ui[k].render === 'function') ui[k].render();
    });
  }

  /* ================= 7. 导出 / 导入 ================= */

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataURL) {
    var parts = String(dataURL).split(',');
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
    var bin = atob(parts[1]);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  function doExport() {
    imageApi.get().then(function (blob) {
      var payload = { version: 1, settings: state, image: null };
      if (!blob) return payload;
      return blobToDataURL(blob).then(function (d) { payload.image = { mime: blob.type, dataURL: d }; return payload; });
    }).then(function (payload) {
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pi-web-wallpaper.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }).catch(function (err) { alert('导出失败：' + (err && err.message ? err.message : err)); });
  }

  function doImport() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var data;
        try { data = JSON.parse(fr.result); } catch (e) { alert('这个文件不是有效的 JSON。'); return; }
        if (!data || !data.settings) { alert('文件里没有设置数据。'); return; }
        var next = JSON.parse(JSON.stringify(DEFAULTS));
        Object.keys(DEFAULTS).forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(data.settings, k)) next[k] = data.settings[k];
        });
        state = next;
        saveSettings();
        var chain = Promise.resolve();
        if (data.image && data.image.dataURL) chain = imageApi.put(dataURLToBlob(data.image.dataURL));
        chain.then(loadImage).then(function () { apply(); refreshUI(); })
          .catch(function (err) { alert('导入失败：' + (err && err.message ? err.message : err)); });
      };
      fr.readAsText(f);
    });
    input.click();
  }

  /* ================= 8. 注入 + 幂等守护 ================= */

  function injectSection() {
    var general = document.querySelector('.settings-general');
    if (!general) return false;
    if (document.getElementById(SECTION_ID)) return true;

    var secs = [].slice.call(general.children).filter(function (n) {
      return n.tagName === 'SECTION' && n.classList.contains('settings-general-section');
    });
    var anchored = null;
    for (var i = 0; i < secs.length; i++) {
      if (secs[i].querySelector('.settings-general-heading')) anchored = secs[i];
    }
    var node = buildSection();
    if (anchored && anchored.parentNode === general) general.insertBefore(node, anchored.nextSibling);
    else general.appendChild(node);
    refreshUI();
    log('「壁纸」小节已注入设置面板。');
    return true;
  }

  var ticking = false;
  function scheduleTick() {
    if (ticking) return;
    ticking = true;
    setTimeout(function () {
      ticking = false;
      try {
        injectSection();
        markAppRoot();
        /* React 可能重写 html 的 class，把我们加的标记冲掉 —— 这里补回来。
           只补不重算，避免和主题观察器互相触发。 */
        var wantOn = effectiveOn();
        if (html.classList.contains('pi-wp-on') !== wantOn) apply();
        if (wantOn && clamp(state.panelBlur, 0, 30) > 0
            && !html.classList.contains('pi-wp-panelblur')) apply();
      } catch (e) { console.warn('[pi-wallpaper] tick 出错：', e); }
    }, 200);
  }

  function startObservers() {
    /* 设置弹窗会被 React 挂载/卸载，注入的小节会被冲掉 —— 这里兜住 */
    new MutationObserver(scheduleTick).observe(document.body, { childList: true, subtree: true });

    /* 只监听 data-theme（真正的主题切换信号）。
       不监听 class —— apply() 自己就会改 class，监听它会自我触发。 */
    new MutationObserver(function () {
      apply();
      refreshUI();
    }).observe(html, { attributes: true, attributeFilter: ['data-theme'] });
  }

  /* ================= 9. 启动 ================= */

  /* 等待 pi-web 水合完成。Next.js 的 DOM 可能晚于 document-idle 才出现，
     所以这里不能早退 —— 早退一次就再也不会启动了。 */
  function isPiWeb() {
    return !!(document.querySelector('#session-sidebar') || document.querySelector('.chat-content'));
  }

  var bootMo = null;
  var bootTimer = null;

  function startOnce() {
    if (started) return;
    if (!isPiWeb()) return;      // 还没水合完，下次再看
    started = true;

    if (bootMo) { bootMo.disconnect(); bootMo = null; }
    if (bootTimer) { clearInterval(bootTimer); bootTimer = null; }

    log('v' + VERSION + ' 启动中… origin=' + location.origin);

    ensureStyle();
    apply();            // 先把样式与变量挂上（图片稍后异步到）
    injectSection();    // 立刻注入一次 —— 设置面板可能已经开着，别等 DOM 变化
    refreshUI();
    loadImage();
    startObservers();

    log('就绪。设置入口：设置 → 常规 → 壁纸');
  }

  /* 引导期观察器：pi-web 一出现就初始化 */
  try {
    bootMo = new MutationObserver(function () { startOnce(); });
    bootMo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 极端情况下退化到纯轮询 */ }
  bootTimer = setInterval(startOnce, 400);
  startOnce();          // 也许 document-idle 时已经水合完了

  /* 诊断用：控制台里执行 __piWallpaper.status() 看状态 */
  window.__piWallpaper = {
    version: VERSION,
    get state() { return state; },
    apply: apply,
    injectSection: injectSection,
    status: function () {
      return {
        version: VERSION,
        origin: location.origin,
        started: started,
        hasImage: hasImage,
        objectUrl: !!objectUrl,
        sidebar: !!document.querySelector('#session-sidebar'),
        chatContent: !!document.querySelector('.chat-content'),
        settingsGeneral: !!document.querySelector('.settings-general'),
        styleTag: !!document.getElementById(STYLE_ID),
        layer: !!document.getElementById(LAYER_ID),
        section: !!document.getElementById(SECTION_ID),
        htmlClasses: [].slice.call(html.classList)
      };
    }
  };
})();
