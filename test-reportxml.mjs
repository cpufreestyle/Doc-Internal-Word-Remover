#!/usr/bin/env node
/**
 * test-reportxml.mjs —— XML 报告导出（js/reportxml.js）回归测试
 *
 * 背景：外部保密检查系统（鼎普等）可导出 HTML / XML / Word / PDF 四种报告。
 * 我们原来有 HTML / Word / JSON / CSV，缺一种「给别的系统读」的 XML；
 * v4.92 补上这一种。这里验三件事：
 *   1. 内容口径与 HTML / Word 报告一致（标题、结论、概要、做法、局限、明细都对得上）；
 *   2. 生成的 XML 必须是良构（标签配对、特殊字符转义、不会被别的系统解析器报错）；
 *   3. 列之外的附加字段不丢、数组列拆成可逐项读取的子元素。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('PASS [' + name + ']');
  } else {
    failed++;
    console.log('FAIL [' + name + '] ' + String(detail || ''));
  }
}

function loadXmlModule() {
  const files = ['js/reportxml.js'];
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const ctx = {
    TextEncoder, TextDecoder,
    Blob: globalThis.Blob,
    Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window.DWRReportXml;
}

/** 极简良构检查：标签必须配对且嵌套正确（本模块只生成元素与文本，不含 CDATA） */
function wellFormed(xml) {
  const stack = [];
  // 逐个标签扫过去：属性值里的 > 不能被当成标签结束
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    const gt = xml.indexOf('>', lt);
    if (gt < 0) return false;
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('?') || tag.startsWith('!')) { i = gt + 1; continue; }
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      if (!stack.length || stack.pop() !== name) return false;
    } else {
      const selfClose = tag.endsWith('/');
      const name = (selfClose ? tag.slice(0, -1) : tag).trim().split(/\s/)[0];
      if (!selfClose) stack.push(name);
    }
    i = gt + 1;
  }
  return stack.length === 0;
}

const X = loadXmlModule();

const MODEL = {
  title: '文档敏感词扫描报告',
  generatedAt: '2026-11-12 10:00:00',
  conclusion: '共扫描 10 个文件，命中 "内部" & 机密 共 3 处。',
  summary: [
    ['扫描文件数', 10, 'obs', '本次遍历的文件数'],
    ['命中文件数', 2, 'obs', '命中任一敏感词的文件数']
  ],
  steps: ['按当前词库做归一化匹配。', '逐文件统计命中处数。'],
  extraLimits: ['旧版二进制格式只做只读检测。'],
  review: '已复核，可外发',
  reviewList: '计算机信息已填报台账：符合；正确张贴设备密级标识：不符合',
  note: '本报告由本地工具生成，数据未离开本机。',
  cols: [
    { k: 'file', label: '文件路径' },
    { k: 'hits', label: '命中处数' },
    { k: 'matched', label: '命中词' },
    { k: 'status', label: '状态' }
  ],
  rows: [
    { file: 'D:\\<script>内部文件.docx', hits: 2, matched: ['内部', '机密'], status: '已清除' },
    { file: 'D:\\普通.txt', hits: 0, matched: [], status: '无命中', extra: '备注列' }
  ]
};

const xml = X.documentXml(MODEL);

check('XML 声明为 UTF-8 且带独立文档标记',
  xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'));
check('根元素是 InspectionReport',
  xml.indexOf('<InspectionReport ') >= 0 && xml.indexOf('</InspectionReport>') >= 0);
check('整体是良构 XML（标签配对）', wellFormed(xml), xml.slice(0, 200));

check('标题写进 <Title>', xml.indexOf('<Title>文档敏感词扫描报告</Title>') >= 0);
check('结论写进 <Conclusion>', xml.indexOf('<Conclusion>') >= 0);
check('复核意见写进 <Review>', xml.indexOf('<Review>已复核，可外发</Review>') >= 0);
check('脚注写进 <Note>', xml.indexOf('<Note>') >= 0);

check('概要每项一个 <Item>，含 Label/Value/Kind/Evidence',
  xml.indexOf('<Label>扫描文件数</Label>') >= 0 &&
  xml.indexOf('<Value>10</Value>') >= 0 &&
  xml.indexOf('<Kind>obs</Kind>') >= 0 &&
  xml.indexOf('<Evidence>本次遍历的文件数</Evidence>') >= 0);

check('本次做法每条一个 <Step> 且带序号',
  xml.indexOf('<Step index="1">按当前词库做归一化匹配。</Step>') >= 0);
check('局限写进 <Limits>',
  xml.indexOf('<Limits') >= 0 &&
  xml.indexOf('<Limit>旧版二进制格式只做只读检测。</Limit>') >= 0);

check('人工判定清单按分号拆成逐条 <Item>',
  xml.indexOf('<ReviewList count="2">') >= 0 &&
  xml.indexOf('<Item>计算机信息已填报台账：符合</Item>') >= 0 &&
  xml.indexOf('<Item>正确张贴设备密级标识：不符合</Item>') >= 0);

check('列定义保留 key 与显示名',
  xml.indexOf('<Column key="file" label="文件路径"/>') >= 0 &&
  xml.indexOf('<Column key="matched" label="命中词"/>') >= 0);
check('明细行数写进 <Rows count>',
  xml.indexOf('<Rows count="2">') >= 0 &&
  xml.indexOf('<Row index="1">') >= 0 &&
  xml.indexOf('<Row index="2">') >= 0);

check('数组列拆成 <Term> 子元素并带 count',
  xml.indexOf('<matched count="2">') >= 0 &&
  xml.indexOf('<Term>内部</Term>') >= 0 &&
  xml.indexOf('<Term>机密</Term>') >= 0);
check('空数组列给出 count="0" 且不留空子元素',
  xml.indexOf('<matched count="0"/>') >= 0);
check('列之外的附加字段不丢',
  xml.indexOf('<extra>备注列</extra>') >= 0);

// 特殊字符必须转义，否则别的系统的 XML 解析器会直接报错
check('引号与尖括号按 XML 规则转义',
  xml.indexOf('&amp;') >= 0 &&
  xml.indexOf('&quot;') >= 0 &&
  xml.indexOf('<script>') < 0 &&
  xml.indexOf('&lt;script&gt;') >= 0);

// build() 返回 Blob，类型与内容都要对
const blob = X.build(MODEL);
check('build 返回 Blob', blob instanceof Blob, typeof blob);
check('Blob 类型是 application/xml',
  blob && blob.type === 'application/xml;charset=utf-8', blob && blob.type);

const text = await blob.text();
check('Blob 内容与 documentXml 一致', text === xml);

// 缺省模型（什么都没给）也不能抛
let emptyOk = true;
let emptyXml = '';
try {
  emptyXml = X.documentXml({});
} catch (e) {
  emptyOk = false;
}
check('空模型也能生成良构 XML', emptyOk && wellFormed(emptyXml));
check('空模型仍给出默认列', emptyXml.indexOf('<Column key="file" label="文件路径"/>') >= 0);

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);
