/* 景深对账台 · 核心引擎（dof-ledger）
 *
 * 问题：我想让这一段距离都拍清楚 —— 对焦该放在哪？光圈最小开多大？再收小还有没有意义？
 *
 * 口径（详见 需求与调研.md 第 4 节）：
 *   D    = √(W² + H²)                     画幅对角线（mm）
 *   c    = D ÷ divisor                    弥散圆（显示约定，不是物理常数）
 *   H    = f²/(N·c) + f                   超焦距
 *   Dn   = s(H − f)/(H + s − 2f)          近点
 *   Df   = s(H − f)/(H − s)              远点（s ≥ H 时为 ∞）
 *   前/后景深 = s − Dn / Df − s
 *   b    = f²/(N(s − f))                  无限远背景的弥散圆直径
 *   dA   = 2.44·λ·N                       艾里斑第一暗环直径
 *   N_d  = c/(2.44·λ)                     衍射转折光圈
 *   k    = 43.2666153 ÷ D                 等效系数（参照全画幅）
 *
 * 反推（闭式解）：要让目标区间 [Dn*, Df*] 完整落入景深 ——
 *   远点有限： s* = 2·Dn*·Df* ÷ (Dn* + Df*)      （调和平均，与 c、N 无关）
 *              N* = (Df* − Dn*)·s*·f² ÷ (2·c·(s* − f)·Dn*·Df*)
 *   远点 = ∞： s* = 2·Dn*
 *              N* = f² / (c·(2·Dn* − f))
 *
 * 单位：内部长度一律 mm（对外用 m/cm/mm），λ 用 mm。
 * 薄透镜理想化：所有距离都是相对镜头的物距；光瞳放大率按 1 处理。
 */
