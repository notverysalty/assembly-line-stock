import * as https from 'https';
import { TextDecoder } from 'util';
import { Tick } from './types';

/** 通用 HTTPS GET。encoding 传 'gbk' 时用内置 TextDecoder 解码（零依赖拿中文名）。 */
export function httpGet(
  url: string,
  encoding: BufferEncoding | 'gbk' = 'utf8',
  headers?: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(encoding === 'gbk' ? new TextDecoder('gbk').decode(buf) : buf.toString(encoding));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

function num(s: string): number {
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function fmtTime(ts: string): string {
  if (!ts || ts.length < 14) {
    return ts || '';
  }
  return `${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`;
}

/** 场内（股票/ETF/指数/港股/美股）：腾讯行情，一次批量。GBK 解码（含正确中文名）。 */
async function fetchTencent(codes: string[]): Promise<Record<string, Tick>> {
  const out: Record<string, Tick> = {};
  if (!codes.length) {
    return out;
  }
  const raw = await httpGet(`https://qt.gtimg.cn/q=${codes.join(',')}`, 'gbk');
  for (const line of raw.split(';')) {
    const m = line.match(/v_([a-z0-9]+)="([^"]*)"/i);
    if (!m) {
      continue;
    }
    const code = m[1].toLowerCase();
    const f = m[2].split('~');
    if (f.length < 35) {
      continue;
    }
    out[code] = {
      name: f[1] || undefined,
      priceStr: f[3],
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      high: num(f[33]),
      low: num(f[34]),
      change: num(f[31]),
      changePct: num(f[32]),
      time: fmtTime(f[30]),
      isFund: false,
    };
  }
  return out;
}

/** 备用源：新浪行情（需 Referer），处理 A 股 sh/sz/bj。GBK 解码（名称 f[0]），涨跌幅自算。 */
async function fetchSina(codes: string[]): Promise<Record<string, Tick>> {
  const out: Record<string, Tick> = {};
  const a = codes.filter((c) => c.startsWith('sh') || c.startsWith('sz') || c.startsWith('bj'));
  if (!a.length) {
    return out;
  }
  const raw = await httpGet(`https://hq.sinajs.cn/list=${a.join(',')}`, 'gbk', {
    Referer: 'https://finance.sina.com.cn',
  });
  for (const line of raw.split(';')) {
    const m = line.match(/hq_str_([a-z0-9]+)="([^"]*)"/i);
    if (!m) {
      continue;
    }
    const code = m[1].toLowerCase();
    const f = m[2].split(',');
    if (f.length < 32) {
      continue;
    }
    const prevClose = num(f[2]);
    const price = num(f[3]);
    const change = price - prevClose;
    const pct = prevClose ? (change / prevClose) * 100 : 0;
    out[code] = {
      name: f[0] || undefined,
      priceStr: price ? price.toFixed(2) : f[3],
      price,
      prevClose,
      open: num(f[1]),
      high: num(f[4]),
      low: num(f[5]),
      change: +change.toFixed(2),
      changePct: +pct.toFixed(2),
      time: f[31] || '',
      isFund: false,
    };
  }
  return out;
}

/** 场外基金：天天基金估值（UTF-8 JSONP），名称不乱码 */
export async function fetchFund(code: string): Promise<Tick | undefined> {
  try {
    const raw = (await httpGet(`https://fundgz.1234567.com.cn/js/${code}.js`, 'utf8')).trim();
    const json = raw.replace(/^jsonpgz\(/, '').replace(/\);?$/, '');
    if (!json.startsWith('{')) {
      return undefined;
    }
    const d = JSON.parse(json) as {
      name: string;
      dwjz: string;
      gsz: string;
      gszzl: string;
      gztime: string;
      jzrq: string;
    };
    const price = num(d.gsz);
    const prevClose = num(d.dwjz);
    return {
      name: d.name,
      priceStr: d.gsz,
      price,
      prevClose,
      open: 0,
      high: 0,
      low: 0,
      change: +(price - prevClose).toFixed(4),
      changePct: num(d.gszzl),
      time: d.gztime,
      isFund: true,
    };
  } catch (e) {
    console.error('[stock-watcher] fund failed:', code, e);
    return undefined;
  }
}

