/**
 * 生成 assets/app-icon.svg（矢量源）并渲染出 assets/app-icon.png（1024×1024）。
 *
 * 图形：苹果 squircle 底板（超椭圆 n=5）+ 三张错位文档 + 被划掉的敏感词 + 右下角对勾。
 * 三张纸表示批量处理，红线表示被清除的敏感词，绿勾表示核对干净。
 * 圆角用「按弧长等分取点 + Catmull-Rom 转三次贝塞尔」逼近超椭圆，纯几何生成、结果确定。
 *
 * 用法：
 *   node assets/make-icon.mjs            # 生成 SVG 并渲染 PNG
 *   node assets/make-icon.mjs --svg-only # 只生成 SVG（不依赖 Playwright）
 *   node assets/make-icon.mjs --sheet    # 额外渲染 16~64px 小尺寸对照图（写入系统临时目录）
 *
 * 随后执行 assets/make-icon.py 由 PNG 导出多尺寸 app-icon.ico。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SVG_PATH = path.join(DIR, "app-icon.svg");
const PNG_PATH = path.join(DIR, "app-icon.png");

const SIZE = 1024;
const N = 5; // 超椭圆指数，n=5 接近苹果 squircle 的连续曲率
const SAMPLES = 1440; // 弧长参数化采样精度
const VERTS = 56; // 最终贝塞尔锚点数

/* ---------------- 纸面几何：改图标主要调这一段 ---------------- */
const SHEET = { x: 186, y: 206, w: 404, h: 520, r: 44 };
const FOLD = 128; // 右上角折角边长
const TILT = -6; // 整叠纸的倾斜角（度）
const PIVOT = [SHEET.x + SHEET.w / 2, SHEET.y + SHEET.h / 2];
const BACK = [
  // 后两张纸相对主纸的偏移：向左下错位，纸叠只从左边与左下露出边缘
  { dx: -58, dy: 22, fill: "#BFD6F0" },
  { dx: -29, dy: 11, fill: "#DCEAFA" },
];
const BAR_X = SHEET.x + 46;
const BAR_H = 52;
const BAR_R = BAR_H / 2;
const BARS = [
  { y: SHEET.y + 150, w: 290, fill: "#FF5F52" },
  { y: SHEET.y + 248, w: 252, fill: "#C4D2E4" },
  { y: SHEET.y + 338, w: 302, fill: "#C4D2E4" },
];
const STRIKE = "M212 432L542 334"; // 划掉首行「敏感词」的白线，约 17° 交叉
const BADGE = { cx: 736, cy: 748, ring: 176, inner: 158 };
const CHECK = "M658 748L710 797L814 677";
/* -------------------------------------------------------------- */

/** 超椭圆 |x|^n + |y|^n = 1 的参数方程取点 */
function superellipse(t) {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    Math.sign(c) * Math.pow(Math.abs(c), 2 / N),
    Math.sign(s) * Math.pow(Math.abs(s), 2 / N),
  ];
}

/** 沿轮廓按弧长等分取样，避免曲率大处锚点过密 */
function arcLengthPoints(count) {
  const dense = [];
  for (let i = 0; i < SAMPLES; i++) dense.push(superellipse((i / SAMPLES) * Math.PI * 2));
  const cum = [0];
  for (let i = 1; i <= SAMPLES; i++) {
    const a = dense[i - 1];
    const b = dense[i % SAMPLES];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[SAMPLES];
  const out = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    while (j < SAMPLES - 1 && cum[j + 1] < target) j++;
    const span = cum[j + 1] - cum[j] || 1;
    const k = (target - cum[j]) / span;
    const a = dense[j];
    const b = dense[(j + 1) % SAMPLES];
    out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
  }
  return out;
}

/** 转成 viewBox 坐标并连成闭合三次贝塞尔路径（Catmull-Rom → Bezier） */
function squirclePath() {
  const P = arcLengthPoints(VERTS).map(([x, y]) => [((x + 1) / 2) * SIZE, ((y + 1) / 2) * SIZE]);
  const f = (v) => String(Math.round(v * 100) / 100);
  let d = "M" + f(P[0][0]) + " " + f(P[0][1]);
  for (let i = 0; i < VERTS; i++) {
    const p0 = P[(i - 1 + VERTS) % VERTS];
    const p1 = P[i];
    const p2 = P[(i + 1) % VERTS];
    const p3 = P[(i + 2) % VERTS];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += "C" + f(c1x) + " " + f(c1y) + " " + f(c2x) + " " + f(c2y) + " " + f(p2[0]) + " " + f(p2[1]);
  }
  return d + "Z";
}

