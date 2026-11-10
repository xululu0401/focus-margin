/* 景深对账台 · 核心测试（dof-ledger）
 *
 * 用法：node --test tests/core.test.cjs
 *
 * 覆盖面：
 *   1. 手算锚点（独立算出的数，不是照抄引擎输出）
 *   2. 两条恒等式：对焦在 H 时近点 = H/2；对焦在 H/3 时前后比 = H : (2H − 3f)
 *   3. 独立几何实现（图像侧共轭 + 圆锥直径 + 二分）对拍近点/远点/背景弥散圆
 *   4. 反推闭式解 vs 独立二分求最小光圈
 *   5. 单调性与走向（含 f > N·c 的条件）
 *   6. 单位、格式化、舍入
 *   7. 非法输入逐条核字段；阈值两侧
 *   8. 覆盖判定四种情形；空结果
 *   9. 输出契约、确定性、不修改入参
 *  10. 结构自检在默认 + 6 场景 + 400 组随机构造下全过
 *  11. 等效口径恒等式、衍射判据、反推对照表
 *
 * 说明：引擎与「独立几何实现」都是本页作者的代码，两者一致只能证明实现自洽；
 *       手算锚点与恒等式是对物理/数学本身的独立检查。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

const P = C.MM_PER_M;

function close(actual, expect, tol, msg) {
  assert.ok(Math.abs(actual - expect) <= tol,
    (msg || '') + ' 实际 ' + actual + ' 期望 ' + expect + ' 容差 ' + tol);
}
function rel(actual, expect, tol, msg) {
  const d = Math.abs(actual - expect) / Math.max(Math.abs(expect), 1e-300);
  assert.ok(d <= tol, (msg || '') + ' 实际 ' + actual + ' 期望 ' + expect + ' 相对差 ' + d);
}
function seeded(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function rnd(rng, a, b) { return a + rng() * (b - a); }

/* ── 独立几何实现：图像侧共轭 + 圆锥直径（不复用引擎的景深闭式） ─────
 * 物距 d 的点成像在 vd = d·f/(d−f)；对焦在 s 时像面在 v = s·f/(s−f)。
 * 入瞳直径 f/N，圆锥在像面上的直径 = (f/N)·|v − vd| / vd。
 */
function cocGeom(dMm, f, N, sMm) {
  const v = sMm * f / (sMm - f);
  if (dMm === Infinity) return (f / N) * Math.abs(v - f) / f;
  const vd = dMm * f / (dMm - f);
  return (f / N) * Math.abs(v - vd) / vd;
}
/* 在 [lo,hi] 上求 cocGeom(d) = c 的解；cocGeom 在两侧都是单调的 */
function solveD(f, N, sMm, c, lo, hi, decreasing) {
  let a = lo, b = hi;
  const fa = cocGeom(a, f, N, sMm) - c;
  const fb = cocGeom(b, f, N, sMm) - c;
  if (!(fa === 0 || fb === 0) && (fa > 0) === (fb > 0)) return null;   // 括号不成立
  for (let i = 0; i < 200; i++) {
    const m = (a + b) / 2;
    const fm = cocGeom(m, f, N, sMm) - c;
    if (fm === 0) return m;
    if ((fm > 0) === (fa > 0)) a = m; else b = m;
  }
  return (a + b) / 2;
}
/* 独立求近点 / 远点（mm） */
function geomLimits(f, N, sMm, c) {
  const nearMax = f / N;                                  // d→f+ 时的弥散圆上限
  const dn = c >= nearMax ? null : solveD(f, N, sMm, c, f * (1 + 1e-9), sMm, true);
  const atInf = cocGeom(Infinity, f, N, sMm);
  let df;
  if (atInf <= c) df = Infinity;
  else df = solveD(f, N, sMm, c, sMm * (1 + 1e-9), 1e13, false);
  return { dn: dn, df: df };
}

const FF = { id: 'ff', name: 'FF', w: 36, h: 24 };
const C_FF = Math.hypot(36, 24) / 1500;

/* ══════════════ 1. 手算锚点 ══════════════ */
test('手算锚点：全画幅 50mm f/8 对焦 3 m（c = 对角线÷1500）', () => {
  const c = Math.hypot(36, 24) / 1500;
  const o = C.optics(50, 8, 3000, c, 550e-6);
  close(o.H / P, 10.88413, 0.0005, '超焦距');
  close(o.dn / P, 2.35824, 0.0005, '近点');
  close(o.df / P, 4.12282, 0.0005, '远点');
  close(o.total / P, 1.76458, 0.0005, '总景深');
  close(o.blurInf, 0.10591, 0.00005, '无限远背景弥散圆 mm');
  close(o.nDiff, 21.494, 0.01, '衍射转折光圈');
});

test('手算锚点：手机 4.3mm f/1.8 1/2.3 英寸对焦 1.5 m', () => {
  const dims = C.sensorDims('phone23');
  const c = C.sensorDiag(dims) / 1500;
  const o = C.optics(4.3, 1.8, 1500, c, 550e-6);
  close(o.H / P, 2.0146, 0.0005, '超焦距');
  close(o.dn / P, 0.8601, 0.0005, '近点');
  close(o.df / P, 5.8630, 0.002, '远点');
  close(o.nDiff, 3.808, 0.01, '衍射转折光圈');
});

test('手算锚点：机械快门级 24mm f/8 对焦 3 m 已越过超焦距（远点 = ∞）', () => {
  const o = C.optics(24, 8, 3000, C_FF, 550e-6);
  close(o.H / P, 2.52, 0.001, '超焦距');
  assert.strictEqual(o.dfInf, true, 's ≥ H 时远点必须是 ∞');
  close(o.dn / P, 1.3681, 0.001, '近点');
});

/* ══════════════ 2. 两条恒等式 ══════════════ */
test('恒等式①：对焦在超焦距 H 时，近点 = H/2、远点 = ∞（多组 f/N/c）', () => {
  const cases = [[24, 8, C_FF], [50, 2.8, C_FF], [100, 16, C_FF], [4.3, 1.8, C.sensorDiag(C.sensorDims('phone23')) / 1500],
    [135, 5.6, C.sensorDiag(C.sensorDims('apsc')) / 1730]];
  cases.forEach(([f, N, c]) => {
    const H = C.optics(f, N, 1, c, 550e-6).H;
    const o = C.optics(f, N, H, c, 550e-6);
    rel(o.dn, H / 2, 1e-12, '近点应为 H/2');
    assert.strictEqual(o.dfInf, true, '远点应为 ∞');
  });
});

