/* 景深对账台 · 界面（dof-ledger）
 * 依赖 window.AppCore（core.js）。所有展示数字都来自同一次 analyze() 的结果。
 */
(function () {
  'use strict';
  const C = window.AppCore;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'dof-ledger:v1';

  const state = { res: null, checks: [], errors: [], warnings: [], sel: 0, exportCount: 0, renders: 0 };

  /* ── 格式化 ───────────────────────────────────────── */
  const D = (m) => C.fmtDist(m);                  // 距离（对外 m，极小值 mm）
  const L = (mm) => C.fmtMm(mm);                  // 长度（mm/µm）
  const P2 = (x) => C.fmtPct(x, 2);
  const P3 = (x) => C.fmtPct(x, 3);
  const N2 = (x) => (isFinite(x) ? (Math.round(x * 100) / 100).toFixed(2) : '—');
  const N1 = (x) => (isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');
  const N3 = (x) => (isFinite(x) ? (Math.round(x * 1000) / 1000).toFixed(3) : '—');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const F = (x) => 'f/' + (isFinite(x) ? (Math.round(x * 100) / 100).toFixed(2) : '—');
  const PILL = { cover: 'ok', near: 'tight', far: 'tight', both: 'fail' };
  const pillHTML = (cov, label) => '<span class="pill ' + PILL[cov] + '">' + esc(label) + '</span>';

  function toast(msg) {
    let t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:26px;background:#161b22;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;z-index:99;opacity:0;transition:opacity .18s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.opacity = '0'; }, 1900);
  }

  /* ── 下拉与表单 ───────────────────────────────────── */
  function fillSelects() {
    $('cocMode').innerHTML = C.COC_MODES.map(function (m) {
      return '<option value="' + m.id + '">' + esc(m.name) + '</option>';
    }).join('');
    $('refSensor').innerHTML = C.SENSORS.filter(function (s) { return s.id !== 'custom'; }).map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
    }).join('');
    $('scenario').innerHTML = '<option value="">（选择场景）</option>' + C.scenarios.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
    }).join('');
  }

  function sensorOptions(cur) {
    return C.SENSORS.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === cur ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
  }

  function readInput() {
    const rows = Array.prototype.slice.call($('rows').querySelectorAll('.item')).map(function (el) {
      const g = function (k) { const e = el.querySelector('.' + k); return e ? e.value : ''; };
      return { name: g('nm'), sensor: g('sn'), f: g('f'), N: g('N'), s: g('s') };
    });
    return {
      coc: { mode: $('cocMode').value, px: $('cocPx').value, c: $('cocCustom').value },
      lambda: $('lambda').value,
      refSensor: $('refSensor').value,
      solveF: $('solveF').value,
      customSensor: { w: $('csW').value, h: $('csH').value },
      target: { near: $('tNear').value, far: $('tFar').value, farInf: $('tFarInf').checked },
      rows: rows
    };
  }

  function rowHTML(it, i) {
    const v = function (x) { return esc(x === null || x === undefined ? '' : x); };
    return '<div class="item" data-i="' + i + '">' +
      '<div class="itemhead">' +
      '<input type="text" class="nm" value="' + v(it.name) + '" aria-label="方案名称">' +
      '<select class="sn" aria-label="画幅">' + sensorOptions(it.sensor) + '</select>' +
      '<button type="button" class="tiny" data-dup="' + i + '">复制</button>' +
      '<button type="button" class="tiny" data-del="' + i + '">删</button>' +
      '</div>' +
      '<div class="grid4">' +
      '<label>焦距 mm<input type="text" class="f" value="' + v(it.f) + '"></label>' +
      '<label>光圈 f/<input type="text" class="N" value="' + v(it.N) + '"></label>' +
      '<label>对焦距离 m<input type="text" class="s" value="' + v(it.s) + '"></label>' +
      '</div></div>';
  }

  function writeInput(inp) {
    $('cocMode').value = (inp.coc && inp.coc.mode) || 'diag1500';
    $('cocPx').value = inp.coc && inp.coc.px !== undefined ? inp.coc.px : 6000;
    $('cocCustom').value = inp.coc && inp.coc.c !== undefined ? inp.coc.c : 0.029;
    $('lambda').value = inp.lambda;
    $('refSensor').value = inp.refSensor;
    $('solveF').value = inp.solveF === undefined ? 50 : inp.solveF;
    $('csW').value = inp.customSensor ? inp.customSensor.w : 36;
    $('csH').value = inp.customSensor ? inp.customSensor.h : 24;
    $('tNear').value = inp.target.near;
    $('tFar').value = inp.target.far;
    $('tFarInf').checked = !!inp.target.farInf;
    $('rows').innerHTML = inp.rows.map(rowHTML).join('');
    $('rowCount').textContent = inp.rows.length + ' 个方案';
    toggleCond();
  }

  function toggleCond() {
    const m = $('cocMode').value;
    $('wrapPx').classList.toggle('hidden', m !== 'pixel');
    $('wrapCoc').classList.toggle('hidden', m !== 'custom');
    $('tFar').disabled = $('tFarInf').checked;
  }

  function markBad(errors) {
    Array.prototype.slice.call(document.querySelectorAll('input.bad')).forEach(function (e) { e.classList.remove('bad'); });
    const globalMap = {
      lambda: 'lambda', solveF: 'solveF', refSensor: 'refSensor',
      'coc.px': 'cocPx', 'coc.c': 'cocCustom',
      'customSensor.w': 'csW', 'customSensor.h': 'csH',
      'target.near': 'tNear', 'target.far': 'tFar'
    };
    errors.forEach(function (e) {
      let el = null;
      if (e.row > 0) {
        const box = $('rows').querySelector('.item[data-i="' + (e.row - 1) + '"]');
        if (box) el = box.querySelector('.' + (e.field === 'name' ? 'nm' : e.field));
      } else if (globalMap[e.field]) el = $(globalMap[e.field]);
      else if (e.field === 'rows') el = $('rows');
      if (el) el.classList.add('bad');
    });
  }

  /* ── 主计算 ───────────────────────────────────────── */
  function compute() {
    const raw = readInput();
    const nm = C.normalize(raw);
    state.errors = nm.errors;
    state.warnings = nm.warnings;
    markBad(nm.errors);
    if (!nm.ok) {
      state.res = null; state.checks = [];
      $('errors').innerHTML = '<div class="errbox"><b>有 ' + nm.errors.length + ' 处输入要改：</b><ul class="tight">' +
        nm.errors.map(function (e) { return '<li>' + esc(e.msg) + '</li>'; }).join('') + '</ul></div>';
      $('headline').textContent = '先把上面标红的输入改对，本页会立刻重算。';
      $('kpis').innerHTML = '';
      $('warnBox').innerHTML = '';
      $('revTag').textContent = '';
      $('reverse').innerHTML = '<p class="muted">等待合法输入</p>';
      $('planBody').innerHTML = '<tr><td colspan="11" class="muted">等待合法输入</td></tr>';
      $('detailName').textContent = '';
      $('detailBody').innerHTML = '<p class="muted">—</p>';
      $('lawBody').innerHTML = '<p class="muted">—</p>';
      $('insights').innerHTML = '';
      $('sensBody').innerHTML = '';
      $('steps').innerHTML = '';
      $('limits').innerHTML = '';
      $('checks').innerHTML = '';
      $('checkTag').textContent = '';
      $('verdictTag').textContent = '输入未通过校验';
      $('cocNote').textContent = '';
      $('sensOf').textContent = '';
      return;
    }
    $('errors').innerHTML = '';
    const res = C.analyze(nm.cfg);
    state.res = res;
    state.checks = res.checks;
    state.sel = Math.min(state.sel, res.rows.length - 1);
    render(res);
  }

  function render(res) {
    state.renders++;
    const rev = res.reverse;
    const covered = res.rows.filter(function (x) { return x.covered; }).length;
    $('verdictTag').textContent = covered + ' / ' + res.rows.length + ' 个方案整段覆盖目标区间';

    /* 主结论 */
    $('headline').innerHTML = '目标区间 <b>' + D(res.cfg.target.near) + ' – ' +
      (res.cfg.target.farInf ? '∞' : D(res.cfg.target.far)) + '</b>：' + res.rows.length +
      ' 个方案里 <b>' + covered + ' 个</b>能整段盖住。' +
      (rev.ok
        ? '用 <b>' + N1(rev.f) + 'mm</b> 镜头时，闭式反推给出：对焦放在 <b>' + D(rev.sStar) +
          '</b>、光圈收到 <b>' + F(rev.nStar) + '</b>（回代重算得到的近点/远点是 ' + D(rev.backDn) + ' / ' +
          (rev.backDf === Infinity ? '∞' : D(rev.backDf)) + '）。'
        : '反推得出：<b>本次目标区间做不到</b>——' + esc(rev.reason));

    /* KPI */
    const deepest = res.rows.slice().sort(function (a, b) {
      const av = a.total === Infinity ? Number.MAX_VALUE : a.total;
      const bv = b.total === Infinity ? Number.MAX_VALUE : b.total;
      return bv - av;
    })[0];
    /* 数值只放短串（长串会把窄屏撑破）；方案名放副标题，随宽度换行 */
    const kpis = [
      ['覆盖目标区间的方案', covered + ' / ' + res.rows.length, '整段落在 [近点, 远点] 内'],
      ['反推所需对焦距离', rev.ok ? D(rev.sStar) : '做不到', rev.ok ? '两端点的调和平均' : '见下方原因'],
      ['反推所需最小光圈', rev.ok ? F(rev.nStar) : '—', rev.ok ? '一键采用时向上取整到 ' + F(Math.ceil(rev.nStar * 100) / 100) : ''],
      ['景深最大的方案', deepest ? (deepest.total === Infinity ? '∞' : D(deepest.total)) : '—', deepest ? deepest.name : '']
    ];
    $('kpis').innerHTML = kpis.map(function (k) {
      return '<div class="kpi"><div class="k">' + esc(k[0]) + '</div><div class="v">' + esc(k[1]) + '</div>' +
        (k[2] ? '<div class="s">' + esc(k[2]) + '</div>' : '') + '</div>';
    }).join('');

    /* 提示 */
    const warn = [];
    res.warnings.forEach(function (w) { warn.push(w); });
    res.rows.forEach(function (x) {
      if (x.diffractionLimited) {
        warn.push(x.name + '：光圈 f/' + N1(x.N) + ' 已经越过本画幅的衍射转折光圈 f/' + N2(x.nDiff) + '，' +
          '再收小不会更清晰——艾里斑（' + L(x.airy) + '）已经大于弥散圆（' + L(x.coc) + '）。');
      }
    });
    $('warnBox').innerHTML = warn.length
      ? '<div class="warnbox"><b>需要注意 ' + warn.length + ' 处：</b><ul class="tight">' +
        warn.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>'
      : '<div class="okbox">没有需要注意的告警。</div>';

    renderReverse(res);
    renderPlans(res);
    renderDetail(res);
    renderLaws(res);
    renderInsights(res);
    renderSens(res);
    renderSteps(res);
    renderLimits();
    renderChecks(res);
  }

  /* ── 反推卡 ───────────────────────────────────────── */
  function renderReverse(res) {
    const rev = res.reverse;
    $('revTag').textContent = rev.ok ? ('用 ' + N1(rev.f) + 'mm 镜头反推') : '本次不可行';
    if (!rev.ok) {
      $('reverse').innerHTML = '<div class="errbox"><b>这个目标区间在本次设置下做不到。</b><br>' + esc(rev.reason) +
        '<br><span class="muted">反推出的对焦距离是与焦距无关的调和平均 s* = 两端点之积的 2 倍 ÷ 两端点之和；' +
        '所需光圈随焦距按 f² 增长，所以换更短的焦距通常更容易做到。</span></div>' + revTableHTML(rev);
      return;
    }
    let h = '<div class="grid3">' +
      metric('反推对焦距离 s*', rev.ok ? D(rev.sStar) : '—', '两端点的调和平均，与焦距无关') +
      metric('反推最小光圈', F(rev.nStar), '一键采用时会向上取整到 f/' + (Math.ceil(rev.nStar * 100) / 100).toFixed(2) + '（宁深不浅）') +
      metric('回代近点 / 远点', D(rev.backDn) + ' / ' + (rev.backDf === Infinity ? '∞' : D(rev.backDf)),
        '把 s*、N* 代回公式重算的结果') +
      '</div>';
    h += '<p class="footnote">回代与目标的残差：近点 ' + L(rev.errNear) + '、远点 ' +
      (rev.errFar === Infinity ? '∞' : L(rev.errFar)) + '（浮点噪声量级，不是模型误差）。</p>';

    if (rev.naive) {
      h += '<h3>常见做法对照：对焦在区间「中点」会怎样</h3>' +
        '<div class="grid3">' +
        metric('中点对焦距离', D(rev.naive.s), '（近点 + 远点）÷ 2，不是调和平均') +
        metric('此时的实际近点 / 远点', D(rev.naive.dn) + ' / ' + (rev.naive.df === Infinity ? '∞' : D(rev.naive.df)), '光圈仍用 ' + F(rev.nStar)) +
        metric('判定', rev.naive.coverLabel, '近端缺口 ' + (rev.naive.gapNear > 0 ? D(rev.naive.gapNear) : '0')) +
        '</div>' +
        '<p class="footnote">同一个光圈下，把对焦从调和平均挪到算术中点，近点从 ' + D(rev.backDn) + ' 退到 ' +
        D(rev.naive.dn) + '，而远点从 ' + (rev.backDf === Infinity ? '∞' : D(rev.backDf)) + ' 推到 ' +
        (rev.naive.df === Infinity ? '∞' : D(rev.naive.df)) + '——余量被放到了不需要的地方。</p>';
    }
    h += revTableHTML(rev);
    $('reverse').innerHTML = h;
  }

  function revTableHTML(rev) {
    if (!rev.table) return '';
    return '<h3>同一个目标区间，换焦距要多大光圈</h3>' +
      '<div class="tw"><table class="wrap"><thead><tr><th>焦距</th><th>反推对焦距离</th><th>所需最小光圈</th><th>能不能做到</th></tr></thead><tbody>' +
      rev.table.rows.map(function (r) {
        return '<tr><td>' + N1(r.f) + ' mm</td><td>' + D(r.sStar) + '</td><td>' +
          (r.feasible ? F(r.nStar) : '—') + '</td><td>' +
          (r.feasible ? '<span class="pill ok">可以</span>' : '<span class="pill fail">' + esc(r.why) + '</span>') +
          '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="footnote">对焦距离一列全都相同（' + D(rev.table.sStar) + '）：它是两端点的调和平均，与焦距、光圈、弥散圆都无关。' +
      '但所需光圈随 f² 增长——这是「想拍清楚一整段」时广角比长焦好用的真正原因。</p>';
  }

  function metric(k, v, s) {
    return '<div class="metric"><div class="mk">' + esc(k) + '</div><div class="mv">' + esc(v) + '</div>' +
      (s ? '<div class="ms">' + esc(s) + '</div>' : '') + '</div>';
  }

  /* ── 方案对照表 ───────────────────────────────────── */
  function renderPlans(res) {
    $('planBody').innerHTML = res.rows.map(function (x, i) {
      return '<tr class="pick' + (i === state.sel ? ' sel' : '') + '" data-i="' + i + '">' +
        '<td>' + esc(x.name) + '</td>' +
        '<td>' + esc(shortSensor(x.sensorName)) + '</td>' +
        '<td>' + N1(x.f) + ' mm</td><td>' + F(x.N) + '</td><td>' + D(x.s) + '</td>' +
        '<td>' + D(x.H) + '</td><td>' + D(x.dn) + '</td>' +
        '<td>' + (x.df === Infinity ? '∞' : D(x.df)) + '</td>' +
        '<td>' + (x.total === Infinity ? '∞' : D(x.total)) + '</td>' +
        '<td>' + pillHTML(x.cover, x.coverLabel) + '</td>' +
        '<td>' + (x.dfInf ? '远点 ∞' : '远点有限') + '</td>' +
        '</tr>';
    }).join('');
    const c0 = res.rows[0];
    $('cocNote').textContent = '本次弥散圆 c = ' + L(c0.coc) + '（' + c0.cocSource + '）。';
  }

  function shortSensor(n) {
    return String(n).replace('（多数手机主摄）', '').replace('（大底手机 / 卡片机）', '')
      .replace('（4/3 画幅）', '').replace('（佳能 1.6×）', ' 1.6×').replace('（尼康 / 索尼 1.5×）', ' 1.5×')
      .replace('英寸', '"').replace(/\s+"/g, '"').replace('（36×24）', '');
  }

  /* ── 选中方案详解 ─────────────────────────────────── */
  function renderDetail(res) {
    const x = res.rows[state.sel];
    if (!x) { $('detailName').textContent = ''; $('detailBody').innerHTML = '<p class="muted">—</p>'; return; }
    $('detailName').textContent = x.name;
    const ratioTxt = x.ratioBack === Infinity ? '1 : ∞（远点无限远）' : ('1 : ' + N2(x.ratioBack));
    const shareTxt = x.frontShare === null ? '—' : P2(x.frontShare * 100);
    let h = '<div class="grid3">' +
      metric('超焦距 H', D(x.H), '对焦到这里：近点 = H/2、远点 = ∞') +
      metric('近点', D(x.dn), '比它更近就开始虚') +
      metric('远点', x.df === Infinity ? '∞' : D(x.df), x.dfInf ? 's ≥ H，远点直接到无限远' : '比它更远就开始虚') +
      metric('总景深', x.total === Infinity ? '∞' : D(x.total), '从近点到远点这一段的长度') +
      metric('前景深 / 后景深', (x.front === Infinity ? '∞' : D(x.front)) + ' / ' + (x.back === Infinity ? '∞' : D(x.back)), '对焦位置前 / 后的清晰长度') +
      metric('前 : 后', ratioTxt, '前段占总景深 ' + shareTxt) +
      metric('无限远背景弥散圆', L(x.blurInf), '占画幅高度 ' + P2(x.blurPct) + '（f/' + N1(x.N) + '、对焦 ' + D(x.s) + '）') +
      metric('衍射转折光圈 N_d', F(x.nDiff), x.diffractionLimited ? '当前 ' + F(x.N) + ' 已越过这条线' : '当前 ' + F(x.N) + ' 还没到这条线') +
      metric('等效焦距 / 等效光圈', N1(x.fEq) + ' mm / ' + F(x.NEq), '按' + shortSensor(x.refSensorName) + '算（等效系数 ' + N3(x.crop) + '）') +
      '</div>';

    h += '<p class="footnote">艾里斑直径 2.44λN = ' + L(x.airy) + '，弥散圆 c = ' + L(x.coc) +
      '；' + (x.diffractionLimited
        ? '<b>艾里斑已经大于 c</b>：此时画面上的最小细节由衍射决定，再收小光圈不会更清晰。'
        : '艾里斑还小于 c：继续收小光圈仍能换来更深的景深。') +
      ' 放大率约 1:' + (x.mag > 0 ? N1(1 / x.mag) : '∞') + (x.closeFocus ? '，已进入近摄区间（结论偏差可能变大）。' : '。') + '</p>';

    h += '<h3>让这一段更清晰：把改动直接作用到输入</h3><div class="btns">' +
      '<button type="button" data-act="hyper">把对焦搬到超焦距 H（' + D(x.H) + '）</button>' +
      '<button type="button" data-act="third">把对焦搬到 H ÷ 3（' + D(x.H / 3) + '）</button>' +
      '<button type="button" data-act="solve">按反推设置本方案</button>' +
      '<button type="button" data-act="equiv">换成等效的' + esc(shortSensor(x.refSensorName)) + '设置</button>' +
      '<button type="button" data-act="clone">复制为新方案</button>' +
      '</div>';

    const tips = [];
    if (x.cover === 'cover') tips.push('本方案的清晰范围整段盖住了目标区间。');
    else {
      if (x.gapNear > 0) tips.push('近端差 ' + D(x.gapNear) + '：把对焦距离往前挪，或收小光圈。');
      if (x.gapFar === Infinity) tips.push('远端差到无限远：需要把对焦推到超焦距附近才可能到 ∞。');
      else if (x.gapFar > 0) tips.push('远端差 ' + D(x.gapFar) + '：把对焦距离往后挪，或收小光圈。');
    }
    if (x.diffractionLimited) tips.push('注意已经越过衍射转折光圈：收小光圈不再换来更多细节，优先改对焦位置或焦距。');
    if (x.total !== Infinity && x.back / x.front > 3) tips.push('后景深是前景深的 ' + N2(x.ratioBack) + ' 倍：余量大量堆在对焦点之后，往前挪一点往往更划算。');
    h += '<ul class="tight">' + tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';

    $('detailBody').innerHTML = h;
  }

  /* ── 口径对照卡 ───────────────────────────────────── */
  function renderLaws(res) {
    const law = res.laws;
    let h = '<h3>对焦位置口径对照：同一个超焦距，对焦放哪就决定了清晰段落在哪</h3>' +
      '<div class="tw"><table class="wrap"><thead><tr><th>对焦位置</th><th>对焦距离</th><th>近点</th><th>远点</th><th>总景深</th></tr></thead><tbody>' +
      law.compare.map(function (r) {
        return '<tr><td>' + esc(r.label) + '</td><td>' + D(r.s) + '</td><td>' + D(r.dn) + '</td><td>' +
          (r.df === Infinity ? '∞' : D(r.df)) + '</td><td>' + (r.total === Infinity ? '∞' : D(r.total)) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="footnote">以第 1 个方案（' + esc(shortSensor(law.sensorName)) + '、' + N1(law.f) + 'mm、' + F(law.N) +
      '）为例：H = ' + D(law.H) + '。对焦在 H 上，近点算得 ' + D(law.hyper.dn) + '，而 H ÷ 2 = ' + D(law.hyper.halfH) +
      '，两者相对差 ' + law.hyper.relErrDn.toExponential(2) + '，远点在这一支里直接是 ∞——这条与 f、N、c 都无关，是公式本身的结构。</p>';

    const t = law.third;
    h += '<h3>「前 1/3 后 2/3」不是通用法则</h3>' +
      '<p class="footnote">同一个方案，若把对焦距离取 H ÷ 3 = ' + D(t.s) + '，算得前景深 ' + D(t.front) +
      '、后景深 ' + D(t.back) + '，前后比 <b>1 : ' + N3(t.ratioBack) + '</b>；精确式是 H : (2H − 3f) → 1 : ' +
      N3(t.predRatioBack) + '，前段占总景深 <b>' + P3(t.share * 100) + '</b>（不是 33.333%，因为 f > 0 时精确值是 H/(3(H−f))）。' +
      '上面 6 个方案的实际前后比各不相同，所以「前 1/3 后 2/3」只能当口语，不能当尺子。</p>';

    h += '<h3>衍射转折光圈：收小光圈的收益有上限</h3>' +
      '<div class="tw"><table class="wrap"><thead><tr><th>方案</th><th>画幅</th><th>弥散圆 c</th><th>衍射转折光圈 N_d</th><th>当前光圈</th><th>状态</th></tr></thead><tbody>' +
      res.rows.map(function (x) {
        return '<tr><td>' + esc(x.name) + '</td><td>' + esc(shortSensor(x.sensorName)) + '</td><td>' + L(x.coc) +
          '</td><td>' + F(x.nDiff) + '</td><td>' + F(x.N) + '</td><td>' +
          (x.diffractionLimited ? '<span class="pill fail">已越过</span>' : '<span class="pill ok">未越过</span>') +
          '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="footnote">判据是艾里斑第一暗环直径 2.44λN（λ = ' + res.cfg.lambda + ' nm）追上弥散圆 c。' +
      '同一支 f/8，在全画幅上离转折点还很远，在 1/2.3 英寸上早就越过了——<b>衍射转折点由画幅决定</b>。</p>';

    const ph = res.rows.filter(function (x) { return x.sensor === 'phone23'; })[0];
    if (ph) {
      h += '<h3>等效口径：小底「f/1.8」和大底「f/1.8」不是一回事</h3>' +
        '<div class="grid3">' +
        metric(ph.name + ' 的实际设置', N1(ph.f) + ' mm ' + F(ph.N), shortSensor(ph.sensorName) + '，等效系数 ' + N3(ph.crop)) +
        metric('等效到' + shortSensor(ph.refSensorName), N1(ph.fEq) + ' mm ' + F(ph.NEq), '视角相同、景深也相同的那套设置') +
        metric('等效后近点/远点偏差', (ph.eqDevNear === null ? '不可比较' : P3(ph.eqDevNear * 100)) + ' / ' +
          (ph.eqDevFar === null ? '不可比较' : P3(ph.eqDevFar * 100)), '等效是 f ≪ s 时的近似，不是恒等式') +
        '</div>' +
        '<p class="footnote">把该方案按等效焦距/等效光圈搬到' + esc(shortSensor(ph.refSensorName)) +
        '重算，近点与远点并不严格相等——偏差与闭式预测一致（见结构自检）。所以下面这句只在近似意义上成立：' +
        '<b>它的景深比全画幅 f/8 还深</b>，不是因为手机更强，而是画幅决定了景深口径。</p>';
    }
    $('lawBody').innerHTML = h;
  }

  function renderInsights(res) {
    $('insights').innerHTML = res.insights.map(function (x) {
      return '<div class="slice"><span class="st">' + esc(x.title) + '</span>' + esc(x.body) + '</div>';
    }).join('');
  }

  /* ── 敏感性 ───────────────────────────────────────── */
  function renderSens(res) {
    const x = res.rows[state.sel] || res.rows[0];
    const rows = C.sensitivity(res.cfg, state.sel);
    $('sensOf').textContent = '对「' + x.name + '」逐行完整重算';
    $('sensBody').innerHTML = rows.map(function (r) {
      if (r.invalid) {
        return '<tr><td>' + esc(r.label) + '</td><td colspan="8" class="muted">' + esc(r.note) + '</td></tr>';
      }
      const d = r.deltaTotal === null ? '—' : ((r.deltaTotal >= 0 ? '+' : '') + D(r.deltaTotal));
      return '<tr><td>' + esc(r.label) + '</td><td>' + N1(r.f) + ' mm</td><td>' + F(r.N) + '</td><td>' + D(r.s) +
        '</td><td>' + D(r.dn) + '</td><td>' + (r.df === Infinity ? '∞' : D(r.df)) + '</td><td>' +
        (r.total === Infinity ? '∞' : D(r.total)) + '</td><td>' + d + '</td><td>' + pillHTML(r.cover, r.coverLabel) + '</td></tr>';
    }).join('');
  }

  /* ── 下一步 ───────────────────────────────────────── */
  function renderSteps(res) {
    const rev = res.reverse;
    const out = [];
    const fail = res.rows.filter(function (x) { return !x.covered; });
    if (rev.ok) {
      out.push('要整段拍清楚，把对焦放到 ' + D(rev.sStar) + '、光圈开到 ' + F(rev.nStar) + ' 或更小（数值更大）——这是闭式解，回代已经验算过。');
    } else {
      out.push('本次目标区间做不到，原因：' + rev.reason + ' 先放宽目标区间，或换更短的焦距再试。');
    }
    if (fail.length) {
      const names = fail.slice(0, 3).map(function (x) { return x.name; }).join('、');
      out.push('还有 ' + fail.length + ' 个方案盖不住（' + names + (fail.length > 3 ? ' 等' : '') +
        '）：先收小光圈，再按上面的对焦距离挪一挪，最后才考虑换焦距。');
    } else {
      out.push('当前 ' + res.rows.length + ' 个方案都整段覆盖了目标区间。');
    }
    const over = res.rows.filter(function (x) { return x.diffractionLimited; });
    if (over.length) {
      out.push('有 ' + over.length + ' 个方案已经越过衍射转折光圈（' + over.slice(0, 3).map(function (x) { return x.name; }).join('、') +
        '）：它们再收小光圈不会更清晰，应改对焦位置或焦距，而不是继续收光圈。');
    }
    const deep = res.rows.filter(function (x) { return x.total !== Infinity && x.ratioBack > 3; });
    if (deep.length) {
      out.push('有 ' + deep.length + ' 个方案的后景深超过前景深 3 倍（' + deep[0].name + ' 是 1 : ' + N2(deep[0].ratioBack) +
        '）：余量堆在后方，把对焦往前挪收益更大。');
    }
    if (res.rows.some(function (x) { return x.sensor === 'phone23'; })) {
      out.push('对照一下等效光圈：小底上的 f/' + N1(res.rows.filter(function (x) { return x.sensor === 'phone23'; })[0].N) +
        ' 在景深上相当于大底的 f/' + N2(res.rows.filter(function (x) { return x.sensor === 'phone23'; })[0].NEq) +
        '；要比「谁虚化更强」，比的是等效光圈，不是镜头上印的那个数。');
    }
    out.push('导出结果卡或 Markdown，把这次的设置与结论一起存档；换条件后本页会立刻重算。');
    $('steps').innerHTML = out.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
  }

  function renderLimits() {
    $('limits').innerHTML = C.LIMITS.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
  }

  function renderChecks(res) {
    const ok = res.checks.filter(function (c) { return c.ok; }).length;
    $('checkTag').textContent = ok + ' / ' + res.checks.length + ' 项通过';
    $('checks').innerHTML = res.checks.map(function (c) {
      return '<li>' + (c.ok ? '<span class="vd">通过</span>' : '<span class="vf">未通过</span>') + ' · ' + esc(c.msg) +
        (c.extra ? ' <span class="muted">[' + esc(c.extra) + ']</span>' : '') + '</li>';
    }).join('');
  }

  /* ── 把建议作用回输入 ─────────────────────────────── */
  function rowEl(i) { return $('rows').querySelector('.item[data-i="' + i + '"]'); }
  /* 增删方案后把 data-i 重新对齐，否则报错标红会落到别的行 */
  function reindex() {
    const items = $('rows').querySelectorAll('.item');
    Array.prototype.forEach.call(items, function (el, i) {
      el.setAttribute('data-i', String(i));
      const d = el.querySelector('[data-del]'); if (d) d.setAttribute('data-del', String(i));
      const u = el.querySelector('[data-dup]'); if (u) u.setAttribute('data-dup', String(i));
    });
    $('rowCount').textContent = items.length + ' 个方案';
    return items.length;
  }
  function setRowField(i, cls, value) {
    const el = rowEl(i); if (!el) return;
    const inp = el.querySelector('.' + cls); if (inp) inp.value = value;
  }
  function setRowSensor(i, id) { const el = rowEl(i); if (el) el.querySelector('.sn').value = id; }

  function act(kind) {
    const res = state.res;
    if (!res) { toast('先让输入通过校验'); return; }
    const i = state.sel;
    const x = res.rows[i];
    if (!x) return;
    if (kind === 'hyper') { setRowField(i, 's', String(Math.round(x.H * 1000) / 1000)); compute(); toast('已把对焦搬到超焦距 H = ' + D(x.H)); return; }
    if (kind === 'third') { setRowField(i, 's', String(Math.round(x.H / 3 * 1000) / 1000)); compute(); toast('已把对焦搬到 H ÷ 3'); return; }
    if (kind === 'clone') {
      if (res.rows.length >= C.MAX_ROWS) { toast('最多 ' + C.MAX_ROWS + ' 个方案'); return; }
      const last = res.rows[res.rows.length - 1];
      const box = $('rows');
      box.insertAdjacentHTML('beforeend', rowHTML({
        name: (last.name + ' 副本').slice(0, C.NAME_MAX), sensor: last.sensor,
        f: last.f, N: last.N, s: Math.round(last.s * 1000) / 1000
      }, res.rows.length));
      reindex();
      state.sel = res.rows.length;
      compute(); toast('已复制为新方案'); return;
    }
    if (kind === 'solve') {
      const rv = C.applySolve(res.cfg, x.f, res.cfg.rows[i].dims);
      if (!rv.ok) { toast('这个目标区间用 ' + N1(x.f) + 'mm 做不到：' + rv.reason.slice(0, 40)); return; }
      setRowField(i, 's', String(rv.s));
      setRowField(i, 'N', String(rv.N));
      compute();
      toast('已按 ' + N1(x.f) + 'mm 的反推值设置：对焦 ' + D(rv.s) + '、' + F(rv.N) + '（判定：' + rv.coverLabel + '）');
      return;
    }
    if (kind === 'equiv') {
      if (!x.eqValid) { toast('等效焦距已不小于对焦距离，等效设置不成立'); return; }
      if (x.NEq > C.N_MAX) { toast('等效光圈 ' + F(x.NEq) + ' 超出本页上限 ' + F(C.N_MAX)); return; }
      if (x.fEq > C.F_MAX) { toast('等效焦距 ' + N1(x.fEq) + ' mm 超出本页上限'); return; }
      setRowSensor(i, res.cfg.refSensor);
      setRowField(i, 'f', String(Math.round(x.fEq * 100) / 100));
      setRowField(i, 'N', String(Math.round(x.NEq * 100) / 100));
      compute(); toast('已换成等效的' + shortSensor(x.refSensorName) + '设置');
      return;
    }
  }

  /* ── 导出 ─────────────────────────────────────────── */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  function cell(x) {
    const s = String(x);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function csvText() {
    const res = state.res; if (!res) return '';
    const L2 = [];
    L2.push(['景深对账台（dof-ledger）导出', new Date().toISOString()]);
    L2.push(['弥散圆口径', C.COC_BY_ID[res.cfg.coc.mode].name]);
    L2.push(['波长 λ (nm)', res.cfg.lambda]);
    L2.push(['对照画幅', res.cfg.refSensor]);
    L2.push(['目标近点 (m)', res.cfg.target.near]);
    L2.push(['目标远点 (m)', res.cfg.target.farInf ? '∞' : res.cfg.target.far]);
    L2.push(['反推用焦距 (mm)', res.cfg.solveF]);
    const rev = res.reverse;
    L2.push(['反推可行', rev.ok ? '是' : '否']);
    if (rev.ok) {
      L2.push(['反推对焦距离 (m)', rev.sStar]);
      L2.push(['反推最小光圈（f/ 数值）', rev.nStar]);
      L2.push(['回代近点 (m)', rev.backDn]);
      L2.push(['回代远点 (m)', rev.dfInf === undefined ? rev.backDf : rev.backDf]);
    } else {
      L2.push(['不可行原因', rev.reason]);
    }
    if (rev.naive) {
      L2.push(['中点对焦距离 (m)', rev.naive.s]);
      L2.push(['中点对焦实际近点 (m)', rev.naive.dn]);
      L2.push(['中点对焦实际远点 (m)', rev.naive.df]);
      L2.push(['中点对焦判定', rev.naive.coverLabel]);
    }
    L2.push([]);
    const head = ['方案', '画幅', '焦距mm', '光圈f', '对焦距离m', '超焦距m', '近点m', '远点m', '前景深m', '后景深m',
      '总景深m', '前后比(后/前)', '前段占总景深', '背景弥散圆mm', '占画幅高%', '衍射转折光圈', '是否过衍射',
      '覆盖判定', '近端缺口m', '远端缺口m', '等效焦距mm', '等效光圈f'];
    L2.push(head);
    res.rows.forEach(function (x) {
      L2.push([x.name, x.sensorName, x.f, x.N, x.s, x.H, x.dn, x.df === Infinity ? '∞' : x.df,
        x.front, x.back === Infinity ? '∞' : x.back, x.total === Infinity ? '∞' : x.total,
        x.ratioBack === Infinity ? '∞' : x.ratioBack,
        x.frontShare === null ? '' : x.frontShare,
        x.blurInf, x.blurPct, x.nDiff, x.diffractionLimited ? '是' : '否',
        x.coverLabel, x.gapNear, x.gapFar === Infinity ? '∞' : x.gapFar, x.fEq, x.NEq]);
    });
    L2.push([]);
    L2.push(['结构自检']);
    L2.push(['通过', '说明', '附注']);
    res.checks.forEach(function (c) { L2.push([c.ok ? '是' : '否', c.msg, c.extra]); });
    return '\ufeff' + L2.map(function (r) { return r.map(cell).join(','); }).join('\r\n') + '\r\n';
  }

  function mdText() {
    const res = state.res; if (!res) return '';
    const rev = res.reverse;
    const o = [];
    o.push('# 景深对账台 · 结果（dof-ledger）');
    o.push('');
    o.push('导出时间：' + new Date().toISOString());
    o.push('');
    o.push('## 口径');
    o.push('');
    o.push('- 弥散圆口径：' + C.COC_BY_ID[res.cfg.coc.mode].name + '（本次各方案的 c 见下表）');
    o.push('- 波长 λ：' + res.cfg.lambda + ' nm');
    o.push('- 对照画幅：' + res.cfg.refSensor);
    o.push('- 目标区间：' + D(res.cfg.target.near) + ' – ' + (res.cfg.target.farInf ? '∞' : D(res.cfg.target.far)));
    o.push('- 反推用焦距：' + N1(res.cfg.solveF) + ' mm');
    o.push('');
    o.push('## 反推');
    o.push('');
    if (rev.ok) {
      o.push('- 对焦距离 s* = **' + D(rev.sStar) + '**（两端点的调和平均，与焦距、光圈、弥散圆都无关）');
      o.push('- 最小光圈 N* = **' + F(rev.nStar) + '**');
      o.push('- 回代重算：近点 ' + D(rev.backDn) + '、远点 ' + (rev.backDf === Infinity ? '∞' : D(rev.backDf)) +
        '（与目标的残差 ' + L(rev.errNear) + ' / ' + (rev.errFar === Infinity ? '∞' : L(rev.errFar)) + '）');
      if (rev.naive) {
        o.push('- 中点对焦对照：对焦在 ' + D(rev.naive.s) + ' 时实际近点 ' + D(rev.naive.dn) + '、远点 ' +
          (rev.naive.df === Infinity ? '∞' : D(rev.naive.df)) + '，判定「' + rev.naive.coverLabel + '」');
      }
      if (rev.table) {
        o.push('');
        o.push('| 焦距 | 反推对焦距离 | 所需最小光圈 | 能不能做到 |');
        o.push('| --- | --- | --- | --- |');
        rev.table.rows.forEach(function (r) {
          o.push('| ' + N1(r.f) + ' mm | ' + D(r.sStar) + ' | ' + (r.feasible ? F(r.nStar) : '—') + ' | ' +
            (r.feasible ? '可以' : r.why) + ' |');
        });
      }
    } else {
      o.push('- **本次目标区间做不到**：' + rev.reason);
    }
    o.push('');
    o.push('## 方案对照');
    o.push('');
    o.push('| 方案 | 画幅 | 焦距 | 光圈 | 对焦距离 | 超焦距 | 近点 | 远点 | 总景深 | 前:后 | 覆盖 |');
    o.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    res.rows.forEach(function (x) {
      o.push('| ' + x.name + ' | ' + x.sensorName + ' | ' + N1(x.f) + ' mm | ' + F(x.N) + ' | ' + D(x.s) + ' | ' +
        D(x.H) + ' | ' + D(x.dn) + ' | ' + (x.df === Infinity ? '∞' : D(x.df)) + ' | ' +
        (x.total === Infinity ? '∞' : D(x.total)) + ' | ' + (x.ratioBack === Infinity ? '∞' : '1 : ' + N2(x.ratioBack)) +
        ' | ' + x.coverLabel + ' |');
    });
    o.push('');
    o.push('## 口径对照');
    o.push('');
    o.push('| 对焦位置 | 对焦距离 | 近点 | 远点 | 总景深 |');
    o.push('| --- | --- | --- | --- | --- |');
    res.laws.compare.forEach(function (r) {
      o.push('| ' + r.label + ' | ' + D(r.s) + ' | ' + D(r.dn) + ' | ' + (r.df === Infinity ? '∞' : D(r.df)) + ' | ' +
        (r.total === Infinity ? '∞' : D(r.total)) + ' |');
    });
    const t = res.laws.third;
    o.push('');
    o.push('「前 1/3 后 2/3」只在「对焦距离 = H ÷ 3」时成立，且精确式为 H : (2H − 3f)。本次实测：前后比 1 : ' +
      N3(t.ratioBack) + '（预期 1 : ' + N3(t.predRatioBack) + '），前段占总景深 ' + P3(t.share * 100) + '。');
    o.push('');
    o.push('## 衍射转折光圈');
    o.push('');
    o.push('| 方案 | 画幅 | 弥散圆 c | N_d | 当前光圈 | 状态 |');
    o.push('| --- | --- | --- | --- | --- | --- |');
    res.rows.forEach(function (x) {
      o.push('| ' + x.name + ' | ' + x.sensorName + ' | ' + L(x.coc) + ' | ' + F(x.nDiff) + ' | ' + F(x.N) + ' | ' +
        (x.diffractionLimited ? '已越过' : '未越过') + ' |');
    });
    o.push('');
    o.push('## 等效口径');
    o.push('');
    o.push('| 方案 | 实际设置 | 等效到' + shortSensor(res.rows[0].refSensorName) + ' | 等效系数 | 等效后近点偏差 | 等效后远点偏差 |');
    o.push('| --- | --- | --- | --- | --- | --- |');
    res.rows.forEach(function (x) {
      o.push('| ' + x.name + ' | ' + N1(x.f) + ' mm ' + F(x.N) + ' | ' + N1(x.fEq) + ' mm ' + F(x.NEq) + ' | ' +
        N3(x.crop) + ' | ' + (x.eqDevNear === null ? '不可比较' : P3(x.eqDevNear * 100)) + ' | ' +
        (x.eqDevFar === null ? '不可比较' : P3(x.eqDevFar * 100)) + ' |');
    });
    o.push('');
    o.push('## 值得记住的几条');
    o.push('');
    res.insights.forEach(function (x) { o.push('- **' + x.title + '**：' + x.body); });
    o.push('');
    o.push('## 结构自检（' + res.checks.filter(function (c) { return c.ok; }).length + ' / ' + res.checks.length + ' 通过）');
    o.push('');
    res.checks.forEach(function (c) { o.push('- ' + (c.ok ? '通过' : '未通过') + '：' + c.msg + (c.extra ? '（' + c.extra + '）' : '')); });
    o.push('');
    o.push('## 这份账不算什么');
    o.push('');
    C.LIMITS.forEach(function (x) { o.push('- ' + x); });
    o.push('');
    o.push('> 默认样例、内置场景与以上所有数字都是虚构示例，不是任何真实器材的实测数据。');
    return o.join('\n') + '\n';
  }

  function jsonBackup() {
    return JSON.stringify({
      app: 'dof-ledger', version: 1, savedAt: new Date().toISOString(),
      input: readInput()
    }, null, 2);
  }

  /* ── 结果卡 PNG（1080×1350） ──────────────────────── */
  function pngCard() {
    const res = state.res; if (!res) { toast('先让输入通过校验'); return; }
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const FONT = function (w2, sz) { return w2 + ' ' + sz + 'px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif'; };
    /* 空白必须作为独立 token 保留，否则整张卡的英文/数字之间的空格会被静默吃掉 */
    const toks = function (t) { return String(t).match(/[A-Za-z0-9.,%×÷+\-−/（）()]+|\s+|[\u4e00-\u9fa5]|[^\s]/g) || []; };
    const wrap = function (text, maxW, size, weight) {
      g.font = FONT(weight || 400, size);
      const out = [];
      let line = '';
      toks(text).forEach(function (t) {
        const t2 = line + t;
        if (g.measureText(t2).width > maxW && line.trim()) {
          out.push(line.replace(/\s+$/, ''));
          line = t.replace(/^\s+/, '');
        } else line = t2;
      });
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
      /* 不让收尾标点落在行首 */
      return out.map(function (x, i) { return (i > 0 && /^[）)；，。、%》]/.test(x)) ? '　' + x : x; });
    };
    const put = function (text, x, y, size, color, weight, maxW, lh) {
      g.fillStyle = color; g.font = FONT(weight || 400, size);
      const lines = maxW ? wrap(text, maxW, size, weight) : [String(text)];
      lines.forEach(function (ln, i) { g.fillText(ln, x, y + i * (lh || size + 8)); });
      return y + lines.length * (lh || size + 8);
    };
    /* 按剩余宽度自动缩字号，避免静默截断 */
    const putFit = function (text, x, y, size, minSize, color, weight, maxW) {
      let sz = size;
      g.font = FONT(weight || 400, sz);
      while (sz > minSize && g.measureText(String(text)).width > maxW) { sz -= 1; g.font = FONT(weight || 400, sz); }
      g.fillStyle = color; g.font = FONT(weight || 400, sz);
      g.fillText(String(text), x, y);
    };

    const rev = res.reverse;
    const covered = res.rows.filter(function (x) { return x.covered; }).length;
    const phone = res.rows.filter(function (x) { return x.sensor === 'phone23'; })[0];
    const over = res.rows.filter(function (x) { return x.diffractionLimited; });

    g.fillStyle = '#f5f6f8'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0f5fa6'; g.fillRect(0, 0, W, 12);
    put('景深对账台', 72, 106, 50, '#161b22', 700);
    put('想让这一段都拍清楚：对焦放哪、光圈开多大', 72, 150, 23, '#4a5568', 400, W - 144);

    /* 结论 176–360 */
    g.fillStyle = '#eaf2fa'; g.fillRect(72, 176, W - 144, 184);
    put('目标区间 ' + D(res.cfg.target.near) + ' – ' + (res.cfg.target.farInf ? '∞' : D(res.cfg.target.far)) +
      '：' + covered + ' / ' + res.rows.length + ' 个方案整段覆盖', 96, 218, 30, '#161b22', 500, W - 240);
    if (rev.ok) {
      put('用 ' + N1(rev.f) + 'mm 镜头：对焦放到 ' + D(rev.sStar) + '、光圈收到 ' + F(rev.nStar), 96, 272, 31, '#0f5fa6', 700, W - 240);
      put('回代重算得到近点 ' + D(rev.backDn) + '、远点 ' + (rev.backDf === Infinity ? '∞' : D(rev.backDf)) +
        '　（残差 ' + L(rev.errNear) + '）', 96, 318, 22, '#161b22', 500, W - 240);
    } else {
      put('本次目标区间做不到', 96, 272, 31, '#b42318', 700, W - 240);
      put(rev.reason, 96, 314, 21, '#161b22', 500, W - 240);
    }

    /* KPI 380–500 */
    const kpi = [
      ['反推对焦距离', rev.ok ? D(rev.sStar) : '—'],
      ['反推最小光圈', rev.ok ? F(rev.nStar) : '—'],
      ['已越过衍射的方案', over.length + ' / ' + res.rows.length],
      ['中点对焦判定', rev.naive ? rev.naive.coverLabel : '—']
    ];
    kpi.forEach(function (x, i) {
      const px = 72 + (i % 2) * 476, py = 380 + Math.floor(i / 2) * 122;
      g.fillStyle = '#fff'; g.fillRect(px, py, 452, 114);
      g.strokeStyle = '#e3e6eb'; g.strokeRect(px, py, 452, 114);
      g.fillStyle = '#4a5568'; g.font = FONT(400, 22); g.fillText(x[0], px + 24, py + 38);
      putFit(x[1], px + 24, py + 86, 34, 20, '#161b22', 700, 404);
    });

    /* 逐方案 640–930 */
    put('逐方案：清晰范围与判定', 72, 662, 28, '#161b22', 700, W - 144);
    const cols = [72, 306, 542, 778, 986];
    g.fillStyle = '#7b8794'; g.font = FONT(400, 20);
    ['方案', '近点', '远点', '总景深', '判定'].forEach(function (t, i) {
      g.fillText(t, cols[i] - (i === 4 ? 78 : 0), 698);
    });
    g.strokeStyle = '#e3e6eb'; g.beginPath(); g.moveTo(72, 710); g.lineTo(W - 72, 710); g.stroke();
    let ry = 744;
    res.rows.slice(0, 6).forEach(function (x) {
      g.font = FONT(400, 22); g.fillStyle = '#37424f';
      const nm = x.name.length > 12 ? x.name.slice(0, 12) + '…' : x.name;
      g.fillText(nm, cols[0], ry);
      g.fillText(D(x.dn), cols[1], ry);
      g.fillText(x.df === Infinity ? '∞' : D(x.df), cols[2], ry);
      g.fillText(x.total === Infinity ? '∞' : D(x.total), cols[3], ry);
      g.fillStyle = x.covered ? '#0f7b52' : (x.cover === 'both' ? '#b42318' : '#9a5b00');
      g.fillText(x.coverLabel, cols[4] - 78, ry);
      ry += 31;
    });

    /* 要点 946–1076 */
    g.fillStyle = '#e8f6ef'; g.fillRect(72, 946, W - 144, 130);
    put('对焦在超焦距 H 时，近点恰好是 H ÷ 2、远点是 ∞（与 f、N、c 无关）', 96, 986, 24, '#0f7b52', 700, W - 240);
    put('「前 1/3 后 2/3」只在「对焦距离 = H ÷ 3」时成立，精确式是 H : (2H − 3f)', 96, 1024, 22, '#161b22', 400, W - 240);
    const ndLo = Math.min.apply(null, res.rows.map(function (x) { return x.nDiff; }));
    const ndHi = Math.max.apply(null, res.rows.map(function (x) { return x.nDiff; }));
    put('衍射转折光圈随画幅变化：本次从 ' + F(ndLo) + ' 到 ' + F(ndHi) + '，收小光圈的收益有上限', 96, 1056, 22, '#161b22', 400, W - 240);

    /* 等效 1096–1200 */
    put('等效口径', 72, 1100, 26, '#161b22', 700, W - 144);
    if (phone) {
      put(phone.name + '：' + N1(phone.f) + 'mm ' + F(phone.N) + '（' + shortSensor(phone.sensorName) +
        '）在视角与景深上 ≈ ' + shortSensor(phone.refSensorName) + ' 的 ' + N1(phone.fEq) + 'mm ' + F(phone.NEq),
        72, 1138, 22, '#37424f', 400, W - 144);
      put('等效只是 f ≪ s 时的近似：近点偏差 ' + P2(phone.eqDevNear * 100) + '、远点偏差 ' +
        (phone.eqDevFar === null ? '不可比较' : P2(phone.eqDevFar * 100)), 72, 1170, 21, '#7b8794', 400, W - 144);
    } else {
      put('（本次方案里没有 1/2.3 英寸画幅，未做小底对照）', 72, 1138, 22, '#7b8794', 400, W - 144);
    }

    /* 页脚 1230–1330 */
    g.fillStyle = '#e3e6eb'; g.fillRect(72, 1226, W - 144, 1);
    put('弥散圆口径 ' + C.COC_BY_ID[res.cfg.coc.mode].name + ' / λ ' + res.cfg.lambda + ' nm / 对照画幅 ' + res.cfg.refSensor +
      ' / 目标 ' + D(res.cfg.target.near) + '–' + (res.cfg.target.farInf ? '∞' : D(res.cfg.target.far)), 72, 1256, 20, '#7b8794', 400, W - 144);
    put('薄透镜景深公式；光瞳放大率按 1；只做几何光学，不含像差、运动模糊与真实 MTF', 72, 1284, 20, '#7b8794', 400, W - 144);
    put('默认与场景都是虚构示例，不是任何真实器材的实测数据 · 不联网 · 不做器材评价', 72, 1312, 20, '#7b8794', 400, W - 144);

    cv.toBlob(function (b) {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = '景深对账台-结果卡.png'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      state.exportCount++;
    }, 'image/png');
  }

  /* ── 本机保存 / 导入 ─────────────────────────────── */
  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(readInput()));
      $('saveState').textContent = '已保存到本机（' + new Date().toLocaleTimeString('zh-CN') + '）。只存在这个浏览器里。';
      toast('已保存到本机');
    } catch (e) { $('saveState').textContent = '这台浏览器不允许本机保存（可能是隐私模式）。'; }
  }

  function loadLocal(silent) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (!silent) toast('本机还没有保存过'); return false; }
      writeInput(JSON.parse(raw));
      if (!silent) toast('已读取上次保存的输入');
      return true;
    } catch (e) { if (!silent) toast('本机保存的内容读不出来'); return false; }
  }

  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = function () {
      try {
        const o = JSON.parse(String(fr.result));
        const inp = o && o.input ? o.input : o;
        if (!inp || !inp.rows) throw new Error('结构不对');
        writeInput(inp);
        $('scenario').value = '';
        compute();
        toast('已导入备份（' + (o.app || '未知来源') + '）');
      } catch (e) { toast('这个备份文件读不出来'); }
    };
    fr.readAsText(file);
  }

  /* ── 事件绑定 ─────────────────────────────────────── */
  function bind() {
    const form = $('form');
    form.addEventListener('input', function (e) {
      if (e.target.matches('input[type=text]')) compute();
    });
    form.addEventListener('change', function (e) {
      if (e.target.matches('select, input[type=checkbox]')) { toggleCond(); compute(); }
    });
    $('rows').addEventListener('click', function (e) {
      const dup = e.target.getAttribute && e.target.getAttribute('data-dup');
      const del = e.target.getAttribute && e.target.getAttribute('data-del');
      if (dup !== null && dup !== undefined) {
        const res = state.res;
        if (res && res.rows.length >= C.MAX_ROWS) { toast('最多 ' + C.MAX_ROWS + ' 个方案'); return; }
        const src = readInput().rows[Number(dup)];
        $('rows').insertAdjacentHTML('beforeend', rowHTML({ name: (src.name + ' 副本').slice(0, C.NAME_MAX), sensor: src.sensor, f: src.f, N: src.N, s: src.s }, 0));
        reindex();
        compute(); toast('已复制');
        return;
      }
      if (del !== null && del !== undefined) {
        const items = $('rows').querySelectorAll('.item');
        if (items.length <= 1) { toast('至少保留一个方案'); return; }
        items[Number(del)].remove();
        reindex();
        state.sel = 0;
        compute();
        return;
      }
    });
    $('planBody').addEventListener('click', function (e) {
      const tr = e.target.closest ? e.target.closest('tr[data-i]') : null;
      if (!tr) return;
      state.sel = Number(tr.getAttribute('data-i'));
      render(state.res);
    });
    $('detailBody').addEventListener('click', function (e) {
      const act2 = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act2) act(act2);
    });
    $('btnAddRow').addEventListener('click', function () {
      const n = $('rows').querySelectorAll('.item').length;
      if (n >= C.MAX_ROWS) { toast('最多 ' + C.MAX_ROWS + ' 个方案'); return; }
      const last = readInput().rows[n - 1];
      $('rows').insertAdjacentHTML('beforeend', rowHTML({ name: '新方案 ' + (n + 1), sensor: last ? last.sensor : 'ff', f: last ? last.f : 50, N: last ? last.N : 8, s: last ? last.s : 3 }, n));
      reindex();
      compute();
    });
    $('btnDup').addEventListener('click', function () {
      const rows = readInput().rows;
      if (rows.length >= C.MAX_ROWS) { toast('最多 ' + C.MAX_ROWS + ' 个方案'); return; }
      const last = rows[rows.length - 1];
      $('rows').insertAdjacentHTML('beforeend', rowHTML({ name: (last.name + ' 副本').slice(0, C.NAME_MAX), sensor: last.sensor, f: last.f, N: last.N, s: last.s }, rows.length));
      reindex();
      compute();
    });
    $('btnReset').addEventListener('click', function () {
      writeInput(C.defaultsClone()); $('scenario').value = 'base'; compute(); toast('已恢复默认虚构示例');
    });
    $('btnSave').addEventListener('click', saveLocal);
    $('btnLoad').addEventListener('click', function () { if (loadLocal(false)) { $('scenario').value = ''; compute(); } });
    $('scenario').addEventListener('change', function (e) {
      const id = e.target.value;
      if (!id) return;
      const sc = C.scenarios.filter(function (s) { return s.id === id; })[0];
      if (!sc) return;
      const d = C.defaultsClone();
      const p = sc.patch;
      if (p.coc) d.coc = p.coc;
      if (p.target) d.target = p.target;
      if (p.rows) d.rows = p.rows;
      writeInput(d); state.sel = 0; compute(); toast('已换上场景：' + sc.name);
    });
    $('btnCsv').addEventListener('click', function () { if (!state.res) return toast('先让输入通过校验'); download('景深对账台.csv', csvText(), 'text/csv;charset=utf-8'); toast('CSV 已导出'); });
    $('btnMd').addEventListener('click', function () { if (!state.res) return toast('先让输入通过校验'); download('景深对账台.md', mdText(), 'text/markdown;charset=utf-8'); toast('Markdown 已导出'); });
    $('btnJson').addEventListener('click', function () { if (!state.res) return toast('先让输入通过校验'); download('景深对账台-备份.json', jsonBackup(), 'application/json'); toast('JSON 备份已导出'); });
    $('btnPng').addEventListener('click', function () { if (!state.res) return toast('先让输入通过校验'); pngCard(); toast('结果卡 PNG 正在生成'); });
    $('btnPrint').addEventListener('click', function () { window.print(); });
    $('importFile').addEventListener('change', function (e) { if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]); });
  }

  function boot() {
    fillSelects();
    writeInput(C.defaultsClone());
    $('scenario').value = 'base';
    bind();
    compute();
    const saved = loadLocal(true);
    if (saved) { $('scenario').value = ''; compute(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 给验收脚本用的只读钩子（不改变页面行为） */
  window.__dof = {
    state: state,
    res: function () { return state.res; },
    checks: function () { return state.checks; },
    renderCount: function () { return state.renders; }
  };
})();
