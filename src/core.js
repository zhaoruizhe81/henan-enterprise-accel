/* ============================================================
 * 河南企业登记 · 填表加速 —— 核心逻辑
 *
 * 这份文件不含 userscript 头，可以直接用 <script> 注入，
 * 也可以由 build.sh 拼接头部生成 userscript 成品。
 * ============================================================ */

(function () {
  'use strict';

  /* ============================================================
   * 配置
   * ============================================================ */
  const CFG = {
    verbose: true,
    // 缓存规则：正则 -> 有效期（毫秒）
    // 词形检查永久有效，查重类 10 分钟，代码表永久
    rules: [
      { re: /checkComplexWord/, ttl: 365 * 24 * 3600 * 1000 },
      { re: /cnkiRepeakCheck/, ttl: 10 * 60 * 1000 },
      { re: /checkForbidWords/, ttl: 10 * 60 * 1000 },
      { re: /\/code\/get[A-Z]/, ttl: 365 * 24 * 3600 * 1000 },
      { re: /getStreetCodes|getIndustryList|getAllChildEntType/, ttl: 365 * 24 * 3600 * 1000 },
      { re: /getCountryNameByCode|getCommonIndustryType/, ttl: 365 * 24 * 3600 * 1000 }
    ],
    // 绝不缓存：写操作与依赖完整表单状态的校验
    blocklist: [
      /verification\.action/,
      /operationData\.action/,
      /save[A-Z]/,
      /delete[A-Z]/,
      /submit/
    ],
    snapshotInterval: 3000,
    ns: 'hea_v1'
  };

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const LS = window.localStorage;
  const log = (...a) => { if (CFG.verbose) console.info('[HEA]', ...a); };

  /* ============================================================
   * 1. ajax 缓存层
   * ============================================================ */
  const mem = Object.create(null);
  const stats = { hit: 0, miss: 0, savedMs: 0 };

  function norm(url) {
    let s = String(url);
    s = s.replace(/([?&])(t|random|r|_|csrfToken|frameUserId)=[^&]*/g, '');
    // cnkiRepeakCheck.action?0.6598912 这种裸随机数
    s = s.replace(/\.action\?\d+(\.\d+)?(&|$)/, '.action?');
    return s.replace(/[?&]+$/, '').replace(/\?&/g, '?').replace(/&{2,}/g, '&');
  }

  function pickRule(url) {
    if (CFG.blocklist.some(re => re.test(url))) return null;
    return CFG.rules.filter(r => r.re.test(url))[0] || null;
  }

  function readCache(key, ttl) {
    const m = mem[key];
    if (m && Date.now() - m.t < ttl) return m.v;
    try {
      const raw = LS.getItem(CFG.ns + '|' + key);
      if (!raw) return undefined;
      const o = JSON.parse(raw);
      if (Date.now() - o.t < ttl) { mem[key] = o; return o.v; }
    } catch (e) {}
    return undefined;
  }

  function writeCache(key, val) {
    const o = { t: Date.now(), v: val };
    mem[key] = o;
    try { LS.setItem(CFG.ns + '|' + key, JSON.stringify(o)); } catch (e) {}
  }

  let ajaxHooked = false;

  function hookAjax() {
    const $ = W.jQuery;
    if (!$ || !$.ajax || ajaxHooked) return ajaxHooked;

    const orig = $.ajax;

    $.ajax = function (url, options) {
      let s;
      if (url && typeof url === 'object') s = url;
      else s = Object.assign({}, options || {}, { url: url });

      // 只处理同步请求里的只读校验。异步请求本来就不阻塞，没必要碰
      if (s && s.async === false && s.url) {
        const rule = pickRule(s.url);
        if (rule) {
          const key = norm(s.url);
          const cached = readCache(key, rule.ttl);
          if (cached !== undefined) {
            stats.hit++;
            // 同步 ajax 的 success 本来就在 send() 返回前执行，
            // 所以这里同步调用，调用方看到的行为和真实请求一致
            try { if (typeof s.success === 'function') s.success(cached, 'success', { status: 200 }); } catch (e) {}
            try { if (typeof s.complete === 'function') s.complete({ status: 200 }, 'success'); } catch (e) {}
            return { done() { return this; }, fail() { return this; }, always() { return this; } };
          }

          stats.miss++;
          const t0 = performance.now();
          const wrapped = Object.assign({}, s, {
            success: function (d, st, x) {
              stats.savedMs += performance.now() - t0;
              try { if (d !== undefined && d !== null) writeCache(key, d); } catch (e) {}
              if (typeof s.success === 'function') s.success(d, st, x);
            }
          });
          return orig.call($, wrapped);
        }
      }
      return orig.apply($, arguments);
    };

    $.ajax.__hea = true;
    ajaxHooked = true;
    log('ajax 缓存层已挂载');
    return true;
  }

  // jQuery 是异步加载的，轮询等待
  const ajaxTimer = setInterval(() => { if (hookAjax()) clearInterval(ajaxTimer); }, 200);

  /* ============================================================
   * 2. 清掉源码里的 debugger
   * ============================================================ */
  // topnet.js 的 checkNameFlow 和 toOtherSystem 里各有一句 debugger;
  // 开发者工具开着时，每次调用都会断在那里
  const dbgTimer = setInterval(() => {
    if (typeof W.dealCheckNameFlow === 'function' && typeof W.checkNameFlow === 'function' && !W.checkNameFlow.__hea) {
      W.checkNameFlow = function (base, busiType, nameId, busiId, ckFlag, ywlbSign,
                                  personName, entMatterCode, yjsCodes, obj,
                                  checkSameThing, newWindowUrl) {
        W.dealCheckNameFlow(base, busiType, nameId, busiId, ckFlag, ywlbSign,
                            personName, entMatterCode, yjsCodes, obj,
                            checkSameThing, newWindowUrl, null, null);
      };
      W.checkNameFlow.__hea = true;
      log('checkNameFlow 已替换为无 debugger 版本');
      clearInterval(dbgTimer);
    }
  }, 300);

  /* ============================================================
   * 3. 表单快照
   * ============================================================ */
  const snapKey = CFG.ns + '|snap|' + location.pathname +
    location.search.replace(/[?&]csrfToken=[^&]*/g, '');

  function collect() {
    const o = {};
    document.querySelectorAll('input[name],select[name],textarea[name]').forEach(el => {
      if (el.name === 'csrfToken') return;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) o[el.name] = el.value;
      } else {
        o[el.name] = el.value;
      }
    });
    return o;
  }

  function saveSnap() {
    const o = collect();
    if (!Object.keys(o).length) return;
    try { LS.setItem(snapKey, JSON.stringify({ at: Date.now(), data: o })); } catch (e) {}
  }

  function restoreSnap() {
    let snap;
    try {
      const raw = LS.getItem(snapKey);
      if (!raw) return;
      snap = JSON.parse(raw);
    } catch (e) { return; }

    let n = 0;
    Object.keys(snap.data || {}).forEach(name => {
      document.querySelectorAll('[name="' + name + '"]').forEach(el => {
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.value === snap.data[name]) { el.checked = true; n++; }
        } else if (!el.value && !el.readOnly) {
          el.value = snap.data[name];
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          n++;
        }
      });
    });

    if (n) {
      const min = Math.round((Date.now() - snap.at) / 60000);
      log('恢复 ' + n + ' 个字段（快照 ' + min + ' 分钟前）');
    }
  }

  setInterval(saveSnap, CFG.snapshotInterval);
  window.addEventListener('beforeunload', saveSnap);
  setTimeout(restoreSnap, 1000);
  setTimeout(restoreSnap, 3000);

  /* ============================================================
   * 4. 登录超时页：掐掉跳转循环
   * ============================================================ */
  if (/登录超时/.test(document.title)) {
    for (let i = 1; i < 9999; i++) window.clearInterval(i);
    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle('#hea-tip{position:fixed;top:0;left:0;right:0;z-index:999999;' +
          'background:#c62828;color:#fff;padding:10px 16px;font:14px/1.5 -apple-system,sans-serif;text-align:center}');
      }
    } catch (e) {}
    const tip = document.createElement('div');
    tip.id = 'hea-tip';
    if (!document.getElementById('hea-tip-style')) {
      tip.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;' +
        'background:#c62828;color:#fff;padding:10px 16px;font:14px/1.5 -apple-system,sans-serif;text-align:center';
    }
    tip.innerHTML = '会话已失效，自动跳转已暂停。' +
      '<a href="/index.action" style="color:#ffd54f;margin-left:8px">点这里重新登录</a>';
    document.body.appendChild(tip);
    log('检测到登录超时页，已拦截自动跳转');
  }

  /* ============================================================
   * 5. 对外接口
   * ============================================================ */
  W.__hea = {
    stats, norm,
    config: CFG,
    clear() {
      Object.keys(mem).forEach(k => delete mem[k]);
      const keys = [];
      for (let i = 0; i < LS.length; i++) {
        const k = LS.key(i);
        if (k && k.indexOf(CFG.ns + '|') === 0) keys.push(k);
      }
      keys.forEach(k => LS.removeItem(k));
      log('缓存已清空，共 ' + keys.length + ' 条');
      return keys.length;
    },
    dump() { console.table(stats); }
  };

  log('装载完成，控制台输入 __hea.dump() 看命中统计，__hea.clear() 清缓存');
})();
