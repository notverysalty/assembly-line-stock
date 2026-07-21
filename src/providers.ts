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

/**
 * 解析新浪场外基金行情（原天天基金 fundgz 接口 2026-07 下线后的主源）。
 * fu_<code> 盘中估值：名称,时间,估算净值,昨日单位净值,累计净值,?,估算涨跌幅%,日期,...
 * f_<code>  每日净值：名称,单位净值,累计净值,前一日净值,净值日期,规模（货币基金 f[1] 为万份收益、f[3] 空）
 * 估值优先，无估值的品种（如货币基金 fu_ 返回空串）降级用每日净值。
 */
export function parseSinaFunds(raw: string, codes: string[]): Record<string, Tick> {
  const lines: Record<string, string[]> = {};
  for (const line of raw.split(';')) {
    const m = line.match(/hq_str_(fu?_\d{6})="([^"]*)"/i);
    if (m && m[2]) {
      lines[m[1].toLowerCase()] = m[2].split(',');
    }
  }
  const out: Record<string, Tick> = {};
  for (const code of codes) {
    const fu = lines[`fu_${code}`];
    const f = lines[`f_${code}`];
    if (fu && fu.length >= 8) {
      const price = num(fu[2]);
      const prevClose = num(fu[3]);
      out[code] = {
        name: fu[0] || undefined,
        priceStr: fu[2],
        price,
        prevClose,
        open: 0,
        high: 0,
        low: 0,
        change: +(price - prevClose).toFixed(4),
        changePct: num(fu[6]),
        time: `${fu[7]} ${fu[1].slice(0, 5)}`,
        isFund: true,
      };
    } else if (f && f.length >= 5) {
      const price = num(f[1]);
      const prevClose = num(f[3]);
      out[code] = {
        name: f[0] || undefined,
        priceStr: f[1],
        price,
        prevClose,
        open: 0,
        high: 0,
        low: 0,
        change: prevClose ? +(price - prevClose).toFixed(4) : 0,
        changePct: prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0,
        time: f[4] || '',
        isFund: true,
      };
    }
  }
  return out;
}

/** 备源：天天基金移动端 API。官方已停供盘中估值（GSZ 常为 null），多数只有每日净值口径。 */
async function fetchFundsMob(codes: string[]): Promise<Record<string, Tick>> {
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?Fcodes=${codes.join(',')}` +
    `&pageIndex=1&pageSize=${codes.length}&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1`;
  const raw = await httpGet(url, 'utf8');
  const json = JSON.parse(raw) as { Datas?: Record<string, unknown>[] };
  const out: Record<string, Tick> = {};
  for (const d of json.Datas ?? []) {
    const code = String(d.FCODE ?? '');
    if (!code) {
      continue;
    }
    const hasGsz = d.GSZ != null && d.GSZ !== '';
    const priceStr = String(hasGsz ? d.GSZ : d.NAV ?? '');
    const price = num(priceStr);
    const pct = num(String(hasGsz ? d.GSZZL : d.NAVCHGRT));
    const denom = 1 + pct / 100;
    const prevClose = denom ? +(price / denom).toFixed(4) : 0;
    out[code] = {
      name: d.SHORTNAME ? String(d.SHORTNAME) : undefined,
      priceStr,
      price,
      prevClose,
      open: 0,
      high: 0,
      low: 0,
      change: +(price - prevClose).toFixed(4),
      changePct: pct,
      time: String((hasGsz ? d.GZTIME : d.PDATE) ?? ''),
      isFund: true,
    };
  }
  return out;
}

/** 场外基金主入口：新浪（估值+净值）为主、一次批量；失败切天天基金移动端 API */
export async function fetchFunds(codes: string[]): Promise<Record<string, Tick>> {
  if (!codes.length) {
    return {};
  }
  try {
    const list = [...codes.map((c) => `fu_${c}`), ...codes.map((c) => `f_${c}`)].join(',');
    const raw = await httpGet(`https://hq.sinajs.cn/list=${list}`, 'gbk', {
      Referer: 'https://finance.sina.com.cn',
    });
    const r = parseSinaFunds(raw, codes);
    if (Object.keys(r).length > 0) {
      return r;
    }
  } catch (e) {
    console.error('[stock-watcher] sina fund failed, fallback to mob api:', e);
  }
  try {
    return await fetchFundsMob(codes);
  } catch (e) {
    console.error('[stock-watcher] fund fallback failed:', e);
    return {};
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
