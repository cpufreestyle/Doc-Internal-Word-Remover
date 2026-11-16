#!/usr/bin/env node
/**
 * test-hidden.mjs —— 隐藏文本通道回归测试
 *
 * 覆盖 14 条「外部保密检查软件能读出来、但肉眼看不出来」的载体：
 * 隐藏文字（w:vanish / w:webHidden）、同色白字、XML 注释、CDATA、域代码
 * （w:instrText / w:fldSimple）、形状属性 descr、文档属性 core.xml、
 * altChunk 外嵌 HTML、customXml、术语库 glossary、内容控件 w:sdt、
 * 修订删除记录 w:delText。
 *
 * 每条都断言两件事：
 *   ① 扫描必须报出命中（不能出现「扫描报干净、清除却动文件」的口径分裂）；
 *   ② 清除后解包逐部件复查，必须不再残留该词。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEngine() {
  const files = ['js/zip.js', 'js/rules.js', 'js/pdf.js', 'js/ooxml.js'];
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const ctx = {
    TextEncoder, TextDecoder,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    Blob: globalThis.Blob, Response: globalThis.Response,
    Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window;
}

const D = loadEngine();
const engine = D.DWRRules.createEngine({
  rules: [{ text: '内部', type: 'text', enabled: true }],
  scope: 'all', action: 'delete', custom: ''
});

// 简易 zip 写入器（store，不压缩）
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cenBuf, end]));
}

const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function docx(parts) {
  const files = {
    '[Content_Types].xml': CT + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels': CT + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml': CT + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      parts.body +
      '</w:document>'
  };
  Object.assign(files, parts.extra || {});
  return makeZip(files);
}

const cases = [
  {
    id: 'vanish-hidden',
    label: '隐藏文字 w:vanish（字体设为隐藏）',
    doc: docx({
      body: '<w:body><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>内部</w:t></w:r></w:p></w:body>'
    })
  },
  {
    id: 'webHidden',
    label: 'Web 隐藏文字 w:webHidden',
    doc: docx({
      body: '<w:body><w:p><w:r><w:rPr><w:webHidden/></w:rPr><w:t>内部</w:t></w:r></w:p></w:body>'
    })
  },
  {
    id: 'white-text',
    label: '白字隐藏（同色文字）',
    doc: docx({
      body: '<w:body><w:p><w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>内部</w:t></w:r></w:p></w:body>'
    })
  },
  {
    id: 'xml-comment',
    label: 'XML 注释内藏词',
    doc: docx({
      body: '<w:body><!-- 内部 --><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body>'
    })
  },
  {
    id: 'field-instrText',
    label: '域代码 instrText',
    doc: docx({
      body: '<w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText>内部</w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>'
    })
  },
  {
    id: 'fldSimple',
    label: '简单域 w:fldSimple',
    doc: docx({
      body: '<w:body><w:p><w:fldSimple w:instr="内部"><w:r><w:t>显示值</w:t></w:r></w:fldSimple></w:p></w:body>'
    })
  },
  {
    id: 'attr-descr',
    label: '形状属性 descr（图片替代文字）',
    doc: docx({
      body: '<w:body><w:p><w:r><w:drawing><wp:inline xmlns:wp="x" descr="内部"/></w:r></w:p></w:body>'
    })
  },
  {
    id: 'docProps-core',
    label: '文档属性 core.xml（标题/作者）',
    doc: docx({
      body: '<w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body>',
      extra: {
        'docProps/core.xml': CT + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">' +
          '<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">内部项目</dc:title>' +
          '<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">内部</dc:creator></cp:coreProperties>'
      }
    })
  },
  {
    id: 'altChunk',
    label: 'altChunk 外嵌内容',
    doc: docx({
      body: '<w:body><w:altChunk r:id="rId9"/><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body>',
      extra: {
        'word/afchunk.htm': '<html><body><p>内部</p></body></html>'
      }
    })
  },
  {
    id: 'customXml-item',
    label: 'customXml 自定义数据部件',
    doc: docx({
      body: '<w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body>',
      extra: {
        'customXml/item1.xml': CT + '<root xmlns="urn:x"><value>内部</value></root>'
      }
    })
  },
  {
    id: 'glossary-doc',
    label: 'Word 术语库 glossary/document.xml',
    doc: docx({
      body: '<w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body>',
      extra: {
        'word/glossary/document.xml': CT + '<w:glossaryDocument xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:docParts><w:docPart><w:docPartBody><w:p><w:r><w:t>内部</w:t></w:r></w:p></w:docPartBody></w:docPart></w:docParts>' +
          '</w:glossaryDocument>'
      }
    })
  },
  {
    id: 'cdata',
    label: 'CDATA 区块内藏词',
    doc: docx({
      body: '<w:body><w:p><w:r><w:t><![CDATA[内部]]></w:t></w:r></w:p></w:body>'
    })
  },
  {
    id: 'xml-comment-entity',
    label: 'XML 注释内实体转义写词',
    doc: docx({
      body: '<w:body><!-- &#x5185;&#x90E8; --><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body>'
    })
  },
  {
    id: 'xml-comment-multi',
    label: '同一部件多个注释并存',
    doc: docx({
      body: '<w:body><!-- 普通注释 --><w:p><w:r><w:t>正文</w:t></w:r></w:p><!-- 内部 --></w:body>'
    })
  },
  {
    id: 'sdt-placeholder',
    label: '内容控件 w:sdt 占位文字',
    doc: docx({
      body: '<w:body><w:sdt><w:sdtContent><w:p><w:r><w:t>内部</w:t></w:r></w:p></w:sdtContent></w:sdt>'
    })
  },
  {
    id: 'revision-del',
    label: '修订删除记录 w:delText',
    doc: docx({
      body: '<w:body><w:p><w:del><w:r><w:delText>内部</w:delText></w:r></w:del></w:p></w:body>'
    })
  }
];

const out = [];
let passed = 0;
let failed = 0;
for (const c of cases) {
  const scan = await D.DWRDoc.scanOffice(c.doc.buffer.slice(c.doc.byteOffset, c.doc.byteOffset + c.doc.byteLength), engine);
  const proc = await D.DWRDoc.processOffice(c.doc.buffer.slice(c.doc.byteOffset, c.doc.byteOffset + c.doc.byteLength), engine);
  // blob 为 null 表示「没有任何改动」，此时原始文件即最终结果，必须拿原始字节判定残留
  const outBytes = proc.blob ? new Uint8Array(await proc.blob.arrayBuffer()) : c.doc;
  const decode = new TextDecoder('utf-8');
  let residual = '';
  try {
    const zin = await D.DWRZip.load(outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength));
    const leftovers = [];
    for (const name of zin.names()) {
      const bytes = await zin.getBytes(name);
      const txt = decode.decode(bytes);
      if (txt.includes('内部')) leftovers.push(name);
    }
    residual = leftovers.length ? ('残留@' + leftovers.join(',')) : '已清除';
  } catch (e) { residual = '解包失败:' + e.message; }
  const hits = (scan && scan.matched) ? scan.matched.length : 0;
  out.push({ id: c.id, label: c.label, hits, residual });
  const ok = hits > 0 && residual === '已清除';
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS [' : 'FAIL [') + c.id + '] ' + c.label +
    ' hits=' + hits + ' 清除后=' + residual);
}

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed) process.exit(1);
