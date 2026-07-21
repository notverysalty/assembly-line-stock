// 纯逻辑单元测试（不依赖 vscode）。运行：npm test
const assert = require('assert');
const { detectMarket, inferLofCode } = require('../out/types.js');
const { quoteIdToCode, parseSinaFunds } = require('../out/providers.js');
const { isTradingTime, isUsDST } = require('../out/market.js');

let groups = 0;
function t(name, fn) {
  fn();
  groups++;
  console.log('  ✓', name);
}

t('detectMarket 按前缀判断市场', () => {
  assert.strictEqual(detectMarket('sh600519'), 'cn');
  assert.strictEqual(detectMarket('sz159941'), 'cn');
  assert.strictEqual(detectMarket('bj830799'), 'cn');
  assert.strictEqual(detectMarket('161725'), 'fund');
  assert.strictEqual(detectMarket('hk00700'), 'hk');
  assert.strictEqual(detectMarket('usaapl'), 'us');
});

t('quoteIdToCode 东财 QuoteID -> 腾讯代码', () => {
  assert.strictEqual(quoteIdToCode('1.600519'), 'sh600519');
  assert.strictEqual(quoteIdToCode('0.000001'), 'sz000001');
  assert.strictEqual(quoteIdToCode('0.830799'), 'bj830799'); // 8 开头 -> 北交所
  assert.strictEqual(quoteIdToCode('116.00700'), 'hk00700');
  assert.strictEqual(quoteIdToCode('105.AAPL'), 'usAAPL');
  assert.strictEqual(quoteIdToCode('90.BK0001'), ''); // 板块等忽略
});

t('isTradingTime A股交易时段边界', () => {
  assert.strictEqual(isTradingTime(2, 915), false); // 集合竞价前
  assert.strictEqual(isTradingTime(2, 930), true);
  assert.strictEqual(isTradingTime(2, 1130), true);
  assert.strictEqual(isTradingTime(2, 1131), false);
  assert.strictEqual(isTradingTime(2, 1200), false); // 午休
  assert.strictEqual(isTradingTime(2, 1300), true);
  assert.strictEqual(isTradingTime(2, 1500), true);
  assert.strictEqual(isTradingTime(2, 1501), false);
  assert.strictEqual(isTradingTime(6, 1000), false); // 周六
  assert.strictEqual(isTradingTime(0, 1000), false); // 周日
});

t('isUsDST 美东夏令时区间', () => {
  // 2026: DST = 3/8 - 11/1
  assert.strictEqual(isUsDST(new Date('2026-07-01T12:00:00Z')), true);
  assert.strictEqual(isUsDST(new Date('2026-01-15T12:00:00Z')), false);
  assert.strictEqual(isUsDST(new Date('2026-12-15T12:00:00Z')), false);
  assert.strictEqual(isUsDST(new Date('2026-03-09T12:00:00Z')), true); // 3 月第 2 周日后
  assert.strictEqual(isUsDST(new Date('2026-03-01T12:00:00Z')), false); // 3 月初仍冬令时
});

t('inferLofCode LOF 场内代码推断', () => {
  assert.strictEqual(inferLofCode('161725'), 'sz161725'); // 深市 LOF（1 字头）
  assert.strictEqual(inferLofCode('501018'), 'sh501018'); // 沪市 LOF（5 字头）
});

t('parseSinaFunds 基金估值/净值解析（真实接口样本）', () => {
  const raw =
    'var hq_str_fu_161725="招商中证白酒指数A,14:50:00,0.5486,0.5582,2.2743,0,-1.7198,2026-07-21,0.5479,-1.8452";\n' +
    'var hq_str_fu_000198="";\n' + // 货币基金无盘中估值
    'var hq_str_f_161725="招商中证白酒指数A,0.5582,2.2743,0.532,2026-07-20,387.846";\n' +
    'var hq_str_f_000198="天弘余额宝货币,0.2294,0.844,,2026-07-20,6799.46";';
  const r = parseSinaFunds(raw, ['161725', '000198', '999999']);
  // 有盘中估值：走 fu_ 估值口径
  assert.strictEqual(r['161725'].price, 0.5486);
  assert.strictEqual(r['161725'].prevClose, 0.5582);
  assert.strictEqual(r['161725'].changePct, -1.7198);
  assert.strictEqual(r['161725'].name, '招商中证白酒指数A');
  assert.strictEqual(r['161725'].time, '2026-07-21 14:50');
  assert.strictEqual(r['161725'].isFund, true);
  // fu_ 为空串：降级 f_ 每日净值口径；货币基金前值为空 -> 涨跌为 0
  assert.strictEqual(r['000198'].price, 0.2294);
  assert.strictEqual(r['000198'].changePct, 0);
  // 接口没返回的代码不产出条目
  assert.strictEqual(r['999999'], undefined);
});

console.log(`\n${groups} 组测试全部通过 ✅`);
