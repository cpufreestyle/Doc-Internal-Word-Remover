/* Service Worker - 本地缓存，断网也能用；只缓存静态资源，不缓存用户文件数据。
   取回策略：网络优先（在线总是拿最新并把结果写回缓存），断网才回退缓存。
   页面的样式表带 ?v=__DWR_VERSION__ 缓存参数，预缓存清单里是不带参数的同名资源，
   离线兜底用 ignoreSearch 匹配；发版后 ?v= 变化的请求在线时自然拿到新文件并按新键落缓存。 */
/* v4.78：词库与处理方式改为默认收起的设置栏，收起时仍显示当前方案。升级缓存
   版本可让仍挂着旧 Service Worker 的页面在下次打开时清掉旧 HTML / CSS / JS；
   在线请求同时绕过浏览器 HTTP 缓存，避免继续显示旧界面。 */
const CACHE = 'dwr-v6';
const ASSETS = [
  './index.html', './css/style.css',
  './js/zip.js', './js/rules.js', './js/ooxml.js', './js/util.js', './js/worker.js', './js/report.js',
  './js/format.js', './js/ui.js', './js/dircache.js',
  // app.js 是应用主逻辑，漏掉它断网时页面能打开但工具完全不能用（v4.27 修）
    './js/app.js',
  './js/undo.js',
  './js/reporthtml.js',
  './assets/app-icon.svg', './assets/app-icon.png', './manifest.json'
  ,
  // favicon：断网时浏览器仍会请求它，漏缓存则标签页图标丢失（v4.27 补）
  './assets/app-icon.ico'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then((resp) => {
      if (resp.ok) {
        const cl = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, cl));
      }
      return resp;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: true })
        .then((hit) => hit || caches.match('./index.html'))
    )
  );
});