test('恒等式②：对焦在 H/3 时，前:后 = H : (2H − 3f)、前段占总景深 H/(3(H−f))', () => {
  const cases = [[50, 8, C_FF], [24, 8, C_FF], [100, 11, C_FF], [35, 2, C_FF], [200, 5.6, C_FF]];
  cases.forEach(([f, N, c]) => {
    const H = C.optics(f, N, 1, c, 550e-6).H;
    const o = C.optics(f, N, H / 3, c, 550e-6);
    rel(o.back / o.front, (2 * H - 3 * f) / H, 1e-12, '前后比');
    rel(o.front / o.total, H / (3 * (H - f)), 1e-12, '前段占比');
  });
});

test('恒等式②的推论：经典「前 1/3 后 2/3」只是 f → 0 的极限（50mm 实测 1:1.9862）', () => {
  const H = C.optics(50, 8, 1, C_FF, 550e-6).H;
  const o = C.optics(50, 8, H / 3, C_FF, 550e-6);
  close(o.back / o.front, 1.986218, 1e-5, '50mm 的前后比');
  close(o.front / o.total, 0.334872, 1e-5, '50mm 的前段占比');
  assert.ok(o.back / o.front < 2 - 0.013, '不是 1:2');
  assert.ok(o.front / o.total > 1 / 3, 'f > 0 时前段占比略大于 1/3（H/(3(H−f)) > 1/3）');
  close(o.front / o.total, 1 / 3, 0.002, '仍接近 1/3');
});

test('恒等式：s 与 H 严格相等时远点 = ∞（浮点相对容差内也成立）', () => {
  const H = C.optics(50, 8, 1, C_FF, 550e-6).H;
  const o = C.optics(50, 8, H * (1 - 1e-15), C_FF, 550e-6);
  assert.strictEqual(o.dfInf, true);
});

/* ══════════════ 3. 独立几何实现对拍 ══════════════ */
test('独立几何实现（圆锥直径 + 二分）对拍近点/远点 300 组', () => {
  const rng = seeded(20261110);
  let n = 0;
  for (let i = 0; i < 300; i++) {
    const f = rnd(rng, 8, 400);
    const N = rnd(rng, 1.2, 22);
    const sMm = f * rnd(rng, 5, 400);
    const c = rnd(rng, 0.008, 0.045);
    if (c >= f / N) continue;                       // 退化：弥散圆已大于极限，跳过
    const o = C.optics(f, N, sMm, c, 550e-6);
    const g = geomLimits(f, N, sMm, c);
    assert.ok(g.dn !== null, '独立实现应能解出近点');
    rel(o.dn, g.dn, 1e-6, '近点对拍');
    if (o.df === Infinity) {
      assert.ok(cocGeom(Infinity, f, N, sMm) <= c, '远点为 ∞ 时无限远处的弥散圆应 ≤ c');
    } else {
      assert.ok(g.df !== null, '独立实现应能解出远点');
      rel(o.df, g.df, 1e-6, '远点对拍');
    }
    n++;
  }
  assert.ok(n >= 250, '有效对拍组数应 ≥ 250，实际 ' + n);
});

test('独立几何实现：无限远背景弥散圆 = (f/N)·|v − f|/f 对拍 300 组', () => {
  const rng = seeded(777);
  for (let i = 0; i < 300; i++) {
    const f = rnd(rng, 5, 600), N = rnd(rng, 1, 32), sMm = f * rnd(rng, 3, 2000);
    const o = C.optics(f, N, sMm, C_FF, 550e-6);
    rel(o.blurInf, cocGeom(Infinity, f, N, sMm), 1e-12, '背景弥散圆对拍');
  }
});

test('独立几何实现：负向自检——把近点当远点用必须对不上', () => {
  const o = C.optics(50, 8, 3000, C_FF, 550e-6);
  const g = geomLimits(50, 8, 3000, C_FF);
  assert.ok(Math.abs(o.dn - g.df) / g.df > 0.2, '近点与远点不应相等（否则对拍无意义）');
  assert.ok(cocGeom((o.dn + o.df) / 2, 50, 8, 3000) < C_FF, '景深中点应在清晰范围内');
  assert.ok(cocGeom(o.df * 1.001, 50, 8, 3000) > C_FF, '比远点更远，弥散圆必须超过 c');
  assert.ok(cocGeom(o.dn * 0.999, 50, 8, 3000) > C_FF, '比近点更近，弥散圆必须超过 c');
  assert.ok(cocGeom(o.df * 0.999, 50, 8, 3000) < C_FF, '远点内侧仍应在清晰范围内');
  assert.ok(cocGeom(o.dn * 1.001, 50, 8, 3000) < C_FF, '近点外侧仍应在清晰范围内');
});

/* ══════════════ 4. 反推 ══════════════ */
test('反推闭式解：s* 是两端点的调和平均（与 c、N 无关），回代命中目标', () => {
  const rng = seeded(31337);
  for (let i = 0; i < 250; i++) {
    const near = rnd(rng, 0.3, 30);
    const far = near * rnd(rng, 1.05, 8);
    const cfg = {
      coc: { mode: 'diag1500' }, lambda: 550, refSensor: 'ff', solveF: rnd(rng, 12, 200),
      customSensor: { w: 36, h: 24 },
      target: { near: near, far: far, farInf: false },
      rows: [{ name: 'r', sensor: 'ff', f: 50, N: 8, s: 3 }]
    };
    const nz = C.normalize(cfg);
    assert.ok(nz.ok, '输入应合法');
    const rev = C.solveTarget(nz.cfg, nz.cfg.solveF);
    if (!rev.ok) continue;
    rel(rev.sStar, 2 * near * far / (near + far), 1e-12, 's* 应为调和平均');
    rel(rev.backDn, near, 1e-9, '回代近点');
    rel(rev.backDf, far, 1e-9, '回代远点');
  }
});

