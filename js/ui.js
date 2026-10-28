(/**
 * ui.js —— 通用 UI 交互：更多 ▾ 浮层与 data-tip 悬停气泡
 * 不含业务状态，被 app.js 通过 window.DWRUi 引用
 */
(function (root) {
  'use strict';

  /* 「更多 ▾」浮层通用逻辑：点击开合、Esc 关闭并回焦、点外面关闭、点内部不冒泡。
     工具栏 / 扫描结果卡 / 词库卡三处复用同一实现（app.js 只调用）。 */
  function bindMoreMenu(btn, pop) {
    if (!btn || !pop) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = pop.hidden;
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Esc 关闭浮层，并让焦点回到触发按钮（WCAG 1.4.13 相关）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !pop.hidden) {
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () {
      if (!pop.hidden) {
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------------- 悬停 / 聚焦浮窗（说明气泡） ----------------
     说明文案统一挂在 data-tip 上，由这一个节点渲染。用事件委托而不是给每个控件绑监听：
     按钮众多且表格行、词条是动态生成的，委托一次覆盖全部；也能覆盖被禁用的按钮
     （禁用按钮上 hover 仍会冒泡，原生 title= 在部分浏览器里反而不弹）。
     位置按元素包围盒计算，贴近视口顶部时翻到下方显示，气泡始终不出屏。 */
  var tipNode = null;
  var tipTarget = null;

  function tipEl() {
    if (!tipNode) {
      tipNode = document.createElement('div');
      tipNode.id = 'dwrTip';
      tipNode.setAttribute('role', 'tooltip');
      (document.body || document.documentElement).appendChild(tipNode);
    }
    return tipNode;
  }

  /** 文案要么写在 data-tip 上，要么由 JS 落成 title（表格行的路径等），两者都取 */
  function tipText(el) {
    if (!el || !el.getAttribute) return '';
    var t = el.getAttribute('data-tip');
    if (!t) t = el.getAttribute('title');
    return t ? String(t).trim() : '';
  }

  function showTip(target) {
    var text = tipText(target);
    if (!text || !target.getBoundingClientRect) { hideTip(); return; }
    var r = target.getBoundingClientRect();
    // 宿主已隐藏或移除（宽高为 0）时不弹，避免气泡指向空白还挂在屏上
    if (!r.width && !r.height) { hideTip(); return; }
    var node = tipEl();
    tipTarget = target;
    node.textContent = text;
    // 先量再摆：display 后立刻读一次尺寸，避免气泡宽度未知时算错水平位置
    node.style.left = '0px';
    node.style.top = '0px';
    node.classList.add('tip-on');
    var nw = node.offsetWidth;
    var nh = node.offsetHeight;
    var pad = 8;
    var cx = r.left + r.width / 2;
    var left = cx - nw / 2;
    if (left < pad) left = pad;
    if (left + nw > window.innerWidth - pad) left = window.innerWidth - pad - nw;
    if (left < pad) left = pad;
    var above = r.top - nh - 10;
    if (above < pad) {
      node.style.top = (r.bottom + 10) + 'px';
      node.classList.add('tip-down');
      node.classList.remove('tip-up');
    } else {
      node.style.top = above + 'px';
      node.classList.add('tip-up');
      node.classList.remove('tip-down');
    }
    node.style.left = Math.round(left) + 'px';
    // 箭头对准控件中心，离气泡两端太近时收进来，避免溢出圆角
    var arrow = cx - left;
    arrow = Math.max(12, Math.min(arrow, nw - 12));
    node.style.setProperty('--tip-arrow-left', Math.round(arrow) + 'px');
  }

  function hideTip() {
    tipTarget = null;
    if (tipNode) tipNode.classList.remove('tip-on');
  }

  /** 从触发点往上找最近的、带说明文案的元素 */
  function tipHost(start) {
    var el = start;
    while (el && el.getAttribute) {
      if (tipText(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function bindTips() {
    document.addEventListener('pointerover', function (e) {
      var el = e.target;
      // 已经是当前气泡的主人（或在气泡内部）时不重排，避免子元素间移动导致闪烁
      if (tipTarget && el && tipTarget.contains && tipTarget.contains(el)) return;
      var host = tipHost(el);
      if (host) showTip(host); else hideTip();
    });
    document.addEventListener('pointerout', function (e) {
      if (!tipTarget) return;
      var to = e.relatedTarget;
      if (to && tipTarget.contains && tipTarget.contains(to)) return;
      if (to && tipHost(to) === tipTarget) return;
      hideTip();
    });
    // 键盘用户：聚焦到带说明的控件 / 复选框时同样给出解释
    document.addEventListener('focusin', function (e) {
      var host = tipHost(e.target);
      // 表格行等大容器获得焦点时不必弹，避免大面积遮挡
      if (host && host.tagName !== 'TR') showTip(host); else hideTip();
    });
    document.addEventListener('focusout', hideTip);
    // 点击后收起气泡：带说明的宿主常随点击被隐藏或移除（如引导条「知道了」、
    // 行内移除按钮），此后 pointerout / focusout 都不会再触发，气泡会一直挂着
    document.addEventListener('click', hideTip);
    root.addEventListener('scroll', hideTip, true);
    root.addEventListener('resize', hideTip);
    // Esc 提示：先收气泡，再让其他 Esc 逻辑（如收起扫描结果）继续
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideTip();
    });
  }

  root.DWRUi = { bindMoreMenu: bindMoreMenu, bindTips: bindTips };
}))(typeof window !== 'undefined' ? window : this);