/** 场内行情主入口：腾讯为主，整体失败时对 A 股用新浪兜底 */
export async function fetchQuotes(codes: string[]): Promise<Record<string, Tick>> {
  if (!codes.length) {
    return {};
  }
  try {
    const r = await fetchTencent(codes);
    if (Object.keys(r).length > 0) {
      return r;
    }
  } catch (e) {
    console.error('[stock-watcher] tencent failed, fallback to sina:', e);
  }
  try {
    return await fetchSina(codes);
  } catch (e) {
    console.error('[stock-watcher] sina failed:', e);
    return {};
  }
}

// ---- 搜索（东方财富 suggest） ----

export interface SearchHit {
  code: string; // 腾讯格式：sh600519 / sz000001 / hk00700 / us...
  name: string;
  type: string;
}

/** "1.600519" -> sh600519；"0.000001" -> sz000001；"0.830799" -> bj830799；"116.00700" -> hk00700 */
export function quoteIdToCode(quoteId: string): string {
  const [mkt, code] = quoteId.split('.');
  if (!code) {
    return '';
  }
  switch (mkt) {
    case '1':
      return 'sh' + code;
    case '0':
      return code.startsWith('8') || code.startsWith('4') ? 'bj' + code : 'sz' + code;
    case '116':
      return 'hk' + code;
    case '105':
    case '106':
    case '107':
      return 'us' + code;
    default:
      return '';
  }
}

export async function searchStock(keyword: string): Promise<SearchHit[]> {
  const url =
    `https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}` +
    `&type=14&count=10&token=D43BF722C8E33BDC906FB84D85E326E8`;
  const raw = await httpGet(url, 'utf8');
  const json = JSON.parse(raw) as { QuotationCodeTable?: { Data?: Record<string, unknown>[] } };
  const data = json.QuotationCodeTable?.Data ?? [];
  const hits: SearchHit[] = [];
  for (const d of data) {
    const code = quoteIdToCode(String(d.QuoteID ?? ''));
    if (code) {
      hits.push({ code, name: String(d.Name ?? ''), type: String(d.SecurityTypeName ?? '') });
    }
  }
  return hits;
}

// ---- 历史 K 线 / 净值 ----

export interface Kline {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A 股日 K（新浪），支持 sh/sz（含 ETF / 指数）。返回按时间正序。 */
export async function fetchHistory(code: string, days = 60): Promise<Kline[]> {
  const url =
    `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData` +
    `?symbol=${code}&scale=240&datalen=${days}`;
  const raw = await httpGet(url, 'utf8');
  const arr = JSON.parse(raw) as Record<string, string>[];
  return arr.map((d) => ({
    day: String(d.day),
    open: num(d.open),
    high: num(d.high),
    low: num(d.low),
    close: num(d.close),
    volume: num(d.volume),
  }));
}

/** 场外基金历史净值（天天基金 lsjz，需 Referer）。净值序列，无 OHLC，按时间正序。 */
export async function fetchFundHistory(code: string, count = 30): Promise<Kline[]> {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${count}`;
  const raw = await httpGet(url, 'utf8', { Referer: 'https://fundf10.eastmoney.com' });
  const json = JSON.parse(raw) as { Data?: { LSJZList?: Record<string, string>[] } };
  const list = json.Data?.LSJZList ?? [];
  // 基金只有单位净值：开高低收统一用净值，便于复用走势图与表格
  return list
    .map((d) => {
      const v = num(d.DWJZ);
      return { day: String(d.FSRQ), open: v, high: v, low: v, close: v, volume: 0 };
    })
    .reverse(); // 接口返回最新在前，转为时间正序
}