test('反推闭式解 vs 独立二分求最小光圈：远点约束恰好被绑住', () => {
  const rng = seeded(4242);
  let n = 0;
  for (let i = 0; i < 120; i++) {
    const near = rnd(rng, 0.5, 20), far = near * rnd(rng, 1.2, 5);
    const f = rnd(rng, 16, 120);
    const cfg = {
      coc: { mode: 'diag1500' }, lambda: 550, refSensor: 'ff', solveF: f,
      customSensor: { w: 36, h: 24 },
      target: { near: near, far: far, farInf: false },
      rows: [{ name: 'r', sensor: 'ff', f: f, N: 8, s: 3 }]
    };
    const nz = C.normalize(cfg);
    const rev = C.solveTarget(nz.cfg, f);
    if (!rev.ok) continue;
    /* 固定 s = s*，独立二分出「远点刚好等于目标远点」的光圈 */
    const sMm = rev.sStar * P;
    let lo = 0.7, hi = 200;
    const dfAt = (N) => C.optics(f, N, sMm, C_FF, 550e-6).df;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      const d = dfAt(mid);
      /* 远点随光圈收小而变远：远点还不够远就加大光圈数，够了就减小 */
      if (d !== Infinity && d / P < far) lo = mid; else hi = mid;
    }
    const nBi = (lo + hi) / 2;
    rel(rev.nStar, nBi, 1e-3, '闭式解与二分法应一致');
    /* 二分出的光圈下，近点也必须刚好等于目标近点 */
    const o = C.optics(f, nBi, sMm, C_FF, 550e-6);
    rel(o.dn / P, near, 2e-3, '远点绑住时近点也应刚好命中');
    n++;
  }
  assert.ok(n >= 100, '有效组数应 ≥ 100，实际 ' + n);
});

test('反推到无限远：s* = 2·近点，且回代得到的 H 恰好 = s*', () => {
  const rng = seeded(909);
  for (let i = 0; i < 150; i++) {
    const near = rnd(rng, 0.4, 40);
    const f = rnd(rng, 12, 200);
    if (2 * near * P - f <= 0) continue;
    const cfg = {
      coc: { mode: 'diag1500' }, lambda: 550, refSensor: 'ff', solveF: f,
      customSensor: { w: 36, h: 24 },
      target: { near: near, far: 5, farInf: true },
      rows: [{ name: 'r', sensor: 'ff', f: f, N: 8, s: 3 }]
    };
    const nz = C.normalize(cfg);
    const rev = C.solveTarget(nz.cfg, f);
    if (!rev.ok) continue;
    rel(rev.sStar, 2 * near, 1e-12, 's* 应为 2×近点');
    assert.strictEqual(rev.backDf, Infinity, '远点必须是 ∞');
    const H = C.optics(f, rev.nStar, rev.sStar * P, C_FF, 550e-6).H;
    rel(H / P, rev.sStar, 1e-9, '此时 s* 必须等于超焦距');
    rel(rev.backDn, near, 1e-9, '回代近点');
  }
});

test('反推不可行时给理由，不硬凑数', () => {
  /* 近点比 f/2 还小 → 覆盖到无限远做不到 */
  const a = C.normalize({
    coc: { mode: 'diag1500' }, lambda: 550, refSensor: 'ff', solveF: 200,
    target: { near: 0.05, farInf: true },
    rows: [{ name: 'r', sensor: 'ff', f: 50, N: 8, s: 3 }]
  });
  const ra = C.solveTarget(a.cfg, 200);
  assert.strictEqual(ra.ok, false);
  assert.ok(/做不到|几何/.test(ra.reason), '应说明原因：' + ra.reason);

  /* 目标区间太窄，需要比 f/0.7 更快的光圈 → 做不到 */
  const b = C.normalize({
    coc: { mode: 'diag1500' }, lambda: 550, refSensor: 'ff', solveF: 50,
    target: { near: 3.0, far: 3.01 },
    rows: [{ name: 'r', sensor: 'ff', f: 50, N: 8, s: 3 }]
  });
  const rb = C.solveTarget(b.cfg, 50);
  assert.strictEqual(rb.ok, false);
  assert.ok(/f\/0\.7|太快|太窄/.test(rb.reason), '应说明原因：' + rb.reason);

  /* 长焦 + 大区间 → 需要超过 f/64 */
  const d = C.normalize({
    coc: { mode: 'diag1500' }, lambda: 550, refSensor: 'ff', solveF: 135,
    target: { near: 2, far: 5 },
    rows: [{ name: 'r', sensor: 'ff', f: 135, N: 8, s: 3 }]
  });
  const rd = C.solveTarget(d.cfg, 135);
  assert.strictEqual(rd.ok, false);
  assert.ok(/f\/64|上限/.test(rd.reason), '应说明原因：' + rd.reason);
});

test('「对焦在中点」是常见做法但会漏掉近端（默认锚点）', () => {
  const res = C.analyze(C.defaultsClone());
  const rev = res.reverse;
  assert.strictEqual(rev.ok, true);
  close(rev.sStar, 2.8571428571, 1e-6, 's*');
  close(rev.nStar, 13.2324, 0.001, 'N*');
  assert.strictEqual(rev.naive.s, 3.5, '算术中点');
  close(rev.naive.dn, 2.2925, 0.001, '中点时的实际近点');
  close(rev.naive.df, 7.3952, 0.002, '中点时的实际远点');
  assert.strictEqual(rev.naive.covered, false, '中点对焦盖不住目标近点');
  assert.strictEqual(rev.naive.coverLabel, '近端不够');
  assert.ok(rev.naive.gapNear > 0.29 && rev.naive.gapNear < 0.30, '近端缺口约 0.292 m');
  assert.ok(rev.naive.df > rev.far, '远点比目标远得多——中点把余量全放在了后面');
});