(function (root) {
  'use strict';

  const MM_PER_M = 1000;
  const DIAG_FF = Math.hypot(36, 24);      // 43.266615305567875
  const MAX_ROWS = 8;
  const NAME_MAX = 20;

  const F_MIN = 1, F_MAX = 2000;           // mm
  const N_MIN = 0.7, N_MAX = 64;           // f/
  const S_MIN = 0.03, S_MAX = 100000;      // m
  const LAM_MIN = 380, LAM_MAX = 780;      // nm
  const TGT_MIN = 0.01, TGT_MAX = 100000;  // m
  const C_MIN = 0.001, C_MAX = 0.5;        // mm
  const PX_MIN = 1000, PX_MAX = 20000;
  const DIM_MIN = 1, DIM_MAX = 300;        // mm（自定义画幅宽/高）
  const CLOSE_FOCUS_M = 0.1;               // 放大率超过它就提醒近摄偏差
  /* 等效口径只是 f ≪ s 时的近似：偏差会随「远点 ÷ 对焦距离」放大。
     实测（默认 6 方案）最大近点偏差 0.57%、最大远点偏差 3.74%，
     所以允许的相对偏差取 5%，并把这个实测值如实写在页面与报告里。 */
  const EQUIV_TOL = 0.05;
  const SOLVE_FS = [16, 24, 35, 50, 85, 135];   // 反推对照用的焦距档

  const r2 = (x) => Math.round(x * 100) / 100;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const fin = (x) => typeof x === 'number' && isFinite(x);

  /* ── 画幅 ────────────────────────────────────────────── */
  const SENSORS = [
    { id: 'phone23', name: '1/2.3 英寸（多数手机主摄）', w: 6.17, h: 4.55 },
    { id: 'phone1', name: '1 英寸（大底手机 / 卡片机）', w: 13.2, h: 8.8 },
    { id: 'm43', name: 'M4/3（4/3 画幅）', w: 17.3, h: 13.0 },
    { id: 'apsc_c', name: 'APS-C（佳能 1.6×）', w: 22.3, h: 14.9 },
    { id: 'apsc', name: 'APS-C（尼康 / 索尼 1.5×）', w: 23.5, h: 15.6 },
    { id: 'ff', name: '全画幅（36×24）', w: 36, h: 24 },
    { id: 'mf4433', name: '中画幅 44×33', w: 44, h: 33 },
    { id: 'custom', name: '自定义画幅尺寸', w: 36, h: 24 }
  ];
  const SENSOR_BY_ID = {};
  SENSORS.forEach((s) => { SENSOR_BY_ID[s.id] = s; });

  function sensorDims(id, custom) {
    const s = SENSOR_BY_ID[id] || SENSOR_BY_ID.ff;
    if (s.id === 'custom') {
      const c = custom || {};
      return { id: 'custom', name: '自定义画幅（' + fmtNum(c.w, 1) + '×' + fmtNum(c.h, 1) + ' mm）', w: c.w, h: c.h };
    }
    return { id: s.id, name: s.name, w: s.w, h: s.h };
  }
  function sensorDiag(dims) { return Math.hypot(dims.w, dims.h); }

  /* ── 弥散圆口径 ──────────────────────────────────────── */
  const COC_MODES = [
    { id: 'diag1500', name: '对角线 ÷ 1500（常用约定）', divisor: 1500 },
    { id: 'diag1730', name: '对角线 ÷ 1730（更严格）', divisor: 1730 },
    { id: 'diag1000', name: '对角线 ÷ 1000（更宽松）', divisor: 1000 },
    { id: 'pixel', name: '像素级：2 × 像元尺寸', divisor: null },
    { id: 'custom', name: '自定义弥散圆 c', divisor: null }
  ];
  const COC_BY_ID = {};
  COC_MODES.forEach((m) => { COC_BY_ID[m.id] = m; });

  function cocFor(cocCfg, dims) {
    const mode = COC_BY_ID[cocCfg.mode] ? cocCfg.mode : 'diag1500';
    const diag = sensorDiag(dims);
    if (mode === 'custom') return { mode: mode, c: cocCfg.c, source: '自定义弥散圆 ' + fmtNum(cocCfg.c, 5) + ' mm' };
    if (mode === 'pixel') {
      const pitch = dims.w / cocCfg.px;      // mm
      return { mode: mode, c: 2 * pitch, source: '像素级：2 × 像元 ' + fmtNum(pitch * 1000, 3) + ' µm（' + cocCfg.px + ' px 横向）' };
    }
    const m = COC_BY_ID[mode];
    return { mode: mode, c: diag / m.divisor, source: '对角线 ' + fmtNum(diag, 3) + ' mm ÷ ' + m.divisor };
  }

  /* ── 默认（虚构示例，页面上必须明说） ───────────────── */
  const defaults = {
    coc: { mode: 'diag1500', px: 6000, c: 0.029 },
    lambda: 550,
    refSensor: 'ff',
    solveF: 50,
    customSensor: { w: 36, h: 24 },
    target: { near: 2.0, far: 5.0, farInf: false },
    rows: [
      { name: '广角 24mm f/8', sensor: 'ff', f: 24, N: 8, s: 3 },
      { name: '标准 50mm f/2.8', sensor: 'ff', f: 50, N: 2.8, s: 3 },
      { name: '标准 50mm f/8', sensor: 'ff', f: 50, N: 8, s: 3 },
      { name: '标准 50mm f/16', sensor: 'ff', f: 50, N: 16, s: 3 },
      { name: '中长焦 85mm f/4', sensor: 'ff', f: 85, N: 4, s: 4 },
      { name: '手机主摄 4.3mm f/1.8', sensor: 'phone23', f: 4.3, N: 1.8, s: 1.5 }
    ]
  };

  /* 场景：只改数字，改完可由页面「一键换上」；全部为虚构示例 */
  const scenarios = [
    { id: 'base', name: '默认·一台全画幅 + 一台手机（虚构）', patch: {} },
    {
      id: 'phoneonly', name: '只带手机：想让 1 m 到无限远都清晰',
      patch: {
        target: { near: 1, far: 5, farInf: true },
        coc: { mode: 'diag1500', px: 6000, c: 0.029 },
        rows: [
          { name: '手机主摄 4.3mm f/1.8', sensor: 'phone23', f: 4.3, N: 1.8, s: 1.5 },
          { name: '手机主摄 4.3mm f/4', sensor: 'phone23', f: 4.3, N: 4, s: 1.5 },
          { name: '手机主摄 4.3mm f/8', sensor: 'phone23', f: 4.3, N: 8, s: 1.5 },
          { name: '手机长焦 9.5mm f/2.4', sensor: 'phone23', f: 9.5, N: 2.4, s: 1.5 }
        ]
      }
    },
    {
      id: 'portrait', name: '人像虚化：85mm f/1.4，只求眼睛清晰（虚构）',
      patch: {
        target: { near: 2.9, far: 3.1, farInf: false },
        rows: [
          { name: '85mm f/1.4', sensor: 'ff', f: 85, N: 1.4, s: 3 },
          { name: '85mm f/2.8', sensor: 'ff', f: 85, N: 2.8, s: 3 },
          { name: '50mm f/1.4', sensor: 'ff', f: 50, N: 1.4, s: 3 }
        ]
      }
    },
    {
      id: 'landscape', name: '风光全景深：24mm，目标 1 m 到无限远（虚构）',
      patch: {
        target: { near: 1, far: 5, farInf: true },
        rows: [
          { name: '24mm f/5.6', sensor: 'ff', f: 24, N: 5.6, s: 2 },
          { name: '24mm f/8', sensor: 'ff', f: 24, N: 8, s: 2 },
          { name: '24mm f/11', sensor: 'ff', f: 24, N: 11, s: 2 },
          { name: '24mm f/16', sensor: 'ff', f: 24, N: 16, s: 2 }
        ]
      }
    },
    {
      id: 'macro', name: '近摄：APS-C 100mm f/8，目标 0.48–0.52 m（虚构）',
      patch: {
        target: { near: 0.48, far: 0.52, farInf: false },
        rows: [
          { name: '100mm f/8 对焦 0.5m', sensor: 'apsc', f: 100, N: 8, s: 0.5 },
          { name: '100mm f/16 对焦 0.5m', sensor: 'apsc', f: 100, N: 16, s: 0.5 },
          { name: '100mm f/8 对焦 0.4m', sensor: 'apsc', f: 100, N: 8, s: 0.4 }
        ]
      }
    },
    {
      id: 'small', name: '小底衍射对照：手机主摄收到 f/8（虚构）',
      patch: {
        target: { near: 1, far: 5, farInf: true },
        rows: [
          { name: '4.3mm f/1.8', sensor: 'phone23', f: 4.3, N: 1.8, s: 1.5 },
          { name: '4.3mm f/4', sensor: 'phone23', f: 4.3, N: 4, s: 1.5 },
          { name: '4.3mm f/5.6', sensor: 'phone23', f: 4.3, N: 5.6, s: 1.5 },
          { name: '4.3mm f/8', sensor: 'phone23', f: 4.3, N: 8, s: 1.5 }
        ]
      }
    }
  ];

  /* ── 格式化 ─────────────────────────────────────────── */
  function fmtNum(x, d) {
    if (!fin(x)) return x === Infinity ? '∞' : '—';
    return x.toFixed(d);
  }
  /* 距离：对外一律用 m，极小值转 mm */
  function fmtDist(m) {
    if (m === Infinity) return '∞';
    if (!fin(m)) return '—';
    const a = Math.abs(m);
    if (a < 0.1) return fmtNum(m * 1000, 1) + ' mm';
    if (a < 10) return fmtNum(m, 3) + ' m';
    if (a < 1000) return fmtNum(m, 2) + ' m';
    return fmtNum(m, 1) + ' m';
  }
  /* 长度：对外用 mm（弥散圆、艾里斑） */
  function fmtMm(mm) {
    if (!fin(mm)) return '—';
    const a = Math.abs(mm);
    if (a === 0) return '0 mm';
    if (a < 0.001) {
      /* 别把「很小但非零」显示成 0.000 —— 那等于说「没有残差」 */
      return (a * 1000 < 0.0005) ? '< 0.001 µm' : fmtNum(mm * 1000, 3) + ' µm';
    }
    if (a < 0.01) return fmtNum(mm, 5) + ' mm';
    if (a < 1) return fmtNum(mm, 4) + ' mm';
    if (a < 10) return fmtNum(mm, 3) + ' mm';
    return fmtNum(mm, 2) + ' mm';
  }
  function fmtPct(x, d) { return fin(x) ? fmtNum(x, d === undefined ? 2 : d) + '%' : '—'; }

  /* ── 解析与校验 ─────────────────────────────────────── */
  function parseNum(v, opt) {
    const label = opt.label || '数值';
    let s;
    if (typeof v === 'number') {
      if (!isFinite(v)) return { ok: false, msg: label + '必须是有限数字' };
      s = String(v);
    } else if (typeof v === 'string') {
      s = v.replace(/[,\s　]/g, '');
    } else {
      return { ok: false, msg: label + '不能为空' };
    }
    if (s === '') return { ok: false, msg: label + '不能为空' };
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, msg: label + '只能填数字（可带小数）' };
    const x = Number(s);
    if (!isFinite(x)) return { ok: false, msg: label + '超出可处理范围' };
    if (opt.min !== undefined && x < opt.min) return { ok: false, msg: label + '不能小于 ' + opt.min };
    if (opt.max !== undefined && x > opt.max) return { ok: false, msg: label + '不能大于 ' + opt.max };
    return { ok: true, value: x };
  }
  function num(v) { return typeof v === 'number' ? v : Number(String(v).replace(/[,\s　]/g, '')); }

  /* 规范化 + 校验。返回 { ok, cfg, errors, warnings }，不抛异常。 */
  function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const errors = [], warnings = [];
    const cfg = { coc: {}, customSensor: {}, target: {}, rows: [] };

    /* 自定义画幅尺寸（只有用到 custom 时才校验） */
    const cs = src.customSensor || {};
    let csOk = true;
    [['w', cs.w, '自定义画幅宽', DIM_MIN, DIM_MAX],
     ['h', cs.h, '自定义画幅高', DIM_MIN, DIM_MAX]].forEach(([k, v, label, min, max]) => {
      const p = parseNum(v === undefined && k === 'w' ? 36 : (v === undefined ? 24 : v), { label: label, min: min, max: max });
      if (!p.ok) { errors.push({ row: 0, field: 'customSensor.' + k, msg: p.msg }); csOk = false; }
      else cfg.customSensor[k] = p.value;
    });
    if (csOk && cfg.customSensor.w && cfg.customSensor.h) {
      const dg = Math.hypot(cfg.customSensor.w, cfg.customSensor.h);
      if (dg < 3) errors.push({ row: 0, field: 'customSensor', msg: '自定义画幅对角线只有 ' + fmtNum(dg, 2) + ' mm，太小' });
    }

    /* 弥散圆口径 */
    const cocSrc = src.coc || {};
    const mode = COC_BY_ID[cocSrc.mode] ? cocSrc.mode : 'diag1500';
    cfg.coc.mode = mode;
    if (mode === 'pixel') {
      const p = parseNum(cocSrc.px, { label: '横向像素数', min: PX_MIN, max: PX_MAX });
      if (!p.ok) errors.push({ row: 0, field: 'coc.px', msg: p.msg }); else cfg.coc.px = Math.round(p.value);
    } else if (mode === 'custom') {
      const p = parseNum(cocSrc.c, { label: '自定义弥散圆 c', min: C_MIN, max: C_MAX });
      if (!p.ok) errors.push({ row: 0, field: 'coc.c', msg: p.msg + '（单位 mm）' }); else cfg.coc.c = p.value;
    }

    /* 波长 */
    const lp = parseNum(src.lambda, { label: '波长 λ', min: LAM_MIN, max: LAM_MAX });
    if (!lp.ok) errors.push({ row: 0, field: 'lambda', msg: lp.msg + '（单位 nm）' }); else cfg.lambda = lp.value;

    /* 对照画幅 */
    const ref = SENSOR_BY_ID[src.refSensor] ? src.refSensor : 'ff';
    cfg.refSensor = ref === 'custom' ? 'ff' : ref;

    /* 反推用的焦距 */
    const sf = parseNum(src.solveF, { label: '反推用焦距', min: F_MIN, max: F_MAX });
    if (!sf.ok) errors.push({ row: 0, field: 'solveF', msg: sf.msg + '（单位 mm）' }); else cfg.solveF = sf.value;

    /* 目标区间 */
    const tg = src.target || {};
    const np = parseNum(tg.near, { label: '目标近点', min: TGT_MIN, max: TGT_MAX });
    if (!np.ok) errors.push({ row: 0, field: 'target.near', msg: np.msg + '（单位 m）' }); else cfg.target.near = np.value;
    cfg.target.farInf = !!tg.farInf;
    if (cfg.target.farInf) {
      cfg.target.far = Infinity;
    } else {
      const fp = parseNum(tg.far, { label: '目标远点', min: TGT_MIN, max: TGT_MAX });
      if (!fp.ok) errors.push({ row: 0, field: 'target.far', msg: fp.msg + '（单位 m）' }); else cfg.target.far = fp.value;
      if (np.ok && fp.ok && fp.value <= np.value) {
        errors.push({ row: 0, field: 'target.far', msg: '目标远点（' + fp.value + ' m）必须大于目标近点（' + np.value + ' m）；只有一端要清晰的情况，请把近点填成你要的那一端' });
      }
    }

    /* 方案清单 */
    const rows = Array.isArray(src.rows) ? src.rows : [];
    if (rows.length === 0) errors.push({ row: 0, field: 'rows', msg: '至少要有 1 个方案' });
    if (rows.length > MAX_ROWS) errors.push({ row: 0, field: 'rows', msg: '最多支持 ' + MAX_ROWS + ' 个方案，当前 ' + rows.length + ' 个' });

    rows.slice(0, MAX_ROWS).forEach((it, i) => {
      const row = i + 1;
      const r = {};
      const name = String((it && it.name) != null ? it.name : '').trim();
      if (!name) errors.push({ row, field: 'name', msg: '第 ' + row + ' 个方案：名称不能为空' });
      if (name.length > NAME_MAX) errors.push({ row, field: 'name', msg: '第 ' + row + ' 个方案：名称不能超过 ' + NAME_MAX + ' 字' });
      r.name = name;

      const sid = it && SENSOR_BY_ID[it.sensor] ? it.sensor : 'ff';
      r.sensor = sid;
      r.dims = sensorDims(sid, cfg.customSensor);
      if (sid === 'custom' && !csOk) { /* 尺寸错误已在上面报过 */ }

      let bad = false;
      [['f', it && it.f, '焦距', F_MIN, F_MAX],
       ['N', it && it.N, '光圈 f/', N_MIN, N_MAX],
       ['s', it && it.s, '对焦距离', S_MIN, S_MAX]].forEach(([k, v, label, min, max]) => {
        const p = parseNum(v, { label: '第 ' + row + ' 个方案：' + label, min: min, max: max });
        if (!p.ok) { errors.push({ row, field: k, msg: p.msg + (k === 's' ? '（单位 m）' : '') }); bad = true; }
        else r[k] = p.value;
      });
      if (bad) return;

      if (r.s * MM_PER_M <= r.f) {
        errors.push({ row, field: 's', msg: '第 ' + row + ' 个方案：对焦距离（' + r.s + ' m）必须大于焦距（' + r.f + ' mm = ' + fmtNum(r.f / 1000, 4) + ' m），否则物不成像' });
        return;
      }
      const mag = r.f / (r.s * MM_PER_M - r.f);        // 放大率
      r.mag = mag;
      r.closeFocus = mag > CLOSE_FOCUS_M;
      cfg.rows.push(r);
    });

    if (cfg.rows.length === 0 && errors.length === 0) {
      errors.push({ row: 0, field: 'rows', msg: '没有可用的方案' });
    }

    if (cfg.target.farInf && cfg.target.near !== undefined) {
      warnings.push('目标远点取「无限远」：任何有限的远点都必须盖到这里，所以判定按「远点必须是 ∞」算。');
    }
    if (cfg.coc.mode === 'custom') warnings.push('弥散圆用的是自定义 c：这个值直接决定「多小算清晰」，是本页唯一的显示约定。');
    if (cfg.coc.mode === 'pixel') warnings.push('弥散圆按「2 × 像元尺寸」算：这是「像素级清晰」的口径，比常用的对角线÷1500 更严格。');
    cfg.rows.forEach((r, i) => {
      const cc = cocFor(cfg.coc, r.dims).c;
      if (r.N * cc >= r.f) {
        warnings.push('第 ' + (i + 1) + ' 个方案（' + r.name + '）的 N·c = ' + fmtNum(r.N * cc, 5) +
          ' mm 已不小于焦距 ' + fmtNum(r.f, 2) + ' mm：超焦距不超过 2f，属于「从很近到无限远几乎都清晰」的退化口径，前后景深的常规直觉不再适用。');
      }
      if (r.closeFocus) warnings.push('第 ' + (i + 1) + ' 个方案（' + r.name + '）的放大率约 1:' + fmtNum(1 / r.mag, 2) + '，已进入近摄区间：本页按光瞳放大率 = 1 的标准公式计算，结论偏差可能变大。');
    });

    if (errors.length) return { ok: false, cfg: cfg, errors: errors, warnings: warnings };
    return { ok: true, cfg: cfg, errors: [], warnings: warnings };
  }

  /* ── 单个方案的光学计算（纯函数，单位 mm） ───────────── */
  /* s 与 H 相等时远点必须是 ∞；浮点下 H 会差最后几位，所以用相对容差判等 */
  const H_REL_TOL = 1e-12;
  function optics(f, N, sMm, c, lambdaMm) {
    const H = f * f / (N * c) + f;
    const dn = sMm * (H - f) / (H + sMm - 2 * f);
    const dfInf = sMm >= H * (1 - H_REL_TOL);
    const df = dfInf ? Infinity : sMm * (H - f) / (H - sMm);
    const front = sMm - dn;
    const back = df === Infinity ? Infinity : df - sMm;
    const total = df === Infinity ? Infinity : df - dn;
    const blurInf = f * f / (N * (sMm - f));       // 无限远背景的弥散圆直径（mm）
    const airy = 2.44 * lambdaMm * N;              // 艾里斑第一暗环直径（mm）
    const nDiff = c / (2.44 * lambdaMm);           // 衍射转折光圈
    return {
      H: H, dn: dn, df: df, front: front, back: back, total: total,
      dfInf: dfInf, blurInf: blurInf, airy: airy, nDiff: nDiff
    };
  }

  /* 目标区间覆盖：返回判定与两端缺口（mm） */
  function coverage(dn, df, nearMm, farMm, farInf) {
    const gapNear = Math.max(0, dn - nearMm);
    const gapFar = farInf ? (df === Infinity ? 0 : Infinity) : Math.max(0, farMm - df);
    let verdict, label;
    if (gapNear <= 0 && gapFar <= 0) { verdict = 'cover'; label = '覆盖完整'; }
    else if (gapNear > 0 && gapFar > 0) { verdict = 'both'; label = '两头都不够'; }
    else if (gapNear > 0) { verdict = 'near'; label = '近端不够'; }
    else { verdict = 'far'; label = '远端不够'; }
    return { verdict: verdict, label: label, gapNear: gapNear, gapFar: gapFar, covered: verdict === 'cover' };
  }

  /* 逐方案完整计算 */
  function rowResult(r, cfg) {
    const dims = r.dims;
    const coc = cocFor(cfg.coc, dims);
    const c = coc.c;
    const lambdaMm = cfg.lambda / 1e6;
    const sMm = r.s * MM_PER_M;
    const o = optics(r.f, r.N, sMm, c, lambdaMm);
    const cov = coverage(o.dn, o.df, cfg.target.near * MM_PER_M,
      cfg.target.far === Infinity ? Infinity : cfg.target.far * MM_PER_M, cfg.target.farInf);
    const diag = sensorDiag(dims);
    const refDims = sensorDims(cfg.refSensor, cfg.customSensor);
    const refDiag = sensorDiag(refDims);
    const k = refDiag / diag;

    /* 等效口径：同视角 + 同景深地搬到对照画幅；因 f 项不严格相等，如实给出偏差
       闭式：令 A = cN(s−f)、B = cNf(k−1)，则
         近点相对偏差 = |B| ÷ (f² + A − B)
         远点相对偏差 = |B| ÷ |f² − A + B|      （仅在原方案与等效方案的远点都有限时适用） */
    const fEq = r.f * k, NEq = r.N * k;
    /* 等效口径下弥散圆必须同比缩放（c′ = c·k）：自定义 c 与像素级口径同样按比例搬过去；
       对角线÷n 口径下 c′ 恰好等于对照画幅对角线÷n，两种写法一致。 */
    const cRef = (coc.mode === 'custom' || coc.mode === 'pixel')
      ? c * k
      : refDiag / COC_BY_ID[coc.mode].divisor;
    const oEq = optics(fEq, NEq, sMm, cRef, lambdaMm);
    /* 等效口径只在「等效后仍能对焦」时才有意义：等效焦距可能已经不小于对焦距离 */
    const eqValid = sMm > fEq;
    const eqA = c * r.N * (sMm - r.f);
    const eqB = c * r.N * r.f * (k - 1);
    const eqDenNear = r.f * r.f + eqA - eqB;
    const eqDenFar = r.f * r.f - eqA + eqB;
    const eqDevNear = !eqValid ? null : (o.dn > 0 ? Math.abs(oEq.dn - o.dn) / o.dn : 0);
    const eqDevFar = !eqValid ? null
      : (o.df === Infinity && oEq.df === Infinity) ? 0
        : (o.df === Infinity || oEq.df === Infinity) ? null
          : Math.abs(oEq.df - o.df) / o.df;
    const eqPredNear = !eqValid ? null : Math.abs(eqB) / Math.abs(eqDenNear);
    const eqPredFar = !eqValid ? null
      : (o.df === Infinity || oEq.df === Infinity || eqDenFar === 0) ? null
        : Math.abs(eqB) / Math.abs(eqDenFar);
    /* 按 k 缩放的闭式解：等效方案的近点/远点必须精确等于它（这是恒等式，用来验算实现） */
    const eqDnClosed = (fEq > 0 && sMm > fEq) ? r.f * r.f * sMm / eqDenNear : null;
    const eqDfClosed = (fEq > 0 && sMm > fEq && eqDenFar !== 0) ? r.f * r.f * sMm / eqDenFar : null;

    const frameH = dims.h;
    return {
      name: r.name, sensor: r.sensor, sensorName: dims.name,
      sensorDiag: diag, crop: k,
      f: r.f, N: r.N, s: r.s, mag: r.mag, closeFocus: r.closeFocus,
      cocMode: cfg.coc.mode, coc: c, cocSource: coc.source,
      H: o.H / MM_PER_M, dn: o.dn / MM_PER_M, df: o.df === Infinity ? Infinity : o.df / MM_PER_M,
      front: o.front / MM_PER_M,
      back: o.back === Infinity ? Infinity : o.back / MM_PER_M,
      total: o.total === Infinity ? Infinity : o.total / MM_PER_M,
      dfInf: o.dfInf,
      ratioBack: o.back === Infinity ? Infinity : o.back / o.front,
      frontShare: o.total === Infinity ? null : o.front / o.total,
      blurInf: o.blurInf, blurPct: o.blurInf / frameH * 100,
      frameH: frameH,
      airy: o.airy, nDiff: o.nDiff, diffractionLimited: r.N > o.nDiff,
      cover: cov.verdict, coverLabel: cov.label, covered: cov.covered,
      gapNear: cov.gapNear / MM_PER_M,
      gapFar: cov.gapFar === Infinity ? Infinity : cov.gapFar / MM_PER_M,
      near: cfg.target.near, far: cfg.target.far === Infinity ? Infinity : cfg.target.far, farInf: cfg.target.farInf,
      fEq: fEq, NEq: NEq, refSensorName: refDims.name,
      eqValid: eqValid,
      eqDn: !eqValid ? null : oEq.dn / MM_PER_M,
      eqDf: !eqValid ? null : (oEq.df === Infinity ? Infinity : oEq.df / MM_PER_M),
      eqDnClosed: eqDnClosed === null ? null : eqDnClosed / MM_PER_M,
      eqDfClosed: eqDfClosed === null ? null : eqDfClosed / MM_PER_M,
      eqDevNear: eqDevNear, eqDevFar: eqDevFar,
      eqPredNear: eqPredNear, eqPredFar: eqPredFar,
      depthNote: cfg.coc.mode
    };
  }

  /* ── 反推：让目标区间完整落入景深 ───────────────────── */
  /* 同一目标区间下，不同焦距各需要多大的最小光圈（s* 与 f 无关，N* 随 f² 增长） */
  function solveTable(cfg) {
    const near = cfg.target.near * MM_PER_M;
    const farInf = cfg.target.farInf;
    const far = farInf ? Infinity : cfg.target.far * MM_PER_M;
    const refDims = sensorDims(cfg.refSensor, cfg.customSensor);
    const coc = cocFor(cfg.coc, cfg.rows.length ? cfg.rows[0].dims : refDims);
    const c = coc.c;
    const sStar = farInf ? 2 * near : 2 * near * far / (near + far);
    const out = [];
    SOLVE_FS.forEach((f) => {
      let n = null, why = '';
      if (sStar - f <= 0) { why = '对焦距离不超过焦距'; }
      else if (farInf) { n = f * f / (c * (2 * near - f)); }
      else { n = (far - near) * sStar * f * f / (2 * c * (sStar - f) * near * far); }
      if (n !== null && !fin(n)) { n = null; why = '算不出有限值'; }
      let feasible = true;
      if (n === null) feasible = false;
      else if (n > N_MAX) { feasible = false; why = '需要 f/' + fmtNum(n, 2) + '，超过上限 f/' + N_MAX; }
      else if (n < N_MIN) { feasible = false; why = '需要 f/' + fmtNum(n, 3) + '，比 f/' + N_MIN + ' 还大'; }
      out.push({
        f: f, sStar: sStar / MM_PER_M, nStar: n, feasible: feasible, why: why,
        label: feasible ? 'f/' + fmtNum(n, 2) : '做不到'
      });
    });
    return { sStar: sStar / MM_PER_M, rows: out };
  }

  function solveTarget(cfg, fRef) {
    const near = cfg.target.near * MM_PER_M;
    const farInf = cfg.target.farInf;
    const far = farInf ? Infinity : cfg.target.far * MM_PER_M;
    const f = fRef;                                   // 用一个参考焦距反推（默认取第一个方案）
    const refDims = sensorDims(cfg.refSensor, cfg.customSensor);
    const coc = cocFor(cfg.coc, cfg.rows.length ? cfg.rows[0].dims : refDims);
    const c = coc.c;
    const out = {
      ok: false, feasible: false, reason: '',
      near: cfg.target.near, far: farInf ? Infinity : cfg.target.far, farInf: farInf,
      f: f, coc: c, cocSource: coc.source,
      sStar: null, nStar: null, backDn: null, backDf: null, errNear: null, errFar: null,
      naive: null
    };

    let sStar, nStar;
    if (farInf) {
      if (2 * near - f <= 0) {
        out.reason = '目标近点只有 ' + fmtDist(cfg.target.near) + '，而焦距是 ' + fmtNum(f, 1) + ' mm：要让这么近的地方到无限远都清晰，在几何上做不到（需要近点大于 f/2 = ' + fmtDist(f / 2 / MM_PER_M) + '）。';
        return out;
      }
      sStar = 2 * near;
      nStar = f * f / (c * (2 * near - f));
    } else {
      sStar = 2 * near * far / (near + far);
      if (sStar - f <= 0) {
        out.reason = '反推出的对焦距离（' + fmtDist(sStar / MM_PER_M) + '）不大于焦距（' + fmtDist(f / MM_PER_M) + '）：这个目标区间在几何上无法同时覆盖。';
        return out;
      }
      nStar = (far - near) * sStar * f * f / (2 * c * (sStar - f) * near * far);
    }

    out.sStar = sStar / MM_PER_M;
    out.nStar = nStar;

    if (!fin(nStar) || nStar <= 0) {
      out.reason = '反推出的光圈不是正数，这个目标区间无法用本页的模型覆盖。';
      return out;
    }
    if (nStar > N_MAX) {
      out.reason = '需要把光圈收到 f/' + fmtNum(nStar, 2) + '，已经超出本页可处理的上限 f/' + N_MAX + '（现实里也基本没有这样的镜头）：这个目标区间做不到。';
      return out;
    }
    if (nStar < N_MIN) {
      out.reason = '需要的光圈是 f/' + fmtNum(nStar, 3) + '，比本页下限 f/' + N_MIN + ' 还要快（现实里没有这样的镜头）：这个目标区间太窄了，现实中景深会比你想要的更深，无法把清晰范围「限制」得这么小。';
      return out;
    }
    if (sStar / MM_PER_M < S_MIN || sStar / MM_PER_M > S_MAX) {
      out.reason = '反推出的对焦距离 ' + fmtDist(out.sStar) + ' 超出本页可处理范围。';
      return out;
    }

    out.ok = true;
    out.feasible = true;
    const lambdaMm = cfg.lambda / 1e6;
    const o = optics(f, nStar, sStar, c, lambdaMm);
    out.backDn = o.dn / MM_PER_M;
    out.backDf = o.df === Infinity ? Infinity : o.df / MM_PER_M;
    out.errNear = Math.abs(o.dn - near);
    out.errFar = farInf ? (o.df === Infinity ? 0 : Infinity)
      : (o.df === Infinity ? Infinity : Math.abs(o.df - far));

    /* 常见做法对照：对焦在算术中点 */
    const sNaive = farInf ? near * 2 : (near + far) / 2;
    const oN = optics(f, nStar, sNaive, c, lambdaMm);
    const covN = coverage(oN.dn, oN.df, near, far, farInf);
    out.naive = {
      s: sNaive / MM_PER_M,
      dn: oN.dn / MM_PER_M,
      df: oN.df === Infinity ? Infinity : oN.df / MM_PER_M,
      cover: covN.verdict, coverLabel: covN.label, covered: covN.covered,
      gapNear: covN.gapNear / MM_PER_M,
      gapFar: covN.gapFar === Infinity ? Infinity : covN.gapFar / MM_PER_M
    };
    return out;
  }

  /* ── 「一键采用」用的取整解 ──────────────────────────
   * 闭式解给出的是实数；填进输入框必须取整。光圈一律**向上**取整（宁深不浅），
   * 对焦距离取 4 位小数；取整后回代重算并把覆盖判定一起返回——
   * 按钮给出的设置必须真的满足目标区间，这是本页的可操作性底线。
   */
  function applySolve(cfg, f, rowDims) {
    const rv = solveTarget(cfg, f);
    if (!rv.ok) return { ok: false, reason: rv.reason };
    const s = Math.round(rv.sStar * 10000) / 10000;
    const N = Math.ceil(rv.nStar * 100) / 100;
    if (N > N_MAX) return { ok: false, reason: '取整后需要 f/' + fmtNum(N, 2) + '，超过本页上限 f/' + N_MAX };
    if (s * MM_PER_M <= f) return { ok: false, reason: '取整后的对焦距离（' + fmtDist(s) + '）不大于焦距' };
    const dims = rowDims || (cfg.rows.length ? cfg.rows[0].dims : sensorDims(cfg.refSensor, cfg.customSensor));
    const c = cocFor(cfg.coc, dims).c;
    const o = optics(f, N, s * MM_PER_M, c, cfg.lambda / 1e6);
    const nearMm = cfg.target.near * MM_PER_M;
    const farMm = cfg.target.far === Infinity ? Infinity : cfg.target.far * MM_PER_M;
    const cov = coverage(o.dn, o.df, nearMm, farMm, cfg.target.farInf);
    return {
      ok: true, f: f, s: s, N: N, sStar: rv.sStar, nStar: rv.nStar,
      dn: o.dn / MM_PER_M, df: o.df === Infinity ? Infinity : o.df / MM_PER_M,
      cover: cov.verdict, coverLabel: cov.label, covered: cov.covered,
      gapNear: cov.gapNear / MM_PER_M,
      gapFar: cov.gapFar === Infinity ? Infinity : cov.gapFar / MM_PER_M
    };
  }

  /* ── 两条恒等式（独立于方案清单，用第一个方案的 f/N/c 演示） ── */
  function laws(cfg) {
    const r0 = cfg.rows[0];
    const dims = r0.dims;
    const c = cocFor(cfg.coc, dims).c;
    const lambdaMm = cfg.lambda / 1e6;
    const f = r0.f, N = r0.N;

    /* ① 对焦在超焦距：近点 = H/2、远点 = ∞ */
    const oH = optics(f, N, 0, c, lambdaMm);
    const H = oH.H;
    const o = optics(f, N, H, c, lambdaMm);

    /* ② 对焦在 H/3：前 : 后 = H : (2H − 3f)，前段占总景深 H/(3(H−f)) */
    const s3 = H / 3;
    const o3 = optics(f, N, s3, c, lambdaMm);
    const predRatio = (2 * H - 3 * f) / H;
    const predShare = H / (3 * (H - f));

    /* 对焦位置口径对照：同一个 H，把对焦放在 H、H/2、H/3 上各得到什么 */
    const compare = [{ mult: 1, label: '对焦在超焦距 H' }, { mult: 0.5, label: '对焦在 H ÷ 2' }, { mult: 1 / 3, label: '对焦在 H ÷ 3' }]
      .map((x) => {
        const o = optics(f, N, H * x.mult, c, lambdaMm);
        return {
          label: x.label, mult: x.mult, s: H * x.mult / MM_PER_M,
          dn: o.dn / MM_PER_M, df: o.df === Infinity ? Infinity : o.df / MM_PER_M,
          total: o.total === Infinity ? Infinity : o.total / MM_PER_M,
          dfInf: o.dfInf
        };
      });

    return {
      f: f, N: N, c: c, H: H / MM_PER_M, sensorName: dims.name, lambda: cfg.lambda,
      compare: compare,
      hyper: {
        s: H / MM_PER_M,
        dn: o.dn / MM_PER_M,
        halfH: H / 2 / MM_PER_M,
        dfInf: o.df === Infinity,
        relErrDn: Math.abs(o.dn - H / 2) / (H / 2)
      },
      third: {
        s: s3 / MM_PER_M,
        dn: o3.dn / MM_PER_M, df: o3.df / MM_PER_M,
        front: o3.front / MM_PER_M, back: o3.back / MM_PER_M,
        total: o3.total / MM_PER_M,
        ratioBack: o3.back / o3.front,
        predRatioBack: predRatio,
        share: o3.front / o3.total,
        predShare: predShare
      }
    };
  }

  /* ── 敏感性（对第 idx 个方案，逐行完整重算） ─────────── */
  function sensitivity(cfg, idx) {
    const r = cfg.rows[idx === undefined ? 0 : idx] || cfg.rows[0];
    const dims = r.dims;
    const c = cocFor(cfg.coc, dims).c;
    const lambdaMm = cfg.lambda / 1e6;
    const nearMm = cfg.target.near * MM_PER_M;
    const farMm = cfg.target.far === Infinity ? Infinity : cfg.target.far * MM_PER_M;
    const base = optics(r.f, r.N, r.s * MM_PER_M, c, lambdaMm);
    const out = [];
    const push = (label, f, N, sM, note) => {
      if (sM * MM_PER_M <= f) { out.push({ label: label, invalid: true, note: note || '对焦距离不大于焦距，算不出来' }); return; }
      const o = optics(f, N, sM * MM_PER_M, c, lambdaMm);
      const cov = coverage(o.dn, o.df, nearMm, farMm, cfg.target.farInf);
      out.push({
        label: label, invalid: false, f: f, N: N, s: sM,
        H: o.H / MM_PER_M, dn: o.dn / MM_PER_M,
        df: o.df === Infinity ? Infinity : o.df / MM_PER_M,
        total: o.total === Infinity ? Infinity : o.total / MM_PER_M,
        deltaTotal: (o.total === Infinity || base.total === Infinity) ? null : (o.total - base.total) / MM_PER_M,
        cover: cov.verdict, coverLabel: cov.label, covered: cov.covered,
        note: note || ''
      });
    };
    const SQ = Math.SQRT2;
    push('基准（原样）', r.f, r.N, r.s);
    push('焦距 −20%', r.f * 0.8, r.N, r.s);
    push('焦距 +20%', r.f * 1.2, r.N, r.s);
    push('光圈开大一档（÷√2 = f/' + fmtNum(Math.max(r.N / SQ, N_MIN), 2) + '）', r.f, Math.max(r.N / SQ, N_MIN), r.s);
    push('光圈收小一档（×√2 = f/' + fmtNum(Math.min(r.N * SQ, N_MAX), 2) + '）', r.f, Math.min(r.N * SQ, N_MAX), r.s);
    push('对焦距离 −20%', r.f, r.N, r.s * 0.8);
    push('对焦距离 +20%', r.f, r.N, r.s * 1.2);
    push('搬到全画幅（焦距、光圈不变）', r.f, r.N, r.s, '这一步只换画幅，焦距与光圈都不变');
    push('搬到 1/2.3 英寸（焦距、光圈不变）', r.f, r.N, r.s, '这一步只换画幅，焦距与光圈都不变');
    return out;
  }

  /* 把某个方案搬到指定画幅（用于敏感性与等效验证） */
  function moveToSensor(r, cfg, sensorId, scaleF, scaleN) {
    const dims = sensorDims(sensorId, cfg.customSensor);
    const c = cocFor(cfg.coc, dims).c;
    const lambdaMm = cfg.lambda / 1e6;
    const f = r.f * (scaleF || 1), N = r.N * (scaleN || 1);
    const sMm = r.s * MM_PER_M;
    if (sMm <= f) return null;
    return optics(f, N, sMm, c, lambdaMm);
  }

  /* ── 值得记住的几条（数字全部来自同一次计算） ────────── */
  /* 等效口径偏差的说明文字：null 表示「等效后无法对焦，不可比较」 */
  function defDevText(x) {
    const pn = x.eqDevNear === null ? null : fmtPct(x.eqDevNear * 100, 3);
    const pf = x.eqDevFar === null ? null : fmtPct(x.eqDevFar * 100, 3);
    if (pn === null && pf === null) {
      return '把该方案按等效焦距/等效光圈搬到' + x.refSensorName + '后，等效焦距（' +
        fmtNum(x.fEq, 1) + 'mm）已经不小于对焦距离（' + fmtDist(x.s) + '），等效相机在这个距离上无法对焦，' +
        '所以这一项的偏差不可比较——等效口径只在 f ≪ s 时才有意义。';
    }
    return '把该方案按等效焦距/等效光圈搬到' + x.refSensorName + '重算，近点相差 ' + (pn === null ? '不可比较' : pn) +
      '、远点相差 ' + (pf === null ? '不可比较（一边的远点是 ∞）' : pf) +
      '（闭式预测与此一致，见结构自检）：等效只是 f ≪ s 时的近似，不是恒等式，偏差会随「远点 ÷ 对焦距离」放大。';
  }

  function buildInsights(cfg, rows, rev, law) {
    const out = [];
    const r0 = rows[0];
    const covered = rows.filter((x) => x.covered).length;

    /* ① 超焦距恒等式 */
    out.push({
      key: 'hyper',
      title: '对焦在超焦距时，近点恰好是超焦距的一半、远点是无限远',
      body: '以第 1 个方案（' + r0.sensorName + '、' + fmtNum(law.f, 1) + 'mm、f/' + fmtNum(law.N, 1) +
        '）为例：超焦距 H = ' + fmtDist(law.H) + '，把对焦距离放到 H 上，近点算得 ' + fmtDist(law.hyper.dn) +
        '，而 H ÷ 2 = ' + fmtDist(law.hyper.halfH) + '，两者相对差 ' + law.hyper.relErrDn.toExponential(2) +
        '；远点在这一支公式里直接变成 ∞。这条与 f、N、c 都无关，是公式本身的结构。'
    });

    /* ② 前 1/3 后 2/3 的精确条件 */
    const t = law.third;
    out.push({
      key: 'third',
      title: '「前 1/3 后 2/3」不是通用法则，只在「对焦距离 = 超焦距 ÷ 3」时成立',
      body: '同一个方案，若对焦距离取 H ÷ 3 = ' + fmtDist(t.s) + '，算得前景深 ' + fmtDist(t.front) +
        '、后景深 ' + fmtDist(t.back) + '，前后比 1 : ' + fmtNum(t.ratioBack, 4) +
        '（精确式是 H : (2H − 3f) = 1 : ' + fmtNum(t.predRatioBack, 4) + '），前段占总景深 ' +
        fmtPct(t.share * 100, 3) + '（不是 33.333%）。本页默认那 6 个方案的实际前后比各不相同（见下表），' +
        '所以「前 1/3 后 2/3」只能当口语，不能当尺子。'
    });

    /* ③ 衍射转折光圈随画幅变化 */
    const nd = rows.map((x) => x.nDiff);
    out.push({
      key: 'diff',
      title: '收小光圈的收益有上限：衍射转折光圈随画幅急剧变化',
      body: rows.map((x) => x.name + '（' + x.sensorName + '）N_d ≈ f/' + fmtNum(x.nDiff, 2) +
        (x.diffractionLimited ? ' —— 当前 f/' + fmtNum(x.N, 1) + ' **已经越过**这条线' : '')).join('；') +
        '。判据是艾里斑第一暗环直径 2.44λN（λ = ' + cfg.lambda + ' nm）追上弥散圆 c：越过以后，' +
        '再收光圈换来的景深会被衍射抹掉，画面上不会更清晰。'
    });

    /* ④ 等效口径 */
    const ph = rows.filter((x) => x.sensor === 'phone23')[0];
    if (ph) {
      const devTxt = defDevText(ph);
      out.push({
        key: 'equiv',
        title: '小底「f/1.8」和大底「f/1.8」不是一回事：等效光圈差一个画幅系数',
        body: ph.name + ' 的 ' + fmtNum(ph.f, 1) + 'mm f/' + fmtNum(ph.N, 1) + '（' + ph.sensorName +
          '，等效系数 ' + fmtNum(ph.crop, 3) + '）在视角与景深上相当于' + ph.refSensorName + '的 ' +
          fmtNum(ph.fEq, 1) + 'mm f/' + fmtNum(ph.NEq, 2) + '。所以它的景深比全画幅 f/8 还深——' +
          '不是因为手机更强，是画幅决定了景深口径。' + devTxt
      });
    }

    /* ⑤ 反推与「对焦在中点」的差别 */
    if (rev.ok) {
      const relNear = rev.errNear / (rev.near * MM_PER_M);
      const relFar = rev.farInf ? 0 : rev.errFar / (rev.far * MM_PER_M);
      let s = '目标区间 ' + fmtDist(rev.near) + ' – ' + (rev.farInf ? '∞' : fmtDist(rev.far)) +
        '，用 ' + fmtNum(rev.f, 1) + 'mm 镜头时，闭式反推给出：对焦在 ' + fmtDist(rev.sStar) +
        '、光圈收到 f/' + fmtNum(rev.nStar, 2) + '。回代重算得到的近点/远点是 ' + fmtDist(rev.backDn) + ' / ' +
        fmtDist(rev.backDf) + '，与目标相差 ' + fmtDist(rev.errNear / MM_PER_M) + ' / ' +
        (rev.errFar === Infinity ? '∞' : fmtDist(rev.errFar / MM_PER_M)) +
        '（相对差 ' + relNear.toExponential(2) + ' / ' + (rev.farInf ? '—' : relFar.toExponential(2)) + '，属浮点噪声）。';
      if (rev.naive) {
        s += '常见做法是「对焦在区间中点」' + fmtDist(rev.naive.s) + '：在同一个 f/' + fmtNum(rev.nStar, 2) +
          ' 下实际近点是 ' + fmtDist(rev.naive.dn) + '、远点是 ' + fmtDist(rev.naive.df) +
          '，判定为「' + rev.naive.coverLabel + '」，近端差 ' + fmtDist(rev.naive.gapNear) + '。两个端点到镜头的距离要用调和平均，不是算术平均。';
      }
      out.push({ key: 'reverse', title: '要让目标区间整段清晰：对焦位置取调和平均，光圈取闭式解', body: s });

      /* 同一区间、不同焦距需要的最小光圈 */
      if (rev.table) {
        const t = rev.table;
        out.push({
          key: 'solvef',
          title: '同一段目标区间，焦距越长需要的光圈越离谱（对焦位置却不变）',
          body: '目标区间不变时，反推出的对焦距离 s* = ' + fmtDist(t.sStar) +
            ' 与焦距无关（它是两端点的调和平均），但所需光圈随 f² 增长：' +
            t.rows.map((x) => fmtNum(x.f, 0) + 'mm → ' + (x.feasible ? 'f/' + fmtNum(x.nStar, 2) : '做不到（' + x.why + '）')).join('；') +
            '。所以「想让这一段都清晰」这件事，广角几乎不用收光圈，长焦要收到衍射已经吃掉画质的地方也未必够。'
        });
      }
    } else if (rev.reason) {
      out.push({ key: 'reverse', title: '目标区间在本次设置下无法达成', body: rev.reason });
    }

    out.push({
      key: 'cover',
      title: '本次 ' + rows.length + ' 个方案里有 ' + covered + ' 个能整段覆盖目标区间',
      body: rows.map((x) => x.name + '：' + x.coverLabel +
        (x.covered ? '（近点 ' + fmtDist(x.dn) + '、远点 ' + fmtDist(x.df) + '）'
          : '（近端差 ' + (x.gapNear > 0 ? fmtDist(x.gapNear) : '0') + '、远端差 ' +
            (x.gapFar === Infinity ? '∞' : fmtDist(x.gapFar)) + '）')).join('；') +
        '。覆盖判定只比「目标区间是否整段落在 [近点, 远点] 内」，不评价画质好坏。'
    });
    return out;
  }

  /* ── 结构自检（每次重算都跑） ───────────────────────── */
  function verify(res) {
    const out = [];
    const cfg = res.cfg, rows = res.rows, law = res.laws;
    const r0 = cfg.rows[0];
    const dims = r0.dims;
    const c = cocFor(cfg.coc, dims).c;
    const lam = cfg.lambda / 1e6;

    /* 1 超焦距恒等式 */
    out.push({
      ok: law.hyper.relErrDn < 1e-9 && law.hyper.dfInf,
      msg: '对焦在超焦距时近点 = H/2（相对误差 < 1e-9）且远点 = ∞',
      extra: '相对误差 ' + law.hyper.relErrDn.toExponential(3)
    });

    /* 2 s ≥ H ⟺ 远点 = ∞；目标远点是 ∞ 当且仅当勾了「远点取无限远」 */
    out.push({
      ok: rows.every((x) => x.dfInf === (x.s >= x.H * (1 - H_REL_TOL))) &&
        rows.every((x) => (x.far === Infinity) === x.farInf),
      msg: 's ≥ H 与「远点 = ∞」互相等价；目标远点为 ∞ 当且仅当勾了「远点取无限远」',
      extra: rows.map((x) => (x.dfInf === (x.s >= x.H * (1 - H_REL_TOL))) ? '' : x.name).filter(Boolean).join(',')
    });

    /* 3 近点 < 对焦距离 < 远点；且前后比只在远点有限时是有限值 */
    out.push({
      ok: rows.every((x) => x.dn < x.s && (x.dfInf || x.df > x.s) &&
        (x.dfInf ? x.ratioBack === Infinity : x.ratioBack > 0 && fin(x.ratioBack))),
      msg: '近点 < 对焦距离 < 远点；前后比只在远点有限时是有限正数',
      extra: ''
    });

    /* 4 收小光圈总景深不减 */
    out.push({
      ok: rows.every((x) => {
        const o1 = optics(x.f, x.N, x.s * MM_PER_M, x.coc, lam);
        const o2 = optics(x.f, x.N * 2, x.s * MM_PER_M, x.coc, lam);
        if (o1.total === Infinity) return true;
        if (o2.total === Infinity) return true;
        return o2.total >= o1.total - 1e-9;
      }),
      msg: '光圈收小（N × 2）总景深不减',
      extra: ''
    });

    /* 5 焦距增大总景深减小（同为有限远点时） */
    out.push({
      ok: rows.every((x) => {
        for (const k of [1.2, 1.5]) {
          const o1 = optics(x.f, x.N, x.s * MM_PER_M, x.coc, lam);
          const o2 = optics(x.f * k, x.N, x.s * MM_PER_M, x.coc, lam);
          if (o1.total === Infinity || o2.total === Infinity) continue;
          if (!(o2.total <= o1.total + 1e-9)) return false;
        }
        return true;
      }),
      msg: '焦距变长（×1.2 / ×1.5）总景深不增',
      extra: ''
    });

    /* 6 对焦距离推远时近点的走向：dDn/ds 的符号 = sign(H − 2f) = sign(f − N·c)
         常规镜头 f ≫ N·c，所以近点随对焦距离单调变远；N·c ≥ f 时反而是反向的 */
    let monoOK = true, monoDir = 0, monoDeg = 0;
    rows.forEach((x) => {
      const o1 = optics(x.f, x.N, x.s * MM_PER_M, x.coc, lam);
      const o2 = optics(x.f, x.N, x.s * MM_PER_M * 1.2, x.coc, lam);
      const cond = x.f > x.N * x.coc;                 // 等价于 H > 2f
      const wantUp = cond;
      if (cond) monoDir++; else monoDeg++;
      /* 用相对容差：退化组里 s ≫ H，近点几乎不随对焦距离变化，差值落在舍入噪声量级 */
      const tol = 1e-7 * (Math.abs(o1.dn) + Math.abs(o2.dn));
      const notDown = o2.dn >= o1.dn - tol;
      const notUp = o2.dn <= o1.dn + tol;
      if (wantUp ? !notDown : !notUp) monoOK = false;
    });
    out.push({
      ok: monoOK,
      msg: '对焦距离推远（×1.2）时近点的走向与 f > N·c 一致（f > N·c 时不移近，否则不移远）',
      extra: '常规组 ' + monoDir + ' 个、退化组（N·c ≥ f）' + monoDeg + ' 个'
    });

    /* 7 反推回代 */
    const rev = res.reverse;
    out.push({
      ok: !rev.ok ? true : (rev.errNear / (rev.near * MM_PER_M) < 1e-9 &&
        (rev.farInf ? rev.backDf === Infinity : rev.errFar / (rev.far * MM_PER_M) < 1e-9)),
      msg: '反推结果回代重算后与目标一致（相对误差 < 1e-9）',
      extra: rev.ok ? ('近点相对差 ' + (rev.errNear / (rev.near * MM_PER_M)).toExponential(2)) : '本次不可行，跳过'
    });

    /* 8 s = H/3 的精确前后比 */
    out.push({
      ok: Math.abs(law.third.ratioBack - law.third.predRatioBack) < 1e-12 &&
        Math.abs(law.third.share - law.third.predShare) < 1e-12,
      msg: 's = H/3 时前后比 = H : (2H − 3f)、前段占比 = H/(3(H−f))（相对误差 < 1e-12）',
      extra: '实际 1:' + fmtNum(law.third.ratioBack, 6) + ' 预期 1:' + fmtNum(law.third.predRatioBack, 6)
    });

    /* 9 衍射判据：N = N_d 时艾里斑 = 弥散圆 */
    out.push({
      ok: rows.every((x) => Math.abs(2.44 * lam * x.nDiff - x.coc) < 1e-15),
      msg: 'N = N_d 时艾里斑直径恰好等于弥散圆 c',
      extra: ''
    });

    /* 10 等效口径：等效方案自己的近点/远点必须精确等于「按 k 缩放的闭式解」
         即 dn' = f²s ÷ (f² + A − B)、df' = f²s ÷ (f² − A + B)。
         直接比这两个量（而不是比两个几乎相等之差的比值），避免灾难性相消。 */
    const eqBad = [];
    let eqCmp = 0;
    rows.forEach((x) => {
      if (x.eqDnClosed === null || x.eqDn === null) return;
      eqCmp++;
      if (!(Math.abs(x.eqDn - x.eqDnClosed) <= 1e-9 * Math.abs(x.eqDnClosed))) eqBad.push(x.name + '(近点)');
      if (x.eqDfClosed !== null && x.eqDf !== null && x.eqDf !== Infinity) {
        eqCmp++;
        if (!(Math.abs(x.eqDf - x.eqDfClosed) <= 1e-9 * Math.abs(x.eqDfClosed))) eqBad.push(x.name + '(远点)');
      }
    });
    const nearDevs = rows.map((x) => x.eqDevNear).filter((v) => fin(v));
    const farDevs = rows.map((x) => x.eqDevFar).filter((v) => fin(v));
    out.push({
      ok: eqBad.length === 0,
      msg: '等效方案（f·k, N·k, c·k）自己的近点/远点 = 按 k 缩放的闭式解（相对误差 ≤ 1e-9，共比对 ' + eqCmp + ' 项）',
      extra: eqBad.length ? ('不一致：' + eqBad.join(',')) :
        ('实测最大近点偏差 ' + (nearDevs.length ? fmtPct(Math.max.apply(null, nearDevs) * 100, 3) : '无') +
          '、最大远点偏差 ' + (farDevs.length ? fmtPct(Math.max.apply(null, farDevs) * 100, 3) : '无'))
    });

    /* 11 覆盖判定与近点/远点一致（构造四种情形逐一验证） */
    out.push({
      ok: (function () {
        const cases = [
          [1, 2, 3, 10, false, 'cover'],     // dn=1 ≤2, df=10 ≥3
          [5, 2, 3, 10, false, 'near'],      // dn=5 >2
          [1, 2, 3, 2.5, false, 'far'],      // df=2.5 <3
          [5, 2, 3, 2.5, false, 'both'],
          [1, 2, 3, Infinity, false, 'cover'],
          [1, 2, 3, 10, true, 'far']         // 目标远点 ∞ 但实际远点有限
        ];
        return cases.every((cs) => coverage(cs[0], cs[3], cs[1], cs[4] ? Infinity : cs[2], cs[4]).verdict === cs[5]);
      })(),
      msg: '覆盖判定（全覆盖 / 近端 / 远端 / 两头）与近点、远点的大小关系一致',
      extra: ''
    });

    /* 12 输出契约：没有 NaN / undefined；∞ 只允许出现在远点/后景深/总景深/远端缺口 */
    const allowInf = { df: 1, back: 1, total: 1, gapFar: 1, errFar: 1, ratioBack: 1, far: 1, backDf: 1, eqDf: 1, eqDfClosed: 1 };
    const bads = [];
    (function walk(o, path) {
      if (o === null || o === undefined) { if (o === undefined) bads.push(path); return; }
      const t = typeof o;
      if (t === 'number') {
        if (Number.isNaN(o)) bads.push(path + '(NaN)');
        else if (o === Infinity || o === -Infinity) {
          const key = path.split('.').pop().split('[')[0];
          if (!allowInf[key]) bads.push(path + '(Infinity)');
        }
        return;
      }
      if (t !== 'object') return;
      if (Array.isArray(o)) { o.forEach((v, i) => walk(v, path + '[' + i + ']')); return; }
      Object.keys(o).forEach((k) => walk(o[k], path + '.' + k));
    })({ rows: rows, laws: law, reverse: rev }, 'res');
    out.push({ ok: bads.length === 0, msg: '结果里没有 NaN / undefined，∞ 只出现在允许的字段上', extra: bads.slice(0, 4).join(', ') });

    /* 13 确定性：同输入两次逐字节一致 */
    const a = JSON.stringify(res.rows), b = JSON.stringify(rows);
    out.push({ ok: a === b, msg: '同一份输入两次计算结果一致', extra: '' });

    return out.map((x) => ({ ok: !!x.ok, msg: x.msg, extra: x.extra || '' }));
  }

  /* ── 主入口 ─────────────────────────────────────────── */
  function analyze(raw) {
    const nz = normalize(raw);
    if (!nz.ok) return { ok: false, cfg: nz.cfg, errors: nz.errors, warnings: nz.warnings, rows: [], checks: [] };
    const cfg = nz.cfg;
    const rows = cfg.rows.map((r) => rowResult(r, cfg));
    const law = laws(cfg);
    const rev = solveTarget(cfg, cfg.solveF);
    rev.table = solveTable(cfg);
    const res = {
      ok: true, cfg: cfg, warnings: nz.warnings, errors: [],
      rows: rows, laws: law, reverse: rev,
      sensitivity: sensitivity(cfg, 0),
      insights: [], checks: []
    };
    res.insights = buildInsights(cfg, rows, rev, law);
    res.checks = verify(res);
    return res;
  }

  /* 页面上「这份账不算什么」的固定清单（UI 与导出共用） */
  const LIMITS = [
    '只做几何光学：不建模镜头像差、场曲、真实分辨率（MTF）、呼吸效应、浮动对焦、变焦头实际焦距漂移、机身防抖与快门运动模糊——「清晰」的另一半（运动与像差）不在本页。',
    '薄透镜理想化：所有距离都是相对镜头的物距；与「从像面算起」的镜身刻度存在差异，本页不换算。',
    '光瞳放大率按 1 处理：标准景深公式的形式假设入/出瞳对称。放大率超过 0.1（约 1:10）时会给出近摄提醒，1:1 以上的结论偏差可能明显。',
    '弥散圆 c 是显示约定，不是物理常数：换口径（对角线÷1500 与 ÷1730）会直接改变结论，本页不宣称哪一个是标准。',
    '不处理移轴 / 倾角镜头（沙姆弗鲁格）、焦点合成与景深堆栈、拼接；不处理滤镜、T 值差异、机身与镜头组合的个体差异。',
    '不测量任何真实镜头、不联网、不查镜头或相机参数；不判断「这套设置拍得好不好」，不做器材评价或购买建议。',
    '衍射判据只比较艾里斑与弥散圆的大小，不是完整的 MTF 分析：越过衍射转折光圈不等于「不能拍」，只表示再收光圈不会更清晰。',
    '目标近点离镜头过近（反推对焦距离 ≤ 焦距）或所需光圈超出 f/0.7–f/64 时判不可行并说明原因，不硬凑一个数。',
    '覆盖判定只比「目标区间是否整段落在 [近点, 远点] 内」，是显示分组，不是画质评级。',
    '默认样例、6 个内置场景与页面上所有数字都是虚构示例，不是任何真实器材的实测数据。'
  ];

  const api = {
    DIAG_FF: DIAG_FF, MAX_ROWS: MAX_ROWS, NAME_MAX: NAME_MAX,
    F_MIN: F_MIN, F_MAX: F_MAX, N_MIN: N_MIN, N_MAX: N_MAX,
    S_MIN: S_MIN, S_MAX: S_MAX, LAM_MIN: LAM_MIN, LAM_MAX: LAM_MAX,
    TGT_MIN: TGT_MIN, TGT_MAX: TGT_MAX, C_MIN: C_MIN, C_MAX: C_MAX,
    PX_MIN: PX_MIN, PX_MAX: PX_MAX, DIM_MIN: DIM_MIN, DIM_MAX: DIM_MAX,
    CLOSE_FOCUS_M: CLOSE_FOCUS_M, EQUIV_TOL: EQUIV_TOL, MM_PER_M: MM_PER_M,
    SENSORS: SENSORS, COC_MODES: COC_MODES, SENSOR_BY_ID: SENSOR_BY_ID, COC_BY_ID: COC_BY_ID,
    defaults: defaults, scenarios: scenarios, LIMITS: LIMITS,
    parseNum: parseNum, num: num, normalize: normalize, analyze: analyze, verify: verify,
    optics: optics, coverage: coverage, solveTarget: solveTarget, solveTable: solveTable,
    applySolve: applySolve, laws: laws,
    sensitivity: sensitivity, moveToSensor: moveToSensor,
    sensorDims: sensorDims, sensorDiag: sensorDiag, cocFor: cocFor,
    fmtNum: fmtNum, fmtDist: fmtDist, fmtMm: fmtMm, fmtPct: fmtPct,
    r2: r2, r3: r3, r4: r4,
    defaultsClone: function () { return JSON.parse(JSON.stringify(defaults)); }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})(typeof window !== 'undefined' ? window : null);
