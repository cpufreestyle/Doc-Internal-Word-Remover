/**
 * rules.js —— 敏感词规则引擎
 * 支持：普通词 / 正则表达式 / 作用范围（首行+尾行 / 首行 / 全文）/ 多种替换策略
 *
 * 准确性设计（v1.5）：
 *  1) 反规避归一化：匹配前统一剔除零宽 / 软连字符等不可见字符、折叠全角→半角与空格，
 *     命中区间按「归一化下标 → 原始下标」映射回删，连夹带的不可见字符一并清除，
 *     「内<零宽>部」「内<全角空格>部」等规避写法无处遁形；
 *  2) 整词匹配（whole）：英文字母/数字规则仅按整词命中（AI 不误伤 said / armchair），
 *     边界同时兼容「原文有空格」与「空格被折叠」两种情况；
 *  3) 上下文排除（notBefore / notAfter）：命中紧邻指定词时跳过，可按需保留常见组合；
 *  4) 繁体容错（v2.5）：字面量规则按字生成「简体 | 繁体」字符类，「內部」「機密」「絕密」等繁体写法同样命中。
 *     映射表只收一对一无歧义字（「臺 / 幹 / 發 / 製 / 鬆 / 著」等一对多者一律不收，避免误伤），
 *     且只作用于字面量规则——正则规则仍按用户所写原样匹配，不受影响。
 */