test('反推对照表：s* 与焦距无关、所需光圈随焦距增长', () => {
  const res = C.analyze(C.defaultsClone());
  const t = res.reverse.table;
  close(t.sStar, 2.8571428571, 1e-6, '不同焦距共用同一个 s*');
  t.rows.forEach((r) => close(r.sStar, t.sStar, 1e-12, '每一档的 s* 必须相同'));
  const fs = t.rows.filter((r) => r.feasible).map((r) => r.nStar);
  for (let i = 1; i < fs.length; i++) assert.ok(fs[i] > fs[i - 1], '所需光圈应随焦距递增');
  const at135 = t.rows.filter((r) => r.f === 135)[0];
  assert.strictEqual(at135.feasible, false, '135mm 应判做不到');
  close(t.rows.filter((r) => r.f === 50)[0].nStar, 13.2324, 0.001, '50mm 要 f/13.23');
});

test('一键采用取整解：光圈向上取整后必须真的覆盖目标区间（回归）', () => {
  const nz = C.normalize(C.defaultsClone());
  const dims = nz.cfg.rows[0].dims;
  [24, 35, 50, 85].forEach((f) => {
    const a = C.applySolve(nz.cfg, f, dims);
    assert.strictEqual(a.ok, true, f + 'mm 应当可行');
    assert.ok(a.N >= a.nStar - 1e-12, '光圈必须向上取整（宁深不浅）');
    assert.ok(a.N - a.nStar < 0.01, '向上取整的增量应小于 0.01 档');
    assert.strictEqual(a.covered, true, f + 'mm 取整后必须整段覆盖：' + a.coverLabel +
      '（近端缺口 ' + a.gapNear + '、远端缺口 ' + a.gapFar + '）');
  });
  const bad = C.applySolve(nz.cfg, 135, dims);
  assert.strictEqual(bad.ok, false, '135mm 应判不可行');
  assert.ok(/f\/64|上限/.test(bad.reason));
});

test('一键采用取整的必要性：直接用未取整的 N* 会把远点差掉一点点', () => {
  const nz = C.normalize(C.defaultsClone());
  const dims = nz.cfg.rows[0].dims;
  const rv = C.solveTarget(nz.cfg, 50);
  const s3 = Math.round(rv.sStar * 1000) / 1000;
  const n2 = Math.round(rv.nStar * 100) / 100;          // 旧的（四舍五入）做法
  const o = C.optics(50, n2, s3 * P, C_FF, 550e-6);
  const cov = C.coverage(o.dn, o.df, 2000, 5000, false);
  assert.strictEqual(cov.covered, false, '四舍五入到 f/13.23 会差掉两端（这正是要改成向上取整的原因）');
  assert.ok(cov.gapNear > 0 && cov.gapNear < 5, '近端缺口应很小但非零，实际 ' + cov.gapNear + ' mm');
  assert.ok(cov.gapFar > 0 && cov.gapFar < 5, '远端缺口应很小但非零，实际 ' + cov.gapFar + ' mm');
  assert.strictEqual(cov.verdict, 'both', '两端各差一点点');
  /* 向上取整之后就盖住了 */
  const up = C.optics(50, Math.ceil(rv.nStar * 100) / 100, rv.sStar * P, C_FF, 550e-6);
  assert.strictEqual(C.coverage(up.dn, up.df, 2000, 5000, false).covered, true);
});

/* ══════════════ 5. 单调性与走向 ══════════════ */
test('光圈收小总景深不减、焦距变长总景深不增（各 200 组）', () => {
  const rng = seeded(5150);
  for (let i = 0; i < 200; i++) {
    const f = rnd(rng, 10, 300), N = rnd(rng, 1, 16), sMm = f * rnd(rng, 6, 500);
    const a = C.optics(f, N, sMm, C_FF, 550e-6);
    const b = C.optics(f, N * 1.8, sMm, C_FF, 550e-6);
    if (!(a.total === Infinity && b.total === Infinity)) {
      assert.ok(b.total >= a.total - 1e-9, '收小光圈总景深不应变小');
    }
    const hiF = C.optics(f * 1.4, N, sMm, C_FF, 550e-6);
    if (a.total !== Infinity && hiF.total !== Infinity) {
      assert.ok(hiF.total <= a.total + 1e-9, '焦距变长总景深不应变大');
    }
  }
});

test('对焦距离推远时近点的走向由 f > N·c 决定（两侧都验）', () => {
  const up = C.optics(50, 8, 3000, 0.0288, 550e-6);
  const up2 = C.optics(50, 8, 3600, 0.0288, 550e-6);
  assert.ok(50 > 8 * 0.0288, '常规镜头 f > N·c');
  assert.ok(up2.dn > up.dn, '常规情形：对焦推远近点变远');

  const deg = C.optics(1.2, 40, 50000, 0.6, 550e-6);       // N·c = 24 > f
  const deg2 = C.optics(1.2, 40, 60000, 0.6, 550e-6);
  assert.ok(1.2 <= 40 * 0.6, '构造退化口径 N·c ≥ f');
  assert.ok(deg2.dn <= deg.dn + 1e-9, '退化情形：近点反而变近（走进反向）');
});

test('结构自检里的走向检查在任何输入下都过：默认 + 6 场景 + 400 组随机', () => {
  const rng = seeded(20260101);
  const cases = [C.defaultsClone()];
  C.scenarios.forEach((sc) => {
    const d = C.defaultsClone();
    if (sc.patch.target) d.target = sc.patch.target;
    if (sc.patch.rows) d.rows = sc.patch.rows;
    if (sc.patch.coc) d.coc = sc.patch.coc;
    cases.push(d);
  });
  for (let i = 0; i < 400; i++) {
    const d = {
      coc: { mode: ['diag1500', 'diag1730', 'diag1000', 'pixel', 'custom'][Math.floor(rnd(rng, 0, 5))],
        px: Math.round(rnd(rng, 1000, 20000)), c: rnd(rng, 0.002, 0.4) },
      lambda: Math.round(rnd(rng, 380, 780)),
      refSensor: ['ff', 'apsc', 'm43', 'phone23', 'mf4433'][Math.floor(rnd(rng, 0, 5))],
      solveF: rnd(rng, 1, 2000),
      customSensor: { w: rnd(rng, 1, 300), h: rnd(rng, 1, 300) },
      target: { near: rnd(rng, 0.02, 200), far: 0, farInf: rng() < 0.3 },
      rows: []
    };
    d.target.far = d.target.farInf ? 5 : d.target.near * (1 + rnd(rng, 0.002, 10));
    const n = 1 + Math.floor(rnd(rng, 0, 8));
    for (let k = 0; k < n; k++) {
      const f = rnd(rng, 1, 2000);
      d.rows.push({ name: 'r' + k, sensor: ['phone23', 'phone1', 'm43', 'apsc_c', 'apsc', 'ff', 'mf4433', 'custom'][Math.floor(rnd(rng, 0, 8))], f: f, N: rnd(rng, 0.7, 64), s: Math.max(f / 1000 * 1.0002, rnd(rng, 0.03, 100000)) });
    }
    cases.push(d);
  }
  let checked = 0;
  cases.forEach((d, i) => {
    const r = C.analyze(d);
    if (!r.ok) return;
    checked++;
    const bad = r.checks.filter((x) => !x.ok).map((x) => x.msg + '|' + x.extra);
    assert.deepStrictEqual(bad, [], '第 ' + i + ' 组结构自检失败：' + JSON.stringify(bad));
  });
  assert.ok(checked >= 350, '有效组数应 ≥ 350，实际 ' + checked);
});

