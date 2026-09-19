#!/usr/bin/env node
/**
 * tests/qa_110_litbright.test.mjs
 * ---------------------------------------------------------------------------
 * NMS 电力模拟器 1.0.10 · 「灯柱 / 发光地板」亮灭视觉 · 结构性回归套件（QA 严过关）
 *
 * 背景需求：用户反馈「发光和不发光视觉上非常难分辨」。
 * 1.0.10 重做口径（期望值独立推导，未参考工程师实现细节之外的东西）：
 *   亮 = 三层同色泛光（opacity 0.12 / 0.28 / 0.55，尺寸递增）+ 白色高光芯（lamp 0.5 / glow_floor 0.45）
 *        + 本体 fill = 该色 on
 *   灭 = 本体 fill = 中性深灰 #2a3641（UNLIT_FILL）+ 恰好一圈 off 色细色环（lamp 2.5 / glow_floor 3）
 *        + **不许出现任何 fill = 该色 on 的图元**（这条是「亮灭可分辨」的结构性保证）
 *   任何 lamp / glow_floor 图标不得使用 CSS filter / drop-shadow / blur（1.0.6 起性能红线）。
 *
 * 运行： node tests/qa_110_litbright.test.mjs
 * 通过： exit 0（结尾 LITBRIGHT_PASS）；失败： exit 1
 * ---------------------------------------------------------------------------
 */
import { drawIcon, LIGHT_COLORS } from '../js/catalog.js';

