'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'pi-web-wallpaper.user.js'), 'utf8');
const script = new vm.Script(source, { filename: 'pi-web-wallpaper.user.js' });
const metadata = source.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/m)[1];
function values(key) {
  return [...metadata.matchAll(new RegExp('^// @' + key + '\\s+(.+)$', 'gm'))].map(m => m[1].trim());
}

function browser(url, hydrated = false) {
  const metrics = { reads: 0, writes: 0, queries: 0, intervals: new Map(), observers: [], logs: [] };
  let isHydrated = hydrated;
  function element(tag) {
    const classes = new Set();
    const properties = new Map();
    return {
      tagName: tag.toUpperCase(), children: [], id: '', hidden: false,
      style: {
        getPropertyValue: key => properties.get(key) || '',
        setProperty: (key, value) => properties.set(key, value),
        removeProperty: key => properties.delete(key),
      },
      classList: {
        contains: key => classes.has(key), add: key => classes.add(key),
        toggle(key, on) { if (on) classes.add(key); else classes.delete(key); },
        [Symbol.iterator]: () => classes[Symbol.iterator](),
      },
      appendChild(child) { this.children.push(child); child.parentNode = this; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
      setAttribute() {},
      querySelector(selector) {
        metrics.queries++;
        return isHydrated && selector === '#session-sidebar' ? sidebar : null;
      },
    };
  }
  const html = element('html');
  const head = element('head');
  const body = element('body');
  const root = element('div');
  const sidebar = element('div');
  sidebar.id = 'session-sidebar';
  html.appendChild(head); html.appendChild(body); body.appendChild(root); root.appendChild(sidebar);
  function byId(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) { const found = byId(child, id); if (found) return found; }
    return null;
  }
  const context = vm.createContext({
    location: new URL(url), URL,
    console: {
      log: (...args) => metrics.logs.push(args), warn: (...args) => metrics.logs.push(args),
    },
    localStorage: {
      getItem(key) { assert.equal(key, 'pi-wallpaper:settings:v1'); metrics.reads++; return null; },
      setItem() { metrics.writes++; },
    },
    document: {
      documentElement: html, head, body,
      querySelector: selector => html.querySelector(selector),
      getElementById: id => byId(html, id), createElement: element,
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; metrics.observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    },
    setInterval(callback) { const id = metrics.intervals.size + 1; metrics.intervals.set(id, callback); return id; },
    clearInterval(id) { metrics.intervals.delete(id); },
    setTimeout() { throw new Error('Unexpected scheduled UI tick'); },
    getComputedStyle: () => ({ getPropertyValue: () => 'rgb(30, 30, 30)' }),
  });
  context.window = context;
  return { context, metrics, html, head, byId: id => byId(html, id), hydrate() { isHydrated = true; } };
}

function run(page) { script.runInContext(page.context, { timeout: 1000 }); }
const settle = () => new Promise(resolve => setImmediate(resolve));

test('metadata has stable identity and canonical GitHub update URLs', () => {
  assert.deepEqual(values('name'), ['Pi Web 壁纸']);
  assert.deepEqual(values('namespace'), ['https://github.com/local/pi-web-wallpaper']);
  assert.equal(values('version').length, 1);
  assert.match(values('version')[0], /^\d+\.\d+\.\d+$/);
  assert.deepEqual(values('author'), ['IA20201']);
  assert.deepEqual(values('license'), ['MIT']);
  const repo = 'https://github.com/IA20201/pi-web-wallpaper';
  const raw = 'https://raw.githubusercontent.com/IA20201/pi-web-wallpaper/main/pi-web-wallpaper.user.js';
  assert.deepEqual(values('homepageURL'), [repo]);
  assert.deepEqual(values('supportURL'), [repo + '/issues']);
  assert.deepEqual(values('updateURL'), [raw]);
  assert.deepEqual(values('downloadURL'), [raw]);
  assert.deepEqual(values('grant'), ['none']);
  assert.deepEqual(values('run-at'), ['document-idle']);
  assert.deepEqual(values('match'), ['http://*:30141/*', 'https://*:30141/*']);
  assert.equal(source.match(/var VERSION = '([^']+)'/)[1], values('version')[0]);
});