/* ══════════════ 6. 单位、格式化、舍入 ══════════════ */
test('单位：同一物理配置用 m / mm 两种路径算出的结果完全相同', () => {
  const c = C_FF;
  const fromM = C.optics(50, 8, 3 * P, c, 550e-6);
  const fromMm = C.optics(50, 8, 3000, c, 550e-6);
  assert.deepStrictEqual(fromM, fromMm);
});

test('单位：λ 以 nm 输入、按 mm 使用；550 nm ↔ 0.00055 mm', () => {
  const a = C.optics(50, 8, 3000, C_FF, 550 / 1e6);
  const b = C.optics(50, 8, 3000, C_FF, 550e-6);
  assert.deepStrictEqual(a.airy, b.airy);
  close(a.airy, 2.44 * 550e-6 * 8, 1e-15, '艾里斑直径');
});

test('格式化：距离与长度在量级间切换正确，且不产生 NaN', () => {
  assert.strictEqual(C.fmtDist(Infinity), '∞');
  assert.strictEqual(C.fmtDist(0.05), '50.0 mm');
  assert.strictEqual(C.fmtDist(0.5), '0.500 m');
  assert.strictEqual(C.fmtDist(2.857142857), '2.857 m');
  assert.strictEqual(C.fmtDist(31.004), '31.00 m');
  assert.strictEqual(C.fmtMm(0.0005), '0.500 µm');
  assert.strictEqual(C.fmtMm(0.005), '0.00500 mm');
  assert.strictEqual(C.fmtMm(0.1059), '0.1059 mm');
  [C.fmtDist(0.03), C.fmtDist(1e9), C.fmtMm(1e-6), C.fmtMm(1e3), C.fmtPct(0)].forEach((s) => {
    assert.ok(!/NaN|undefined/.test(s), '不应出现 NaN/undefined：' + s);
  });
});

test('舍入：前后景深之和等于总景深；前后比 = 后 ÷ 前', () => {
  const rng = seeded(606);
  for (let i = 0; i < 200; i++) {
    const f = rnd(rng, 6, 400), N = rnd(rng, 1, 22), sMm = f * rnd(rng, 4, 300);
    const o = C.optics(f, N, sMm, C_FF, 550e-6);
    if (o.dfInf) continue;
    rel(o.front + o.back, o.total, 1e-12, '前后之和 = 总景深');
    rel(o.back / o.front, o.back / o.front, 0, '占位');
    close(o.front, sMm - o.dn, 1e-9, '前景深 = s − Dn');
    close(o.back, o.df - sMm, 1e-9, '后景深 = Df − s');
  }
});

/* ══════════════ 7. 非法输入与阈值两侧 ══════════════ */
function base(over) {
  const d = C.defaultsClone();
  return Object.assign(d, over || {});
}
test('非法输入：逐条核到具体字段', () => {
  const cases = [
    ['空输入', {}, 'rows'],
    ['方案为空数组', base({ rows: [] }), 'rows'],
    ['方案超过 8 个', base({ rows: new Array(9).fill({ name: 'x', sensor: 'ff', f: 50, N: 8, s: 3 }) }), 'rows'],
    ['名称为空', base({ rows: [{ name: '  ', sensor: 'ff', f: 50, N: 8, s: 3 }] }), 'name'],
    ['名称超 20 字', base({ rows: [{ name: '一二三四五六七八九十一二三四五六七八九十一', sensor: 'ff', f: 50, N: 8, s: 3 }] }), 'name'],
    ['焦距为空', base({ rows: [{ name: 'a', sensor: 'ff', f: '', N: 8, s: 3 }] }), 'f'],
    ['焦距非数字', base({ rows: [{ name: 'a', sensor: 'ff', f: 'abc', N: 8, s: 3 }] }), 'f'],
    ['焦距过小', base({ rows: [{ name: 'a', sensor: 'ff', f: 0.99, N: 8, s: 3 }] }), 'f'],
    ['焦距过大', base({ rows: [{ name: 'a', sensor: 'ff', f: 2001, N: 8, s: 3 }] }), 'f'],
    ['光圈过小', base({ rows: [{ name: 'a', sensor: 'ff', f: 50, N: 0.69, s: 3 }] }), 'N'],
    ['光圈过大', base({ rows: [{ name: 'a', sensor: 'ff', f: 50, N: 64.1, s: 3 }] }), 'N'],
    ['对焦距离过小', base({ rows: [{ name: 'a', sensor: 'ff', f: 50, N: 8, s: 0.029 }] }), 's'],
    ['对焦距离不大于焦距', base({ rows: [{ name: 'a', sensor: 'ff', f: 500, N: 8, s: 0.4 }] }), 's'],
    ['波长过小', base({ lambda: 379 }), 'lambda'],
    ['波长过大', base({ lambda: 781 }), 'lambda'],
    ['目标近点过小', base({ target: { near: 0.009, far: 5, farInf: false } }), 'target.near'],
    ['目标远点 ≤ 近点', base({ target: { near: 5, far: 5, farInf: false } }), 'target.far'],
    ['自定义 c 过小', base({ coc: { mode: 'custom', c: 0.0005 } }), 'coc.c'],
    ['自定义 c 过大', base({ coc: { mode: 'custom', c: 0.6 } }), 'coc.c'],
    ['像素数过小', base({ coc: { mode: 'pixel', px: 500 } }), 'coc.px'],
    ['像素数过大', base({ coc: { mode: 'pixel', px: 30000 } }), 'coc.px'],
    ['自定义画幅过大', base({ customSensor: { w: 400, h: 24 } }), 'customSensor.w'],
    ['反推焦距过大', base({ solveF: 2001 }), 'solveF']
  ];
  cases.forEach(([label, input, field]) => {
    const r = C.analyze(input);
    assert.strictEqual(r.ok, false, label + ' 应当被拒绝');
    assert.ok(r.errors.length > 0, label + ' 应当有错误条目');
    assert.ok(r.errors.some((e) => e.field === field),
      label + ' 应命中字段 ' + field + '，实际 ' + JSON.stringify(r.errors.map((e) => e.field)));
    assert.ok(r.checks.length === 0, label + ' 被拒时不应产出结构自检结果');
  });
});