const results = { pass: 0, fail: 0, failures: [] };
function check(name, cond, detail = '') {
  if (cond) results.pass++;
  else { results.fail++; results.failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
  return !!cond;
}
const UNLIT_FILL = '#2a3641';
const TYPES = ['lamp', 'glow_floor'];
const KEYS = ['green', 'pink', 'yellow', 'blue', 'purple', 'white', 'red'];
/** 1.0.9 定稿色板（回归基线：1.0.10 不许顺手改色号） */
const BASELINE = {
  green:  { on: '#2fd06a', off: '#2c5c3f' },
  pink:   { on: '#ff6fb5', off: '#7a3a58' },
  yellow: { on: '#ffd23f', off: '#8a7328' },
  blue:   { on: '#3ea8ff', off: '#22527d' },
  purple: { on: '#b57bff', off: '#573a7d' },
  white:  { on: '#ffffff', off: '#8a949c' },
  red:    { on: '#ff5a4d', off: '#7d2b26' },
};
const CORE_OPACITY = { lamp: '0.5', glow_floor: '0.45' };
const RING_WIDTH = { lamp: '2.5', glow_floor: '3' };
const HALO_OPACITIES = ['0.12', '0.28', '0.55'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 单个图标的审计：返回失败原因数组（空 = 达标）。
 * 抽成函数是为了第 4 节的「反向验证」：故意喂坏图元，必须能被抓到。
 */
function auditIcon(type, colorKey, lit, svg) {
  const c = BASELINE[colorKey];
  const bad = [];
  const rectRe = /<rect\b[^>]*>/g;
  const rects = svg.match(rectRe) || [];
  const attr = (tag, name) => {
    const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
    return m ? m[1] : null;
  };

  if (lit) {
    // 1. 三层泛光：fill=on，opacity 0.12/0.28/0.55 齐全，且尺寸递增
    const halos = rects.filter((r) => attr(r, 'fill') === c.on && HALO_OPACITIES.includes(attr(r, 'opacity')));
    const opas = halos.map((r) => attr(r, 'opacity'));
    if (halos.length !== 3) bad.push(`泛光层数=${halos.length}（应 3 层，opacity ${HALO_OPACITIES.join('/')}）`);
    for (const o of HALO_OPACITIES) if (!opas.includes(o)) bad.push(`缺少 opacity=${o} 的泛光层`);
    if (halos.length === 3) {
      const ws = halos.map((r) => Number(attr(r, 'width')));
      // 泛光必须「外层大而淡、内层小而浓」：宽度随透明度增强而递减，才读成柔和的光衰减
      const desc = ws.slice().sort((a, b) => b - a);
      if (JSON.stringify(ws) !== JSON.stringify(desc)) bad.push('泛光层宽度应外大内小（衰减方向），实测 ' + ws.join('/'));
      // 最内层泛光必须比本体大（否则被本体完全盖住，1.0.9 发光地板的老问题）
      const bodyW = Math.max(...rects.filter((r) => attr(r, 'fill') === c.on && !HALO_OPACITIES.includes(attr(r, 'opacity'))).map((r) => Number(attr(r, 'width'))), 0);
      if (Math.min(...ws) <= bodyW) bad.push(`最内层泛光宽 ${Math.min(...ws)} 未大于本体宽 ${bodyW}`);
    }
    // 2. 高光芯
    const core = rects.find((r) => attr(r, 'fill') === '#ffffff' && attr(r, 'opacity') === CORE_OPACITY[type]);
    if (!core) bad.push(`缺少白色高光芯（#ffffff / opacity=${CORE_OPACITY[type]}）`);
    // 3. 本体 = on 色
    const body = rects.find((r) => attr(r, 'fill') === c.on && attr(r, 'stroke') === '#0b0f13');
    if (!body) bad.push('亮态本体 fill 应为 ' + c.on);
    // 4. 亮态不得出现中性灰本体
    if (rects.some((r) => attr(r, 'fill') === UNLIT_FILL)) bad.push('亮态出现中性灰本体 ' + UNLIT_FILL);
    // 5. 亮态不得出现 off 色环
    if (rects.some((r) => attr(r, 'stroke') === c.off && attr(r, 'fill') === 'none')) bad.push('亮态不应有 off 色环');
  } else {
    // 灭态：不许出现任何 on 色图元（结构上保证「一眼知道没亮」）
    if (svg.includes(c.on)) bad.push(`灭态出现亮色 ${c.on}（这是「亮灭难分辨」的根因，严禁）`);
    if (!svg.includes(UNLIT_FILL)) bad.push('灭态本体应为中性深灰 ' + UNLIT_FILL);
    const ring = rects.filter((r) => attr(r, 'stroke') === c.off && attr(r, 'fill') === 'none');
    if (ring.length !== 1) bad.push(`off 色环应恰好 1 圈，实测 ${ring.length}`);
    if (ring.length === 1 && attr(ring[0], 'stroke-width') !== RING_WIDTH[type]) {
      bad.push(`色环 stroke-width 应为 ${RING_WIDTH[type]}，实测 ${attr(ring[0], 'stroke-width')}`);
    }
    // 灭态不许有高光芯 / 泛光
    if (rects.some((r) => attr(r, 'fill') === '#ffffff')) bad.push('灭态不应有白色高光芯');
  }
  // 6. 性能红线：禁 CSS 滤镜
  if (/filter\s*=|filter\s*:|drop-shadow|blur\(/i.test(svg)) bad.push('出现 CSS 滤镜（性能红线）');
  return bad;
}

/* ================= 1. 7 色 × 2 类 × 亮灭 全量审计 ================= */
for (const type of TYPES) {
  for (const key of KEYS) {
    for (const lit of [true, false]) {
      const svg = drawIcon(type, { state: { lit }, props: { color: key } });
      const bad = auditIcon(type, key, lit, svg);
      check(`${type}/${key}/${lit ? '亮' : '灭'} 结构达标`, bad.length === 0, bad.join('；'));
    }
  }
}

/* ================= 2. 图元数：亮态应多于灭态（结构差异，不只是颜色差异） ================= */
for (const type of TYPES) {
  for (const key of KEYS) {
    const nLit = (drawIcon(type, { state: { lit: true }, props: { color: key } }).match(/<rect\b/g) || []).length;
    const nOff = (drawIcon(type, { state: { lit: false }, props: { color: key } }).match(/<rect\b/g) || []).length;
    check(`${type}/${key} 亮态图元数(${nLit}) > 灭态(${nOff})`, nLit > nOff);
  }
}

/* ================= 3. 缺省 / 非法颜色回退 yellow，且两态仍达标 ================= */
for (const type of TYPES) {
  for (const [label, props] of [['缺省', {}], ['null', { color: null }], ["'orange'", { color: 'orange' }]]) {
    for (const lit of [true, false]) {
      const svg = drawIcon(type, { state: { lit }, props });
      const bad = auditIcon(type, 'yellow', lit, svg);
      check(`${type}/${label}/color=${JSON.stringify(props.color)}/${lit ? '亮' : '灭'} 回退 yellow 达标`, bad.length === 0, bad.join('；'));
    }
  }
}

/* ================= 4. 色板回归基线（1.0.9 → 1.0.10 不许改色号） ================= */
for (const key of KEYS) {
  const c = LIGHT_COLORS[key];
  check(`${key} name=${BASELINE[key] ? '有' : '无'}`, !!c && typeof c.name === 'string' && c.name.length > 0);
  check(`${key}.on 保持 ${BASELINE[key].on}`, c.on === BASELINE[key].on, '实测 ' + c.on);
  check(`${key}.off 保持 ${BASELINE[key].off}`, c.off === BASELINE[key].off, '实测 ' + c.off);
}
check('LIGHT_COLORS 恰 7 个 key', Object.keys(LIGHT_COLORS).length === 7, Object.keys(LIGHT_COLORS).join(','));

/* ================= 5. 反向验证（证明断言有牙齿：喂坏图元必须被抓到） ================= */
const realLit = drawIcon('lamp', { state: { lit: true }, props: { color: 'yellow' } });
const realOff = drawIcon('lamp', { state: { lit: false }, props: { color: 'yellow' } });
{
  // 坏 A：把三层泛光剥掉（回到 1.0.9 的单层 30% 老做法）
  const brokenA = realLit.replace(/<rect x="-2[14]" [^>]*opacity="0\.(12|28)"[^>]*\/>/g, '')
    .replace('opacity="0.55"', 'opacity="0.30"');
  const badA = auditIcon('lamp', 'yellow', true, brokenA);
  check('反向验证 A：剥掉泛光层 / 退回单层 0.30 被抓到', badA.length > 0, badA.join('；') || '(未被察觉!)');

  // 坏 B：灭态本体改回高饱和亮色（1.0.9 的根因做法）
  const brokenB = realOff.replace(new RegExp(esc(UNLIT_FILL), 'g'), BASELINE.yellow.on);
  const badB = auditIcon('lamp', 'yellow', false, brokenB);
  check('反向验证 B：灭态本体改回亮色被抓到', badB.length > 0, badB.join('；') || '(未被察觉!)');

  // 坏 C：偷加 CSS 滤镜
  const brokenC = realLit.replace(/<rect x="-15"/, '<rect style="filter:blur(2px)" x="-15"');
  const badC = auditIcon('lamp', 'yellow', true, brokenC);
  check('反向验证 C：加 CSS 滤镜被抓到', badC.some((s) => s.includes('滤镜')), badC.join('；') || '(未被察觉!)');

  // 坏 D：灭态色环整个删掉（只剩中性灰本体，不知道是哪一色）
  const brokenD = drawIcon('lamp', { state: { lit: false }, props: { color: 'yellow' } })
    .replace(/<rect x="-8" y="-26"[^>]*\/>/, '');
  const badD = auditIcon('lamp', 'yellow', false, brokenD);
  check('反向验证 D：灭态色环被删被抓到', badD.length > 0, badD.join('；') || '(未被察觉!)');
}

/* ================= 6. glow_floor 的泛光必须在底座之外（1.0.9 老问题） ================= */
{
  const svg = drawIcon('glow_floor', { state: { lit: true }, props: { color: 'yellow' } });
  const rects = svg.match(/<rect\b[^>]*>/g) || [];
  const attr = (tag, name) => { const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag); return m ? m[1] : null; };
  const base = rects.find((r) => attr(r, 'fill') === '#141c24');
  const baseW = base ? Number(attr(base, 'width')) : 88;
  const halos = rects.filter((r) => attr(r, 'fill') === BASELINE.yellow.on && HALO_OPACITIES.includes(attr(r, 'opacity')));
  const innermost = Math.min(...halos.map((r) => Number(attr(r, 'width'))));
  check(`glow_floor 最内层泛光(${innermost}) 必须宽于底座(${baseW})，否则被底座盖住`, innermost > baseW);
}

/* ================= 汇总 ================= */
console.log(`\n=== qa_110_litbright 结果 ===`);
console.log(`通过 ${results.pass}  失败 ${results.fail}`);
for (const f of results.failures) console.log('  ✗ ' + f);
console.log(results.fail === 0 ? 'LITBRIGHT_PASS' : 'LITBRIGHT_FAIL');
process.exit(results.fail === 0 ? 0 : 1);