/** 圆角矩形；fold > 0 时把右上角切成折角，折线正好落在纸里不越界 */
function sheetPath(x, y, w, h, r, fold) {
  const cut = fold > 0 ? fold : 0;
  return [
    "M" + (x + r) + " " + y,
    "H" + (x + w - cut),
    cut > 0 ? "L" + (x + w) + " " + (y + cut) : "H" + (x + w - r) + "A" + r + " " + r + " 0 0 1 " + (x + w) + " " + (y + r),
    "V" + (y + h - r),
    "A" + r + " " + r + " 0 0 1 " + (x + w - r) + " " + (y + h),
    "H" + (x + r),
    "A" + r + " " + r + " 0 0 1 " + x + " " + (y + h - r),
    "V" + (y + r),
    "A" + r + " " + r + " 0 0 1 " + (x + r) + " " + y,
    "Z",
  ].join(" ");
}

const SQUIRCLE = squirclePath();

const backSheets = BACK.map((b) =>
  '<path d="' + sheetPath(SHEET.x + b.dx, SHEET.y + b.dy, SHEET.w, SHEET.h, SHEET.r, 0) +
  '" fill="' + b.fill + '" filter="url(#sheetShadowSoft)"/>'
).join("\n    ");

const foldX = SHEET.x + SHEET.w - FOLD;
const foldY = SHEET.y + FOLD;
const bars = BARS.map((b) =>
  '<rect x="' + BAR_X + '" y="' + b.y + '" width="' + b.w + '" height="' + BAR_H + '" rx="' + BAR_R + '" fill="' + b.fill + '"/>'
).join("\n      ");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.45" y2="1">
      <stop offset="0" stop-color="#5AB2FF"/>
      <stop offset="1" stop-color="#0A54CE"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.16"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fold" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#DCEAFF"/>
      <stop offset="1" stop-color="#BBD6F7"/>
    </linearGradient>
    <linearGradient id="badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#46D96E"/>
      <stop offset="1" stop-color="#22A84C"/>
    </linearGradient>
    <filter id="sheetShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#0B3A80" flood-opacity="0.30"/>
    </filter>
    <filter id="sheetShadowSoft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#0B3A80" flood-opacity="0.20"/>
    </filter>
  </defs>
  <path d="${SQUIRCLE}" fill="url(#bg)"/>
  <path d="${SQUIRCLE}" fill="url(#gloss)"/>
  <g transform="rotate(${TILT} ${PIVOT[0]} ${PIVOT[1]})">
    ${backSheets}
    <g filter="url(#sheetShadow)">
      <path d="${sheetPath(SHEET.x, SHEET.y, SHEET.w, SHEET.h, SHEET.r, FOLD)}" fill="#FFFFFF"/>
      <path d="M${foldX} ${SHEET.y}H${SHEET.x + SHEET.w}V${foldY}Z" fill="url(#fold)"/>
      ${bars}
      <path d="${STRIKE}" fill="none" stroke="#FFFFFF" stroke-width="24" stroke-linecap="round"/>
    </g>
  </g>
  <circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.ring}" fill="#FFFFFF"/>
  <circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.inner}" fill="url(#badge)"/>
  <path d="${CHECK}" fill="none" stroke="#FFFFFF" stroke-width="61" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

fs.writeFileSync(SVG_PATH, SVG);
console.log("写入 " + path.relative(process.cwd(), SVG_PATH) + "（" + SVG.length + " 字节）");

if (process.argv.includes("--svg-only")) {
  console.log("已跳过 PNG 渲染（--svg-only）");
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (e) {
  console.error("未找到 Playwright，无法渲染 PNG。请先 npm i -D playwright 并安装 Chromium，或用 --svg-only。");
  process.exit(1);
}

const svgUrl = "file:///" + SVG_PATH.replace(/\\/g, "/");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
await page.goto(svgUrl, { waitUntil: "load" });
await page.waitForTimeout(200);
await page.screenshot({ path: PNG_PATH, omitBackground: true });
console.log("写入 " + path.relative(process.cwd(), PNG_PATH) + "（" + SIZE + "×" + SIZE + "，透明底）");

if (process.argv.includes("--sheet")) {
  // 任务栏 / 桌面 / favicon 实际就这个大小，别只在大图上确认
  const sizes = [64, 48, 32, 24, 16];
  const inline = SVG.replace(' width="1024" height="1024"', "");
  const strip =
    '<body style="margin:0;background:#ffffff;display:flex;gap:20px;align-items:flex-end;padding:20px 20px 8px">' +
    sizes
      .map(
        (s) =>
          '<div style="text-align:center;font:12px sans-serif;color:#555">' +
          inline.replace("<svg ", '<svg width="' + s + '" height="' + s + '" ') +
          "<div>" + s + "px</div></div>"
      )
      .join("") +
    "</body>";
  const sp = await browser.newPage({ viewport: { width: 420, height: 132 }, deviceScaleFactor: 4 });
  await sp.setContent(strip);
  await sp.waitForTimeout(150);
  const out = path.join(os.tmpdir(), "dwr-icon-small.png");
  await sp.screenshot({ path: out });
  console.log("写入 " + out + "（小尺寸对照）");
}

await browser.close();