test('阈值两侧：合法边界值必须通过', () => {
  const ok = [
    base({ rows: [{ name: 'a', sensor: 'ff', f: 1, N: 0.7, s: 0.03 }] }),
    base({ rows: [{ name: 'a', sensor: 'ff', f: 2000, N: 64, s: 100000 }] }),
    base({ lambda: 380 }),
    base({ lambda: 780 }),
    base({ target: { near: 0.01, far: 0.02, farInf: false } }),
    base({ coc: { mode: 'custom', c: 0.001 } }),
    base({ coc: { mode: 'custom', c: 0.5 } }),
    base({ coc: { mode: 'pixel', px: 1000 } }),
    base({ coc: { mode: 'pixel', px: 20000 } }),
    base({ solveF: 1 }),
    base({ solveF: 2000 })
  ];
  ok.forEach((d, i) => {
    const r = C.analyze(d);
    assert.strictEqual(r.ok, true, '第 ' + i + ' 组边界值应当合法：' + JSON.stringify(r.errors));
  });
});

test('空结果：方案全被拒时不产出半成品结果', () => {
  const r = C.analyze(base({ rows: [{ name: '', sensor: 'ff', f: 0, N: 0, s: 0 }] }));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.rows, []);
  assert.deepStrictEqual(r.checks, []);
});

test('零分母不谎报：s 恰好等于 f 被拒；目标两端相等被拒', () => {
  const a = C.analyze(base({ rows: [{ name: 'a', sensor: 'ff', f: 1000, N: 8, s: 1 }] }));
  assert.strictEqual(a.ok, false, 's = f/1000 应被拒');
  const b = C.analyze(base({ target: { near: 3, far: 3, farInf: false } }));
  assert.strictEqual(b.ok, false, '两端相等应被拒');
});

test('合法输入不产生 NaN，且告警能提示近摄与退化口径', () => {
  const r = C.analyze(base({
    coc: { mode: 'diag1500' },
    rows: [{ name: '近摄', sensor: 'apsc', f: 100, N: 8, s: 0.25 },
      { name: '退化', sensor: 'ff', f: 1, N: 64, s: 3 }]
  }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /近摄/.test(w)), '应有近摄提醒');
  assert.ok(r.warnings.some((w) => /退化/.test(w)), '应有退化口径提醒');
  r.rows.forEach((x) => {
    assert.ok(isFinite(x.dn) && x.dn > 0, '近点应为正有限值');
  });
});

/* ══════════════ 8. 覆盖判定 ══════════════ */
test('覆盖判定四种情形与边界（含目标远点为 ∞）', () => {
  const near = 2000, far = 5000;
  assert.strictEqual(C.coverage(1000, 9000, near, far, false).verdict, 'cover');
  assert.strictEqual(C.coverage(3000, 9000, near, far, false).verdict, 'near');
  assert.strictEqual(C.coverage(1000, 4000, near, far, false).verdict, 'far');
  assert.strictEqual(C.coverage(3000, 4000, near, far, false).verdict, 'both');
  assert.strictEqual(C.coverage(1000, Infinity, near, far, false).verdict, 'cover');
  assert.strictEqual(C.coverage(1000, 9000, near, Infinity, true).verdict, 'far');
  assert.strictEqual(C.coverage(1000, Infinity, near, Infinity, true).verdict, 'cover');
  assert.strictEqual(C.coverage(3000, Infinity, near, Infinity, true).verdict, 'near');
  /* 恰好贴合两端也算覆盖 */
  assert.strictEqual(C.coverage(2000, 5000, near, far, false).verdict, 'cover');
  /* 缺口数值 */
  const g = C.coverage(2500, 4000, near, far, false);
  assert.strictEqual(g.gapNear, 500);
  assert.strictEqual(g.gapFar, 1000);
  assert.strictEqual(C.coverage(1000, 9000, near, Infinity, true).gapFar, Infinity);
});

/* ══════════════ 9. 输出契约、确定性、不修改入参 ══════════════ */
test('输出契约：无 NaN/undefined，∞ 只出现在允许字段上（默认 + 6 场景）', () => {
  const list = [C.defaultsClone()];
  C.scenarios.forEach((sc) => {
    const d = C.defaultsClone();
    if (sc.patch.target) d.target = sc.patch.target;
    if (sc.patch.rows) d.rows = sc.patch.rows;
    if (sc.patch.coc) d.coc = sc.patch.coc;
    list.push(d);
  });
  list.forEach((d, i) => {
    const r = C.analyze(d);
    assert.strictEqual(r.ok, true, '第 ' + i + ' 组应合法');
    const c = r.checks.filter((x) => /NaN|∞ 只出现在/.test(x.msg))[0];
    assert.ok(c && c.ok, '第 ' + i + ' 组输出契约应通过：' + (c ? c.extra : '缺检查项'));
  });
});

test('确定性：同一份输入两次分析逐字节一致', () => {
  const d = C.defaultsClone();
  const a = JSON.stringify(C.analyze(d));
  const b = JSON.stringify(C.analyze(d));
  assert.strictEqual(a, b);
});