(function (global) {
  'use strict';

  /** 个人信息模板：一键加入的常用识别规则（正则，条目名显示中文名而非原始正则串）
   *  每条都有 label：扫描报告 / 命中词列表里显示「手机号」而不是一长串正则源。
   *  正则按「分字符 / 边界」设计：
   *   - 手机号：1 开头 + 第二位 3-9 + 共 11 位数字，前后不能是数字（防止把 12 位数字串中间 11 位认成手机号）；
   *   - 身份证：15 或 18 位（末位可为 X），同样要求前后不是数字 / X（避免吞掉更长的字母数字串）；
   *   - 银行卡：13-19 位数字（覆盖国内主流卡号长度），前后不能是数字；
   *   - 邮箱：标准 user@domain.tld 形式；
   *   - IP：四段 0-255 的 IPv4。 */
  var PII_PRESETS = [
    { label: '手机号', text: '(?<![0-9])1[3-9][0-9]{9}(?![0-9])' },
    { label: '身份证号', text: '(?<![0-9Xx])(?:[0-9]{17}[0-9Xx]|[0-9]{15})(?![0-9Xx])' },
    { label: '银行卡号', text: '(?<![0-9])[1-9][0-9]{12,18}(?![0-9])' },
    { label: '邮箱', text: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}' },
    { label: 'IP 地址', text: '(?<![0-9.])((?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])[.]){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?![0-9])' }
  ];

  /** 默认敏感词库（可按企业规范自由增删）
   *  默认只处理四个密级标识：内部 / 秘密 / 机密 / 绝密；
   *  受控、商密、警示语等其他词汇不做默认处理，需要时在界面手动添加。
   *  四个密级词均不设置上下文排除；需要保留特定常见组合时，可在规则编辑器中自行添加。 */
  var DEFAULT_PRESETS = [
    { word: '内部', group: '密级标识' },
    { word: '秘密', group: '密级标识' },
    { word: '机密', group: '密级标识' },
    { word: '绝密', group: '密级标识' },
    /* v4.6 公文文号与常见合规词。
       单独成组、默认可关：这些词命中面比密级词大得多（「通报」「通知」「银行」在日常公文里
       随处可见），整组停用即回到 v4.5 及以前的默认行为，不会改变老用户的处理结果。 */
    { word: '国发', group: '公文文号' },
    { word: '国办发', group: '公文文号' },
    { word: '中发', group: '公文文号' },
    { word: '中办发', group: '公文文号' },
    { word: '府办', group: '公文文号' },
    { word: '府字', group: '公文文号' },
    { word: '厅字', group: '公文文号' },
    { word: '组厅字', group: '公文文号' },
    { word: '政办', group: '公文文号' },
    { word: '政发', group: '公文文号' },
    { word: '政字', group: '公文文号' },
    { word: '汇发', group: '公文文号' },
    { word: '委办发', group: '公文文号' },
    { word: '国税函', group: '公文文号' },
    { word: '邪教', group: '政治安全' },
    { word: '恐怖', group: '政治安全' },
    { word: '藏独', group: '政治安全' },
    { word: '东突', group: '政治安全' },
    /* v4.9 补足常见合规词，分三组、全部默认可关。
       分组关掉即回到 v4.8 的默认行为。选词标准：不用单字词（院/部/厅/局/委/署/司/令），
       那 8 个词在日常公文里命中面过大，属「广撒网」口径，文档脱敏用会误伤一片；
       其余按「是否指向涉密载体 / 敏感内容」筛，并用 notBefore / notAfter 压误报。 */
    /* 公文要素：发文形式与文种，指向正式公文载体 */
    { word: '通报', group: '公文要素' },
    { word: '简报', group: '公文要素' },
    { word: '通知', group: '公文要素' },
    { word: '纪要', group: '公文要素' },
    { word: '公告', group: '公文要素' },
    { word: '上报文件', group: '公文要素' },
    { word: '抄送', group: '公文要素' },
    { word: '印发', group: '公文要素' },
    /* 时效标识：紧急程度，本身不涉密但常与密级标识同行出现 */
    { word: '特急', group: '时效标识' },
    { word: '加急', group: '时效标识' },
    { word: '平级', group: '时效标识' },
    /* 敏感内容：军事与金融两类，均需上下文排除压误报 */
    { word: '银行', group: '敏感内容', notBefore: ['商业', '招商', '人民'] },
    { word: '二炮', group: '敏感内容' },
    { word: '导弹', group: '敏感内容' },
    { word: '预警机', group: '敏感内容' },
    { word: '歼击机', group: '敏感内容' }
  ];

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ---------------- 反规避归一化 ---------------- */

  /** 「零视觉宽度」字符：不可见的格式字符（软连字符 / 零宽 / 双向控制与隔离符 / BOM /
   *  行内注释锚点 / 阿拉伯方向控制 / 韩文填充等） + 各类空格（半角 / 全角 / NBSP / en-em 空格 /
   *  窄空格 / 行与段分隔符…）。匹配前剔除，命中时随区间一并清除，区间外的原样保留。
   *  注：只覆盖 BMP；平面外的 Cf（如 U+E0001）极少见，暂不处理。 */
  var GAP_CHARS_SRC = '\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e'
    + '\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb'
    + '\u115f\u1160\u3164\uffa0'
    + ' \u0009\u000a\u000b\u000c\u000d\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000';
  var GAP_RE = new RegExp('[' + GAP_CHARS_SRC + ']');
  /** 全角可打印 ASCII → 半角 折叠表 */
  var FULLWIDTH = {};
  (function () {
    for (var code = 0x21; code <= 0x7e; code++) {
      FULLWIDTH[String.fromCharCode(code + 0xfee0)] = String.fromCharCode(code);
    }
  })();
  /** 正文出现这些字符即走归一化路径（零宽字符 / 空格类 / 全角） */
  var NORM_SCAN_RE = new RegExp('[' + GAP_CHARS_SRC + '\\uff01-\\uff5e]');
  /**
   * 符号插字规避：在敏感词字符之间插入标点 / 符号（「内·部」「机-密」「内_部」「内(部)」等）仍需命中。
   * 取〜连接性〜标点（中间点 / 短横 / 下划线 / 斜杠 / 括号 / 书名号…及其全角形式），
   *  不含空格与零宽字符（它们由归一化路径负责）；须只插入在词内部，不会跨句读出错报。
   * SEP_MAX 限定两个词字符之间最多探入的分隔符个数，避免正则回溯爆炸。
   */
  var SEP_MAX = 3;
  var SEP_CHARS = [
    '·', '•', '・', '･', '．', '.',
    '－', '-', '‐', '‑', '‒', '–', '—', '―',
    '_', '＿', '/', '／', '\\', '|', '｜',
    '+', '＋', '*', '＊', '~', '～', '^',
    '#', '＃', '@', '＠', '&', '＆', '%', '％', '$', '＄',
    ',', '，', '、', '。', '!', '！', '?', '？',
    ';', '；', ':', '：',
    '(', ')', '（', '）', '[', ']', '［', '］',
    '《', '》', '〈', '〉', '「', '」', '『', '』'
  ];
  /** 成对括号：规避写法常把敏感词单字或整词括起来（「内（部）」「【机密】」），命中时顺带清理 */
  var OPEN_CHARS = ['(', '（', '[', '［', '{', '｛', '《', '〈', '「', '『', '【', '〔'];
  var CLOSE_CHARS = [')', '）', ']', '］', '}', '｝', '》', '〉', '」', '』', '】', '〕'];
  var OPEN_SRC = '[' + OPEN_CHARS.map(escapeClassChar).join('') + ']';
  var CLOSE_SRC = '[' + CLOSE_CHARS.map(escapeClassChar).join('') + ']';

  /** 字符类内转义：`-` 在字符类中表示区间，必须转义避免误生范围 */
  function escapeClassChar(ch) {
    return ch === '-' ? '\\-' : escapeRegExp(ch);
  }

  /** 词内分隔符模式（允许不出现） */
  var SEP_SRC = '[' + SEP_CHARS.map(escapeClassChar).join('') + ']{0,' + SEP_MAX + '}';
  /** 正文出现这些字符时才需走分隔符容错路径 */
  var SEP_SCAN_RE = new RegExp('[' + SEP_CHARS.concat(OPEN_CHARS).concat(CLOSE_CHARS)
    .map(escapeClassChar).join('') + ']');

  /**
   * 繁体 -> 简体 等价字表（每两个字为一对：繁体 + 简体）。
   * 收录原则：只收标准、一对一无歧义的简化对应，且以涉密 / 商务 / 技术文档常用字为主。
   * 故意「不收」的一对多字（收了会制造误伤，宁可漏检也不误删）：
   *   臺 / 檯 / 颱 -> 台、幹 / 乾 -> 干、發 / 髮 -> 发、製 -> 制、鬆 -> 松、著 -> 着、
   *   覆 / 復 -> 复（復 已收）、馀 -> 余、佈 -> 布、佔 -> 占、併 -> 并、誌 -> 志、麵 -> 面。
   * 多对一（如 鍾 / 鐘 -> 钟）无害：任一繁体写法都能命中简体规则，收。
   */
  var TRAD_PAIRS =
    '內内機机絕绝祕秘國国關关業业資资訊讯' +
    '務务團团術术據据網网絡络統统項项數数' +
    '檔档變变記记錄录編编號号負负責责審审' +
    '準准備备訂订銷销時时實实際际產产專专' +
    '傳传無无與与從从嚴严個个們们來来對对' +
    '錯错證证書书協协議议決决區区醫医廠厂' +
    '廳厅歷历電电腦脑軟软體体環环衛卫總总' +
    '結结圖图幾几麼么樣样規规設设損损壞坏' +
    '護护擔担擊击選选買买賣卖費费價价銀银' +
    '錢钱論论講讲話话語语說说讀读寫写學学' +
    '習习員员職职級级別别種种構构後后裡里' +
    '裏里報报營营開开門门問问閉闭車车馬马' +
    '東东華华權权復复續续讓让勝胜輸输溫温' +
    '險险遠远遲迟導导識识針针鍵键鎖锁測测' +
    '維维運运載载遷迁範范標标題题於于覽览' +
    '閱阅狀状況况圍围劃划雲云穀谷鬥斗錶表' +
    '徵征鍾钟鐘钟毀毁';
  /**
   * 常用繁体字补遗：同样只收一对一无歧义的映射（双向展开：规则写繁体命中简体正文，
   * 简体规则也命中繁体正文）。一字多繁的字（台 / 发 / 干 / 制 / 松 / 着 / 复 / 面 / 只 /
   * 里 / 借 / 汇 / 历 / 表 / 云 / 划 / 谷 / 钟）一律不进这里，改由下面的上下文判别表处理，
   * 否则单字规则会被一律折叠而误伤。
   */
  var TRAD_PAIRS_EXT =
    '櫃柜' +
    '灣湾島岛頭头淨净員员議议雜杂風风' +
    '計计簽签機机單单間间稱称註注類类歸归' +
    '詞词場场處处舉举倉仓莊庄廢废貢贡購购' +
    '觀观廣广獲获雞鸡積积極极際际繼继監监' +
    '將将獎奖緊緊盡尽劇剧臨临鄰邻樓楼陸陆' +
    '滿满貿贸夢梦滅灭謀谋鳥鸟農农認认雙双' +
    '順顺訴诉談谈湯汤萬万衛卫聞闻穩稳誤误' +
    '縣县興兴壓压養养葉叶儀仪億亿園园約约' +
    '願愿張张鄭郑織织質质眾众轉转裝装陳陈' +
    '陣阵頁页頂顶顧顾飛飞';
  var TRAD_TO_SIMP = {};
  var SIMP_TO_TRADS = {};
  (function () {
    function build(pairs) {
      for (var i = 0; i + 1 < pairs.length; i += 2) {
        var trad = pairs.charAt(i), simp = pairs.charAt(i + 1);
        if (trad === simp) continue;
        if (TRAD_TO_SIMP[trad] && TRAD_TO_SIMP[trad] !== simp) {
          throw new Error('rules.js: 繁体映射表冲突 ' + trad);
        }
        TRAD_TO_SIMP[trad] = simp;
        (SIMP_TO_TRADS[simp] = SIMP_TO_TRADS[simp] || []).push(trad);
      }
    }
    build(TRAD_PAIRS);
    build(TRAD_PAIRS_EXT);
  })();
  /**
   * 一字多繁的「繁 -> 简」单向映射：这些繁体字的简体写法唯一（臺 / 髮 -> 台 / 发），
   * 但简体一侧对应多个繁体（台 <- 臺 / 檯）。因此只做单向展开——规则写繁体时仍能命中简体正文，
   * 而简体规则不会因为「台」被一律折叠成臺 / 檯 而误伤（臺灣、櫃檯 都不是同一回事）。
   * 简体 -> 繁体 的展开交给下面的上下文判别表，只有相邻字能唯一确定写法时才纳入。
   */
  var TRAD_ONEWAY =
    '臺台檯台髮发發发製制鬆松幹干乾干麵面' +
    '隻只衹只裡里藉借匯汇彙汇歷历曆历複复灣湾颱台';
  (function () {
    for (var j = 0; j + 1 < TRAD_ONEWAY.length; j += 2) {
      var oneTrad = TRAD_ONEWAY.charAt(j), oneSimp = TRAD_ONEWAY.charAt(j + 1);
      if (oneTrad === oneSimp) continue;
      if (TRAD_TO_SIMP[oneTrad] && TRAD_TO_SIMP[oneTrad] !== oneSimp) {
        throw new Error('rules.js: 繁体单向映射冲突 ' + oneTrad);
      }
      TRAD_TO_SIMP[oneTrad] = oneSimp;
    }
  })();

  /**
   * 一字多繁的上下文判别表（简体字键）：相邻的简体字能唯一确定繁体写法时，
   * 才把该繁体候选加入字符类——「台湾」->「臺灣」、「头发」->「頭髮」、「干部」->「幹部」。
   * 无法判定的场合（如单字规则「台」）保持原样，绝不全局折叠。
   * AFTER  本字 + 后一个简体字；BEFORE 前一个简体字 + 本字。
   */
  var TRAD_AMBIG_AFTER = {
    '台': { '湾': '臺', '北': '臺', '南': '臺', '中': '臺', '东': '臺', '西': '臺', '州': '臺', '商': '臺', '独': '臺', '币': '臺', '岛': '臺', '语': '臺', '军': '臺', '海': '臺', '风': '颱', '历': '檯' },
    '发': { '展': '發', '生': '發', '现': '發', '表': '發', '布': '發', '动': '發', '明': '發', '挥': '發', '射': '發', '出': '發', '散': '發', '觉': '發', '型': '髮', '剪': '髮', '愁': '發', '热': '發', '电': '發' },
    '干': { '净': '乾', '燥': '乾', '杯': '乾', '部': '幹', '事': '幹', '线': '幹', '活': '幹', '预': '幹' },
    '制': { '造': '製', '品': '製', '作': '製', '图': '製', '定': '製', '版': '製', '剂': '製', '服': '製' },
    '松': { '弛': '鬆', '散': '鬆' },
    '着': { '急': '著', '手': '著', '名': '著', '作': '著', '装': '著', '想': '著', '凉': '著' },
    '复': { '杂': '複', '印': '複', '核': '複', '数': '複', '选': '複', '写': '複' },
    '面': { '包': '麵', '条': '麵', '粉': '麵', '食': '麵', '团': '麵' },
    '只': { '是': '衹', '有': '衹', '要': '衹', '好': '衹', '能': '衹' },
    '里': { '面': '裡' },
    '汇': { '率': '匯', '总': '匯', '合': '匯', '款': '匯', '票': '匯', '报': '匯' },
    '历': { '史': '歷', '次': '歷', '程': '歷', '经': '歷', '练': '歷', '届': '歷', '时': '歷' },
    '借': { '口': '藉', '助': '藉', '鉴': '藉', '机': '藉' }
  };
  var TRAD_AMBIG_BEFORE = {
    '台': { '柜': '檯', '舞': '檯', '阳': '檯', '平': '臺' },
    '发': { '头': '髮', '理': '髮', '洗': '髮', '毛': '髮', '短': '髮', '长': '髮', '白': '髮', '秀': '髮' },
    '干': { '树': '幹', '能': '幹' },
    '汇': { '词': '彙', '字': '彙', '编': '彙' },
    '历': { '日': '曆', '月': '曆', '年': '曆', '农': '曆' },
    '松': { '放': '鬆', '轻': '鬆' },
    '着': { '显': '著' },
    '复': { '反': '覆', '回': '覆', '颠': '覆' },
    '面': { '泡': '麵', '拉': '麵', '拌': '麵', '汤': '麵', '便': '麵' },
    '只': { '一': '隻', '两': '隻', '几': '隻', '船': '隻' },
    '里': { '这': '裡', '那': '裡', '哪': '裡', '心': '裡', '家': '裡', '城': '裡', '村': '裡', '手': '裡' }
  };

  /**
   * 单字的规则源：存在繁体 / 简体等价字时输出字符类，否则原样转义。
   * prev / next 为规则文本里的相邻字（单字规则不传），仅用于一字多繁的上下文判别。
   */
  function charSource(ch, prev, next) {
    var simp = TRAD_TO_SIMP[ch];            // 规则字本身是繁体 -> 纳入简体
    var trads = SIMP_TO_TRADS[ch];          // 规则字是简体 -> 纳入繁体
    var ambig = null;
    if (next) ambig = TRAD_AMBIG_AFTER[ch] && TRAD_AMBIG_AFTER[ch][next];
    if (!ambig && prev) ambig = TRAD_AMBIG_BEFORE[ch] && TRAD_AMBIG_BEFORE[ch][prev];
    if (!simp && !trads && !ambig) return escapeRegExp(ch);
    var list = [ch];
    if (simp && list.indexOf(simp) < 0) list.push(simp);
    (trads || []).forEach(function (v) { if (list.indexOf(v) < 0) list.push(v); });
    if (ambig && list.indexOf(ambig) < 0) list.push(ambig);
    return '[' + list.map(escapeClassChar).join('') + ']';
  }

  /** 上下文排除词的宽松匹配源：允许繁体等价字，但不允许插符号 / 加括号（排除词要求紧邻） */
  function tolerantSource(word) {
    var chars = String(word).split('');
    return chars.map(function (ch, i) {
      return charSource(ch, chars[i - 1], chars[i + 1]);
    }).join('');
  }

  /**
   * 上下文排除词编译为锚定正则：head/tail 同时给出时才真正「紧邻」——
   *   notBefore 用 ('', '$')：前缀**结尾**是排除词才算紧邻；
   *   notAfter  用 ('^', '')：后缀**开头**是排除词才算紧邻。
   * 两侧都必须锚定：漏掉 '$' 会让「前文任意位置出现过排除词」都触发跳过
   * （「商业……机密」整段漏删），漏掉 '^' 同理。非法输入退回 null（不会误排除）。
   */
  function ctxRegexes(list, head, tail) {
    return (list || []).map(function (w) {
      try { return new RegExp(head + tolerantSource(w) + tail); } catch (e) { return null; }
    }).filter(Boolean);
  }

  /** 字面量规则源：字与字之间允许插入限量分隔符（反符号揉规则不动） */
  function literalSource(text) {
    var chars = String(text).split('');
    // 多字规则才传相邻字：一字多繁的繁体候选只有在上下文可判定时才出现，
    // 单字规则保持原样（「台」不会误伤「臺灣 / 櫃檯」）
    var charSrc = chars.length < 2
      ? [charSource(text)]
      : chars.map(function (ch, i) {
          return charSource(ch, chars[i - 1], chars[i + 1]);
        });
    var coreSrc = charSrc.join(SEP_SRC);
    // 括号包裹必须是「成对」的：规避写法常把敏感词单字或整词括起来（「内（部）」「【机密】」），
    // 命中时成对清除；但绝不吞「只来一半」的括号——「（涉密72007 年」这类写法里左括号另有语义，
    // 一旦吃掉左括号，句子就不通顺了（真实文档实测误伤： loses (）。故拆成三种完整形态，缺一即
    // 退回纯词匹配（宁可漏半个括号也不误伤）：
    //   A 整段包裹：OPEN core CLOSE（「【机密】」「(机密)」「（内部）」）
    //   B 词内开括号 + 收尾闭括号：词中某相邻位出现开括号、结尾出现闭括号（「内《部》」「内(部)」）
    //   C 纯词：core（无括号，或括号被字间分隔符吸收的内部配对——清除敏感字本身）
    var forms = [OPEN_SRC + SEP_SRC + coreSrc + SEP_SRC + CLOSE_SRC];
    if (chars.length >= 2) {
      for (var k = 0; k < chars.length - 1; k++) {
        var pieces = [charSrc[0]];
        for (var i = 1; i < chars.length; i++) {
          var seam = (i - 1 === k) ? (SEP_SRC + OPEN_SRC + SEP_SRC) : SEP_SRC;
          pieces.push(seam + charSrc[i]);
        }
        forms.push(pieces.join('') + SEP_SRC + CLOSE_SRC);
      }
    }
    forms.push(coreSrc);
    return '(?:' + forms.join('|') + ')';
  }

  /** ASCII 单词字符（整词匹配的边界判定用） */
  var WORD_CHAR_RE = /[0-9A-Za-z_]/;

  /**
   * 归一化文本并保留「归一化下标 → 原始下标」映射，供命中后按原始坐标精准回删：
   *  - 剔除零视觉宽度字符（零宽规避字符＋ NBSP / 各类空格变体、行段分隔符）；
   *  - 全角 → 半角（ＡＩ → AI、２０２４ → 2024）。
   * map 长度为归一化串长 + 1（末位为原文长度哨兵）；
   * gap[i]=true 表示归一化串第 i 个字符前有被丢弃的空白 / 不可见字符（整词边界判定用）。
   */
  function normalizeWithMap(text) {
    var norm = '';
    var map = [];
    var gap = [];
    var pending = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (GAP_RE.test(ch)) { pending++; continue; }
      var folded = FULLWIDTH[ch];
      if (folded === undefined) folded = ch;
      norm += folded;
      map.push(i);
      gap.push(pending > 0);
      pending = 0;
    }
    map.push(text.length);
    gap.push(pending > 0);
    return { norm: norm, map: map, gap: gap };
  }

  /** 规则模式的归一化（与正文同一套规则，保证两侧一致） */
  function normalizePattern(text) {
    return normalizeWithMap(String(text)).norm;
  }

  /** 排除上下文列表归一化：兼容字符串（逗号分隔）与数组两种写法 */
  function toCtxList(v) {
    if (!v) return [];
    var arr = Array.isArray(v) ? v : String(v).split(',');
    var out = [];
    arr.forEach(function (s) {
      var nrm = normalizePattern(s);
      if (nrm && out.indexOf(nrm) === -1) out.push(nrm);
    });
    return out;
  }

  /**
   * 创建规则引擎
   * @param {Object} cfg
   *   cfg.rules         [{ text, type:'text'|'regex', enabled, whole?, notBefore?, notAfter? }]
   *                      whole：整词匹配（仅对纯 ASCII 字母/数字规则生效，防英文误伤）；
   *                      notBefore / notAfter：命中紧邻这些词时跳过（防误伤），字符串或字符串数组
   *   cfg.scope         'all' | 'first' | 'firstlast'   全文 / 仅首行（首段）/ 仅首行+尾行
   *   cfg.action        'delete' | 'mask' | 'custom'
   *   cfg.custom        action==='custom' 时的替换文本
   *   cfg.caseSensitive 大小写敏感（默认不敏感）
   *   注：聚焦中文文档，按子串匹配（中文无所谓整词 / 大小写）；正则规则按原样编译
   */
  function createEngine(cfg) {
    var rules = (cfg.rules || []).filter(function (r) {
      return r && r.enabled !== false && r.text;
    });

    var flags = 'g' + (cfg.caseSensitive ? '' : 'i');
    var action = cfg.action || 'delete';
    var custom = cfg.custom == null ? '' : String(cfg.custom);
    var scope = cfg.scope || 'all';

    var compiled = [];
    var anyNormalized = false; // 有规则模式被归一化改写（含不可见字符 / 全角 / 空格）
    var anyExclusions = false; // 有规则配置了上下文排除
    var anyWhole = false;      // 有规则开启整词匹配
    var anySep = false;        // 有字面量规则长度 >= 2（需考虑符号插字规避）
    rules.forEach(function (r) {
      var src;
      var label = String(r.label || r.text);
      var normalized = null;
      if (r.type === 'regex') {
        src = r.text;
      } else {
        normalized = normalizePattern(r.text);
        if (normalized !== r.text) anyNormalized = true;
        src = literalSource(normalized);
        if (normalized.length >= 2) anySep = true;
      }
      var notBefore = toCtxList(r.notBefore);
      var notAfter = toCtxList(r.notAfter);
      if (notBefore.length || notAfter.length) anyExclusions = true;
      // 排除词同样容忍繁体写法（「商業銀行」也要被「商业」排除掉），且要求紧邻：
      // notBefore 锚定前缀结尾（$），notAfter 锚定后缀开头（^）
      var notBeforeRe = ctxRegexes(notBefore, '', '$');
      var notAfterRe = ctxRegexes(notAfter, '^', '');
      // 整词匹配仅对纯 ASCII 字母 / 数字规则有意义：命中两侧不得紧邻 ASCII 单词字符，
      // 含中文的规则本就以汉字为界，无需（也无法）整词化
      var whole = r.whole === true &&
        /^[0-9A-Za-z_]+$/.test(normalized != null ? normalized : String(r.text));
      if (whole) anyWhole = true;
      try {
        compiled.push({
          re: new RegExp(src, flags),
          label: label,
          whole: whole,
          notBefore: notBefore,
          notAfter: notAfter,
          notBeforeRe: notBeforeRe,
          notAfterRe: notAfterRe
        });
      } catch (e) {
        // 非法正则忽略
      }
    });

    // 长词优先：避免「内部」先命中导致「内部资料」整体漏删（重叠词场景）
    compiled.sort(function (a, b) { return b.label.length - a.label.length; });

    // 合并为单个正则：原实现逐条规则对全文做一次 replace（默认词库 20+ 条 = 20+ 次全文扫描），
    // 改为单次 replace 完成全部匹配，匹配阶段耗时约与规则数成反比（见优化建议 P1-5）。
    // 各规则标志位一致（均由同一 cfg 推导），故可直接拼接；自定义动作沿用字面量替换，保持原语义。
    //
    // 注意：这里必须用「非捕获组 (?:...)」拼接。早期实现用捕获组 (rule) 拼接并靠"第几个捕获组有值"
    // 反查规则，会把每条规则额外嵌进一层分组，从而改变规则内部反向引用（\1、\2…）的指向——
    // 例如规则 (.)\1 拼成 ((.)\1) 后，\1 变成对自身未闭合分组的引用（匹配空串），语义被破坏。
    // 改为非捕获组拼接后，规则内部的分组编号保持原样；命中后再用各规则自身正则回测定位标签。
    var combined = null;
    if (compiled.length) {
      try {
        var combinedSrc = compiled.map(function (c) { return '(?:' + c.re.source + ')'; }).join('|');
        combined = new RegExp(combinedSrc, flags);
      } catch (e) { combined = null; }
    }

    function replacementFor(matchText) {
      if (action === 'delete') return '';
      if (action === 'mask') return smartMask(matchText);
      return custom;
    }

    /** 智能打码：号码 / 账号类保留头尾可读，词语类整体遮蔽。
     *  设计原则——① 长数字串（手机 / 身份证 / 卡号）保留头尾，正文仍读得出
     *  「138****5678」这类形式，便于核对而看不到全貌；② 英文 / 混合串同理
     *  保留首尾 2 字符；③ 邮箱遮用户名保域名（a***@qq.com）；
     *  ④ 含中文的命中一律整体打码，字数与原文对应——中文词打半截反而泄露语义。 */
    function smartMask(t) {
      var s = String(t);
      if (!s) return '***';
      // 邮箱：遮用户名，保留域名（域名保留可让读者知道这是邮箱，又不至于完全失读）
      var at = s.indexOf('@');
      if (at > 0) return s.charAt(0) + '***' + s.slice(at);
      // 含中文：整体打码，星号个数与字数对应
      if (/[\u4e00-\u9fff]/.test(s)) return stars(s.length);
      // 数字（可含末位 X 的身份证）：11 位以上头 3 尾 4（手机号 / 身份证 / 长卡号），6-10 位头 2 尾 2
      if (/^[0-9]+X?$/i.test(s)) {
        if (s.length >= 11) return s.slice(0, 3) + stars(s.length - 7) + s.slice(-4);
        if (s.length >= 6) return s.slice(0, 2) + stars(s.length - 4) + s.slice(-2);
        return stars(s.length);
      }
      // 其他（英文 / 混合 / IP）：头 2 尾 2
      if (s.length >= 6) return s.slice(0, 2) + stars(s.length - 4) + s.slice(-2);
      return stars(s.length);
    }

    function stars(n) { return new Array(n + 1).join('*'); }

    /** 上下文排除：命中区间紧邻 notBefore / notAfter 指定词时跳过（避免误伤相邻常用词） */
    function contextExcluded(norm, s, e, rule) {
      var i;
      if (rule.notBeforeRe && rule.notBeforeRe.length) {
        var pre = norm.slice(0, s);
        for (i = 0; i < rule.notBeforeRe.length; i++) {
          if (rule.notBeforeRe[i].test(pre)) return true;
        }
      }
      if (rule.notAfterRe && rule.notAfterRe.length) {
        var post = norm.slice(e);
        for (i = 0; i < rule.notAfterRe.length; i++) {
          if (rule.notAfterRe[i].test(post)) return true;
        }
      }
      return false;
    }

    /** 整词边界：命中两侧不得紧邻 ASCII 单词字符；被折叠的空白 / 不可见字符视为天然边界 */
    function wholeBroken(norm, gap, s, e, rule) {
      if (!rule.whole) return false;
      if (s > 0 && !gap[s] && WORD_CHAR_RE.test(norm.charAt(s - 1))) return true;
      if (e < norm.length && !gap[e] && WORD_CHAR_RE.test(norm.charAt(e))) return true;
      return false;
    }

    /** 用「规则自身正则回测」定位命中了哪一条（组合正则用非捕获组拼接，无法再由捕获组反查） */
    function identifyRule(matchedText) {
      for (var i = 0; i < compiled.length; i++) {
        var c = compiled[i];
        c.re.lastIndex = 0;
        var mm = c.re.exec(matchedText);
        if (mm && mm[0] === matchedText) return c;
      }
      return null;
    }

    /**
     * 在归一化文本上收集命中区间（归一化坐标）
     * - 空匹配保护，避免 (a*) 之类规则死循环；
     * - 命中的规则被「上下文排除」或「整词边界」否决时，从命中起点 +1 继续扫描，
     *   保证同位置其他规则仍可命中（如「商业银行」排除「银行」后，其他规则仍可处理剩余文本）。
     */
    function collectSpans(norm, gap) {
      var spans = [];
      if (combined) {
        combined.lastIndex = 0;
        var m;
        while ((m = combined.exec(norm)) !== null) {
          if (m[0] === '') { combined.lastIndex++; continue; }
          var s = m.index, e = s + m[0].length;
          var rule = identifyRule(m[0]);
          if (rule && (contextExcluded(norm, s, e, rule) || wholeBroken(norm, gap, s, e, rule))) {
            combined.lastIndex = s + 1;
            continue;
          }
          spans.push({ s: s, e: e, label: rule ? rule.label : m[0] });
        }
        return spans;
      }
      // 兜底：组合正则不可用（理论上不会触发）时逐条扫描，已占用区间让位
      var taken = [];
      compiled.forEach(function (c) {
        c.re.lastIndex = 0;
        var mm;
        while ((mm = c.re.exec(norm)) !== null) {
          if (mm[0] === '') { c.re.lastIndex++; continue; }
          var s2 = mm.index, e2 = s2 + mm[0].length;
          var clash = taken.some(function (t) { return s2 < t.e && t.s < e2; });
          if (clash) continue;
          if (contextExcluded(norm, s2, e2, c) || wholeBroken(norm, gap, s2, e2, c)) continue;
          taken.push({ s: s2, e: e2 });
          spans.push({ s: s2, e: e2, label: c.label });
        }
      });
      spans.sort(function (a, b) { return a.s - b.s; });
      return spans;
    }

    /** 快速路径：规则无归一化 / 排除 / 整词项、正文无需折叠时沿用整串 replace（与旧版逐字节兼容） */
    function applyFast(text, repl, first, last) {
      var hits = 0;
      var hitChars = 0;
      var matched = [];
      if (!combined) {
        var out0 = text;
        compiled.forEach(function (c) {
          c.re.lastIndex = 0;
          out0 = out0.replace(c.re, function () {
            var m = arguments[0];
            hits++;
            hitChars += m.length;
            if (matched.indexOf(c.label) === -1) matched.push(c.label);
            return repl(m, c.label);
          });
        });
        return { text: out0, hits: hits, hitChars: hitChars, matched: matched, atFirst: first, atLast: last };
      }
      var out = text.replace(combined, function () {
        var m = arguments[0];
        var label = m;
        for (var i = 0; i < compiled.length; i++) {
          var c = compiled[i];
          c.re.lastIndex = 0;
          var mm = c.re.exec(m);
          if (mm && mm[0] === m) { label = c.label; break; }
        }
        hits++;
        hitChars += m.length;
        if (matched.indexOf(label) === -1) matched.push(label);
        return repl(m, label);
      });
      return { text: out, hits: hits, hitChars: hitChars, matched: matched, atFirst: first, atLast: last };
    }

    /**
     * 对一段文本执行替换
     * @param {string} text
     * @param {boolean} isFirst 是否为首行 / 首段（首个含内容的行或段落）
     * @param {boolean} isLast  是否为尾行 / 尾段（最后一个含内容的行或段落）
     * @param {Function} [replaceFn] 自定义替换回调 (matchedText, ruleLabel) => string
     * @returns {{ text: string, hits: number, matched: string[], atFirst: boolean, atLast: boolean }}
     */
    function apply(text, isFirst, isLast, replaceFn) {
      var first = isFirst === true;
      var last = isLast === true;
      if (!text) return { text: text, hits: 0, hitChars: 0, matched: [], atFirst: first, atLast: last };
      if (scope === 'first' && !first) return { text: text, hits: 0, hitChars: 0, matched: [], atFirst: first, atLast: last };
      if (scope === 'firstlast' && !first && !last) return { text: text, hits: 0, hitChars: 0, matched: [], atFirst: first, atLast: last };

      var repl = (typeof replaceFn === 'function') ? replaceFn : replacementFor;
      if (!compiled.length) return { text: text, hits: 0, hitChars: 0, matched: [], atFirst: first, atLast: last };

      // 快速路径：无需归一化、无排除 / 整词规则时保持旧版行为与性能
      if (!anyNormalized && !anyExclusions && !anyWhole && !NORM_SCAN_RE.test(text) &&
          !(anySep && SEP_SCAN_RE.test(text))) {
        return applyFast(text, repl, first, last);
      }

      // 归一化路径：在折叠后的文本上匹配，命中区间映射回原始坐标后回删 / 替换；
      // 未命中内容按原字节保留，不引入额外格式变动
      var nr = normalizeWithMap(text);
      var norm = nr.norm;
      var map = nr.map;
      var spans = collectSpans(norm, nr.gap);

      var out = '';
      var cursor = 0;
      var hits = 0;
      var hitChars = 0;
      var matched = [];
      spans.forEach(function (sp) {
        var os = map[sp.s];
        // 区间右端取「最后一个命中字符」的原文末尾：夹在命中字符之间的不可见字符
        // 随命中一并清除，而区间外的空白 / 分隔符原样保留
        var oe = map[sp.e - 1] + 1;
        out += text.slice(cursor, os) + repl(norm.slice(sp.s, sp.e), sp.label);
        cursor = oe;
        hits++;
        hitChars += norm.slice(sp.s, sp.e).length;
        if (matched.indexOf(sp.label) === -1) matched.push(sp.label);
      });
      out += text.slice(cursor);
      return { text: out, hits: hits, hitChars: hitChars, matched: matched, atFirst: first, atLast: last };
    }

    /** 仅统计，不修改 */
    function scan(text, isFirst, isLast) {
      var r = apply(text, isFirst, isLast);
      return { hits: r.hits, hitChars: r.hitChars, matched: r.matched, atFirst: r.atFirst, atLast: r.atLast };
    }

    return {
      apply: apply,
      scan: scan,
      ruleCount: compiled.length,
      scope: scope
    };
  }

  /** 去除替换后残留的多余空白（可选后处理） */
  function tidy(text) {
    if (!text) return text;
    return text
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/^\s*\n{3,}/gm, '\n\n');
  }

  global.DWRRules = {
    DEFAULT_PRESETS: DEFAULT_PRESETS,
    PII_PRESETS: PII_PRESETS,
    createEngine: createEngine,
    escapeRegExp: escapeRegExp,
    tidy: tidy,
    normalizeWithMap: normalizeWithMap,
    normalizePattern: normalizePattern
  };
})(window);
