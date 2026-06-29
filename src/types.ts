/** 标的所属市场 */
export type Market = 'cn' | 'hk' | 'us' | 'fund';

/** 一只标的的实时归一化数据（可序列化进缓存） */
export interface Tick {
  name?: string; // 名称（GBK 解码后为正确中文名）
  priceStr: string; // 显示用价格（保留接口原始精度，如基金 4 位小数）
  price: number; // 计算用价格
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number; // 涨跌额
  changePct: number; // 涨跌幅 %
  time: string;
  isFund: boolean;
}

/** 解析后的自选项 */
export interface SymbolItem {
  code: string; // 拉取用代码（小写：sh600519 / 161725 / hk00700）
  alias?: string;
  market: Market;
  cost?: number; // 持仓成本价
  shares?: number; // 持仓数量（股 / 份）
  alertAbove?: number; // 价格 ≥ 此值时提醒
  alertBelow?: number; // 价格 ≤ 此值时提醒
  alertPct?: number; // 当日涨跌幅绝对值 ≥ 此值时提醒
  lof?: boolean; // LOF / 分级：同时显示场内实时价 + 场外净值
  lofCode?: string; // 场内代码（lof 时推断或显式指定，如 sz161725）
}

/** 根据代码前缀判断所属市场 */
export function detectMarket(code: string): Market {
  if (/^\d{6}$/.test(code)) {
    return 'fund'; // 6 位纯数字 = 场外基金
  }
  if (code.startsWith('hk')) {
    return 'hk';
  }
  if (code.startsWith('us')) {
    return 'us';
  }
  return 'cn'; // sh / sz / bj
}

/** LOF 场内代码推断：沪市 5 字头用 sh，其余（深市 16x/15x 等）用 sz */
export function inferLofCode(fundCode: string): string {
  return (fundCode.startsWith('5') ? 'sh' : 'sz') + fundCode;
}