test('不修改入参：分析前后输入对象深度相等', () => {
  const d = C.defaultsClone();
  const before = JSON.stringify(d);
  C.analyze(d);
  assert.strictEqual(JSON.stringify(d), before);
});

test('每个方案的字段都在合理值域内', () => {
  const r = C.analyze(C.defaultsClone());
  r.rows.forEach((x) => {
    assert.ok(x.H > 0 && isFinite(x.H), '超焦距应为正有限值');
    assert.ok(x.dn > 0 && x.dn < x.s, '近点应在 (0, s) 内');
    assert.ok(x.df === Infinity || x.df > x.s, '远点应为 ∞ 或大于 s');
    assert.ok(x.front > 0, '前景深应为正');
    assert.ok(x.blurInf > 0 && isFinite(x.blurInf), '背景弥散圆应为正有限值');
    assert.ok(x.nDiff > 0.7 && x.nDiff < 64, '衍射转折光圈应落在本页可处理区间内');
    assert.ok(x.crop > 0, '等效系数应为正');
    assert.ok(isFinite(x.NEq) && x.NEq > 0, '等效光圈应为正有限值');
  });
});

/* ══════════════ 10. 等效口径与衍射 ══════════════ */
test('等效口径恒等式：等效方案的近点/远点 = 按 k 缩放的闭式解', () => {
  const rng = seeded(8080);
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const f = rnd(rng, 8, 300), N = rnd(rng, 1.2, 16), sMm = f * rnd(rng, 6, 300);
    const c = rnd(rng, 0.006, 0.03);
    const k = rnd(rng, 0.3, 6);
    const o = C.optics(f, N, sMm, c, 550e-6);
    if (sMm <= f * k) continue;                          // 等效后无法对焦，不适用
    const oEq = C.optics(f * k, N * k, sMm, c * k, 550e-6);
    const A = c * N * (sMm - f), B = c * N * f * (k - 1);
    rel(oEq.dn, f * f * sMm / (f * f + A - B), 1e-9, '等效近点');
    if (!oEq.dfInf) rel(oEq.df, f * f * sMm / (f * f - A + B), 1e-9, '等效远点');
    n++;
  }
  assert.ok(n >= 150, '有效组数应 ≥ 150，实际 ' + n);
});

test('等效口径：手机 f/1.8 ≡ 全画幅 f/10.16（默认锚点），且偏差被如实报出', () => {
  const r = C.analyze(C.defaultsClone());
  const ph = r.rows.filter((x) => x.sensor === 'phone23')[0];
  close(ph.crop, 5.6438, 0.001, '等效系数');
  close(ph.fEq, 24.268, 0.01, '等效焦距');
  close(ph.NEq, 10.159, 0.01, '等效光圈');
  assert.ok(ph.eqDevNear > 0.005 && ph.eqDevNear < 0.006, '近点偏差约 0.57%');
  assert.ok(ph.eqDevFar > 0.035 && ph.eqDevFar < 0.039, '远点偏差约 3.74%');
  /* 等效是近似：偏差必须与闭式预测一致 */
  rel(ph.eqDevNear, ph.eqPredNear, 1e-9, '近点偏差与闭式预测一致');
});

test('等效系数：全画幅为 1，画幅越大系数越小', () => {
  const r = C.analyze(base({
    rows: [
      { name: 'ff', sensor: 'ff', f: 50, N: 8, s: 5 },
      { name: 'mf', sensor: 'mf4433', f: 50, N: 8, s: 5 },
      { name: 'm43', sensor: 'm43', f: 50, N: 8, s: 5 }
    ]
  }));
  const [ff, mf, m43] = r.rows;
  close(ff.crop, 1, 1e-12, '全画幅系数为 1');
  assert.ok(mf.crop < ff.crop && ff.crop < m43.crop, '画幅越大等效系数越小');
});

test('衍射判据：N = N_d 时艾里斑恰好等于弥散圆；小底转折点远早于全画幅', () => {
  const ndFF = C.optics(50, 8, 3000, C_FF, 550e-6).nDiff;
  const ndPhone = C.optics(4.3, 1.8, 1500, C.sensorDiag(C.sensorDims('phone23')) / 1500, 550e-6).nDiff;
  close(ndFF, 21.494, 0.01, '全画幅 N_d');
  close(ndPhone, 3.808, 0.01, '1/2.3 英寸 N_d');
  assert.ok(ndPhone < ndFF, '小底的衍射转折点必须更早');
  [[50, C_FF], [4.3, C.sensorDiag(C.sensorDims('phone23')) / 1500]].forEach(([f, c]) => {
    const nd = C.optics(f, 8, 3000, c, 550e-6).nDiff;
    rel(2.44 * 550e-6 * nd, c, 1e-12, '艾里斑 = 弥散圆');
  });
  const over = C.analyze(base({ rows: [{ name: 'p', sensor: 'phone23', f: 4.3, N: 8, s: 1.5 }] }));
  assert.strictEqual(over.rows[0].diffractionLimited, true, '手机收到 f/8 应判为已过衍射');
  const under = C.analyze(base({ rows: [{ name: 'p', sensor: 'ff', f: 50, N: 8, s: 3 }] }));
  assert.strictEqual(under.rows[0].diffractionLimited, false, '全画幅 f/8 不应判为过衍射');
});

/* ══════════════ 11. 默认锚点与场景 ══════════════ */
test('默认锚点：6 个方案的关键数字与判定', () => {
  const r = C.analyze(C.defaultsClone());
  assert.strictEqual(r.rows.length, 6);
  const want = [
    ['广角 24mm f/8', 2.520, 1.368, Infinity, 'cover'],
    ['标准 50mm f/2.8', 31.004, 2.739, 3.316, 'both'],
    ['标准 50mm f/8', 10.884, 2.358, 4.123, 'both'],
    ['标准 50mm f/16', 5.467, 1.942, 6.587, 'cover'],
    ['中长焦 85mm f/4', 62.705, 3.765, 4.267, 'both'],
    ['手机主摄 4.3mm f/1.8', 2.014, 0.860, 5.863, 'cover']
  ];
  r.rows.forEach((x, i) => {
    assert.strictEqual(x.name, want[i][0]);
    close(x.H, want[i][1], 0.002, want[i][0] + ' 超焦距');
    close(x.dn, want[i][2], 0.002, want[i][0] + ' 近点');
    if (want[i][3] === Infinity) assert.strictEqual(x.df, Infinity);
    else close(x.df, want[i][3], 0.005, want[i][0] + ' 远点');
    assert.strictEqual(x.cover, want[i][4], want[i][0] + ' 覆盖判定');
  });
  assert.strictEqual(r.rows.filter((x) => x.covered).length, 3, '3 个方案覆盖完整');
});