for (const url of [
  'http://example.com/', 'https://example.com/', 'http://localhost:3000/',
  'http://192.168.112.38:30142/', 'https://example.com:443/',
  'ftp://example.com:30141/', 'file:///tmp/pi-web.html',
]) {
  test(`reject ${url} before storage, DOM queries, timers or boot flag`, () => {
    const page = browser(url, true);
    run(page);
    assert.equal(page.metrics.reads, 0);
    assert.equal(page.metrics.writes, 0);
    assert.equal(page.metrics.queries, 0);
    assert.equal(page.metrics.intervals.size, 0);
    assert.equal(page.metrics.observers.length, 0);
    assert.equal(page.context.__piWallpaperBooted, undefined);
    assert.equal(page.context.__piWallpaper, undefined);
    assert.equal(page.head.children.length, 0);
  });
}

for (const url of [
  'http://localhost:30141/', 'http://127.0.0.1:30141/',
  'http://192.168.112.38:30141/', 'http://192.168.87.222:30141/',
  'http://10.0.0.42:30141/', 'http://172.16.2.5:30141/',
  'http://[::1]:30141/', 'https://pi.example.com:30141/',
]) {
  test(`start hydrated Pi Web at ${url}`, async () => {
    const page = browser(url, true);
    run(page);
    await settle();
    assert.equal(page.context.__piWallpaper.status().started, true);
    assert.equal(page.context.__piWallpaper.version, values('version')[0]);
    assert.equal(page.context.__piWallpaper.status().origin, new URL(url).origin);
    assert.ok(page.byId('pi-wp-style'));
    assert.equal(page.metrics.intervals.size, 0);
    assert.equal(page.metrics.observers[0].disconnected, true);
    assert.equal(page.metrics.observers.length, 3);
    assert.equal(page.metrics.writes, 0);
  });
}

test('unrelated service on port 30141 never receives styles or settings writes', () => {
  const page = browser('http://example.com:30141/');
  run(page);
  for (const callback of page.metrics.intervals.values()) callback();
  assert.equal(page.context.__piWallpaper.status().started, false);
  assert.equal(page.byId('pi-wp-style'), null);
  assert.equal(page.byId('pi-wp-layer'), null);
  assert.equal(page.byId('pi-wp-section'), null);
  assert.equal(page.metrics.writes, 0);
});

test('delayed hydration is detected by bootstrap observer', async () => {
  const page = browser('http://192.168.112.38:30141/login');
  run(page);
  assert.equal(page.context.__piWallpaper.status().started, false);
  assert.equal(page.metrics.intervals.size, 1);
  page.hydrate();
  page.metrics.observers[0].callback();
  await settle();
  assert.equal(page.context.__piWallpaper.status().started, true);
  assert.equal(page.metrics.intervals.size, 0);
  assert.ok(page.byId('pi-wp-style'));
});

test('duplicate installation does not reread storage or create extra observers', async () => {
  const page = browser('http://localhost:30141/', true);
  run(page);
  await settle();
  const api = page.context.__piWallpaper;
  const reads = page.metrics.reads;
  const observers = page.metrics.observers.length;
  const styles = page.head.children.length;
  run(page);
  assert.equal(page.context.__piWallpaper, api);
  assert.equal(page.metrics.reads, reads);
  assert.equal(page.metrics.observers.length, observers);
  assert.equal(page.head.children.length, styles);
});

test('README and changelog agree with the published metadata', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  for (const key of ['homepageURL', 'supportURL', 'updateURL', 'downloadURL']) {
    assert.ok(readme.includes(values(key)[0]), `README missing ${key}`);
  }
  assert.ok(readme.includes('v' + values('version')[0]));
  assert.ok(changelog.includes('## ' + values('version')[0]));
});