test('默认锚点：手机主摄盖得住、全画幅 50mm 收到 f/8 盖不住（画幅决定景深口径）', () => {
  const r = C.analyze(C.defaultsClone());
  const phone = r.rows.filter((x) => x.sensor === 'phone23')[0];
  const ff8 = r.rows.filter((x) => x.f === 50 && x.N === 8)[0];
  assert.strictEqual(phone.covered, true);
  assert.strictEqual(ff8.covered, false);
  assert.ok(phone.total > ff8.total * 2, '手机的总景深应远大于全画幅 50mm');
  assert.ok(phone.NEq > 8, '手机的等效光圈应比全画幅 f/8 更小（数值更大）');
});

test('6 个内置场景都能算出来、都有主结论、结构自检全过', () => {
  C.scenarios.forEach((sc) => {
    const d = C.defaultsClone();
    if (sc.patch.target) d.target = sc.patch.target;
    if (sc.patch.rows) d.rows = sc.patch.rows;
    if (sc.patch.coc) d.coc = sc.patch.coc;
    const r = C.analyze(d);
    assert.strictEqual(r.ok, true, sc.id + ' 应能算出结果：' + JSON.stringify(r.errors));
    assert.ok(r.rows.length >= 1, sc.id + ' 应有方案');
    assert.ok(r.insights.length >= 4, sc.id + ' 应有主结论');
    assert.strictEqual(r.checks.filter((c) => !c.ok).length, 0, sc.id + ' 结构自检应全过');
    assert.strictEqual(r.checks.length, 13, sc.id + ' 应有 13 项结构自检');
  });
});

test('小底衍射场景：收到 f/4 以后被判已过衍射', () => {
  const sc = C.scenarios.filter((x) => x.id === 'small')[0];
  const d = C.defaultsClone();
  d.target = sc.patch.target;
  d.rows = sc.patch.rows;
  const r = C.analyze(d);
  assert.strictEqual(r.rows[0].diffractionLimited, false, 'f/1.8 未过衍射');
  assert.strictEqual(r.rows[1].diffractionLimited, true, 'f/4 已过衍射');
  assert.strictEqual(r.rows[3].diffractionLimited, true, 'f/8 已过衍射');
});

test('风光场景：目标 1 m–∞ 时，24mm 需要 f/10.11 且对焦在 2 m', () => {
  const sc = C.scenarios.filter((x) => x.id === 'landscape')[0];
  const d = C.defaultsClone();
  d.target = sc.patch.target;
  d.rows = sc.patch.rows;
  d.solveF = 24;
  const r = C.analyze(d);
  assert.strictEqual(r.reverse.ok, true);
  close(r.reverse.sStar, 2, 1e-9, 's* = 2×近点');
  close(r.reverse.nStar, 10.1059, 0.001, '24mm 要 f/10.11');
  assert.strictEqual(r.reverse.backDf, Infinity, '远点必须是 ∞');
});

test('场景的 rows 数量都不超过上限，且名称都不超长', () => {
  C.scenarios.forEach((sc) => {
    if (!sc.patch.rows) return;
    assert.ok(sc.patch.rows.length <= C.MAX_ROWS, sc.id + ' 方案数超上限');
    sc.patch.rows.forEach((x) => {
      assert.ok(x.name.length <= C.NAME_MAX, sc.id + ' 名称超长：' + x.name);
    });
  });
});

/* ══════════════ 12. 说明里引用的数字都能回溯 ══════════════ */
test('页面与说明里引用的每个锚点都能在同一次计算里找到', () => {
  const r = C.analyze(C.defaultsClone());
  const rev = r.reverse, law = r.laws;
  /* 超焦距恒等式引用的数 */
  close(law.hyper.halfH, law.H / 2, 1e-12);
  close(law.hyper.dn, law.H / 2, 1e-12);
  /* 前 1/3 后 2/3 引用的数 */
  close(law.third.predRatioBack, (2 * law.H * P - 3 * law.f) / (law.H * P), 1e-12);
  close(law.third.predShare, (law.H * P) / (3 * (law.H * P - law.f)), 1e-12);
  /* 反推引用的数 */
  close(rev.nStar, 13.2324, 0.001);
  close(rev.backDn, 2, 1e-9);
  close(rev.backDf, 5, 1e-9);
  /* 衍射与等效引用的数 */
  const phone = r.rows.filter((x) => x.sensor === 'phone23')[0];
  close(phone.nDiff, 3.808, 0.01);
  close(phone.NEq, 10.159, 0.01);
  /* 每一条主结论都带标题与正文 */
  r.insights.forEach((i) => {
    assert.ok(i.title && i.title.length > 4, '结论标题不应为空');
    assert.ok(i.body && i.body.length > 40, '结论正文不应过短：' + i.key);
    assert.ok(!/NaN|undefined/.test(i.body), '结论正文不应含 NaN/undefined：' + i.key);
  });
});

test('「这份账不算什么」清单非空且覆盖关键边界', () => {
  assert.ok(C.LIMITS.length >= 8);
  const all = C.LIMITS.join('|');
  ['几何光学', '弥散圆', '光瞳放大率', '不联网', '衍射', '虚构示例'].forEach((k) => {
    assert.ok(all.indexOf(k) >= 0, '边界清单应提到：' + k);
  });
});

test('默认数据被明确标注为虚构示例', () => {
  const all = C.scenarios.map((s) => s.name).join('|') + '|' + C.LIMITS.join('|');
  assert.ok(/虚构/.test(all), '场景与边界清单里必须出现「虚构」');
});
