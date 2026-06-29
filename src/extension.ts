import * as vscode from 'vscode';
import { SymbolItem, Tick, detectMarket, inferLofCode } from './types';
import { readCache, writeCache, Cache } from './cache';
import { isMarketOpen, loadHolidays } from './market';
import { fetchQuotes, fetchFund, searchStock, fetchHistory, fetchFundHistory } from './providers';
import { showHistoryWebview } from './history';
import { StockSidebarProvider, SidebarRow } from './sidebar';

let items: vscode.StatusBarItem[] = [];
let totalItem: vscode.StatusBarItem | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let running = true;
let isRefreshing = false; // 防重入锁
let sidebar: StockSidebarProvider | undefined;
let lastTicks: Record<string, Tick> = {}; // 最近一次行情（设目标价时判断方向）
/** code -> 已触发的提醒类型集合（防重复弹窗，条件解除后重置） */
const alertState: Record<string, Set<string>> = {};

export function activate(context: vscode.ExtensionContext) {
  sidebar = new StockSidebarProvider({
    onHistory: (code) => void showHistory(code),
    onSetTarget: (code, price) => void setTargetPrice(code, price),
    onClearTarget: (code) => void clearTarget(code),
    onRemove: (code) => void removeOne(code),
    onReorder: (from, to) => void reorderSymbols(from, to),
    onAdd: () => void addSymbol(),
    onRefresh: () => void refresh(true, true),
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('stockWatcher.refresh', () => void refresh(true, true)),
    vscode.commands.registerCommand('stockWatcher.toggle', toggle),
    vscode.commands.registerCommand('stockWatcher.add', addSymbol),
    vscode.commands.registerCommand('stockWatcher.remove', removeSymbol),
    vscode.commands.registerCommand('stockWatcher.history', showHistory),
    vscode.window.registerWebviewViewProvider('stockWatcherSidebar', sidebar),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('stockWatcher')) {
        rebuild();
      }
    })
  );
  void loadHolidays();
  rebuild();
}

export function deactivate() {
  stopTimer();
  disposeItems();
}

// ---------- 配置 ----------

interface Config {
  symbols: SymbolItem[];
  interval: number;
  onlyWhenMarketOpen: boolean;
  hideStatusBarWhenClosed: boolean;
  sharedCache: boolean;
  showTotalProfit: boolean;
  riseColor: string;
  fallColor: string;
}

function numOrUndef(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isNaN(n) ? undefined : n;
}

/** 解析一项 symbols 配置：支持字符串 "code:别名" 或对象 {code,alias,cost,shares,alert...,lof} */
function parseSymbol(raw: unknown): SymbolItem | undefined {
  if (typeof raw === 'string') {
    const [code, alias] = raw.split(':');
    const c = code.trim().toLowerCase();
    if (!c) {
      return undefined;
    }
    return { code: c, alias: alias?.trim() || undefined, market: detectMarket(c) };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const c = String(o.code ?? '')
      .trim()
      .toLowerCase();
    if (!c) {
      return undefined;
    }
    const market = detectMarket(c);
    const lof = market === 'fund' && o.lof === true;
    const lofCode = lof
      ? typeof o.lofCode === 'string'
        ? o.lofCode.trim().toLowerCase()
        : inferLofCode(c)
      : undefined;
    return {
      code: c,
      alias: typeof o.alias === 'string' ? o.alias : undefined,
      market,
      cost: numOrUndef(o.cost),
      shares: numOrUndef(o.shares),
      alertAbove: numOrUndef(o.alertAbove),
      alertBelow: numOrUndef(o.alertBelow),
      alertPct: numOrUndef(o.alertPct),
      lof: lof || undefined,
      lofCode,
    };
  }
  return undefined;
}

function getRawSymbols(): unknown[] {
  return vscode.workspace.getConfiguration('stockWatcher').get<unknown[]>('symbols', []);
}

function getConfig(): Config {
  const cfg = vscode.workspace.getConfiguration('stockWatcher');
  const symbols: SymbolItem[] = [];
  for (const r of getRawSymbols()) {
    const s = parseSymbol(r);
    if (s) {
      symbols.push(s);
    }
  }
  return {
    symbols,
    interval: cfg.get<number>('refreshInterval', 60),
    onlyWhenMarketOpen: cfg.get<boolean>('onlyWhenMarketOpen', true),
    hideStatusBarWhenClosed: cfg.get<boolean>('hideStatusBarWhenClosed', true),
    sharedCache: cfg.get<boolean>('sharedCache', true),
    showTotalProfit: cfg.get<boolean>('showTotalProfit', true),
    riseColor: cfg.get<string>('riseColor', '#f5222d'),
    fallColor: cfg.get<string>('fallColor', '#52c41a'),
  };
}

async function writeSymbols(raw: unknown[]): Promise<void> {
  await vscode.workspace
    .getConfiguration('stockWatcher')
    .update('symbols', raw, vscode.ConfigurationTarget.Global);
  // 配置变化会触发 onDidChangeConfiguration -> rebuild
}

// ---------- 状态栏条目 ----------

function disposeItems() {
  items.forEach((i) => i.dispose());
  items = [];
  totalItem?.dispose();
  totalItem = undefined;
}

function rebuild() {
  disposeItems();
  const cfg = getConfig();

  if (cfg.showTotalProfit) {
    totalItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    totalItem.command = 'stockWatcher.refresh';
  }
  cfg.symbols.forEach((s, idx) => {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100 - idx);
    item.command = { title: 'history', command: 'stockWatcher.history', arguments: [s.code] };
    // 显隐由 updateUI 按市场是否开盘控制
    items.push(item);
  });

  startTimer();
  void refresh(true, false);
}

function startTimer() {
  stopTimer();
  if (!running) {
    return;
  }
  const interval = Math.max(5, getConfig().interval);
  timer = setInterval(() => void refresh(), interval * 1000);
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function toggle() {
  running = !running;
  vscode.window.showInformationMessage(`盯盘已${running ? '开启' : '暂停'}`);
  if (running) {
    startTimer();
    void refresh(true, true);
  } else {
    stopTimer();
  }
}

// ---------- 刷新主流程 ----------

async function refresh(ignoreMarketGate = false, ignoreCache = false) {
  if (isRefreshing) {
    return; // 上一次刷新未完成，跳过本次，避免并发重复请求与 UI 乱序
  }
  isRefreshing = true;
  try {
    const cfg = getConfig();
    if (cfg.symbols.length === 0) {
      updateTotal(cfg, {});
      lastTicks = {};
      sidebar?.update([], cfg.riseColor, cfg.fallColor);
      return;
    }

    const ttl = Math.max(5, cfg.interval) * 1000;
    const now = Date.now();
    const useCache = cfg.sharedCache && !ignoreCache;
    const cache: Cache = useCache ? readCache() : {};

    // 收集所有需要的代码：本体 + LOF 场内代码
    const wanted: { code: string; market: SymbolItem['market'] }[] = [];
    for (const s of cfg.symbols) {
      wanted.push({ code: s.code, market: s.market });
      if (s.lof && s.lofCode) {
        wanted.push({ code: s.lofCode, market: 'cn' });
      }
    }
    const seen = new Set<string>();
    const uniq = wanted.filter((w) => (seen.has(w.code) ? false : (seen.add(w.code), true)));

    const ticks: Record<string, Tick> = {};
    const toFetch: string[] = [];
    for (const w of uniq) {
      const entry = cache[w.code];
      if (useCache && entry && now - entry.ts < ttl) {
        ticks[w.code] = entry.tick;
        continue;
      }
      const gated = !ignoreMarketGate && cfg.onlyWhenMarketOpen && !isMarketOpen(w.market);
      if (gated) {
        if (entry) {
          ticks[w.code] = entry.tick;
        }
        continue;
      }
      toFetch.push(w.code);
    }

    if (toFetch.length > 0) {
      const fetched = await fetchCodes(toFetch);
      Object.assign(ticks, fetched);
      if (cfg.sharedCache) {
        const fresh = readCache();
        for (const c of toFetch) {
          if (fetched[c]) {
            fresh[c] = { ts: now, tick: fetched[c] };
          }
        }
        writeCache(fresh);
      }
    }

    updateUI(cfg, ticks);
    updateTotal(cfg, ticks);
    checkAlerts(cfg, ticks);
    lastTicks = ticks;
    sidebar?.update(buildRows(cfg, ticks), cfg.riseColor, cfg.fallColor);
  } finally {
    isRefreshing = false;
  }
}

/** 按代码分流：6 位纯数字走天天基金净值，其余走腾讯/新浪行情；全部并发 */
async function fetchCodes(codes: string[]): Promise<Record<string, Tick>> {
  const out: Record<string, Tick> = {};
  const funds = codes.filter((c) => /^\d{6}$/.test(c));
  const others = codes.filter((c) => !/^\d{6}$/.test(c));
  await Promise.all([
    (async () => {
      Object.assign(out, await fetchQuotes(others));
    })(),
    ...funds
      .map((c) => async () => {
        const t = await fetchFund(c);
        if (t) {
          out[c] = t;
        }
      })
      .map((fn) => fn()),
  ]);
  return out;
}

// ---------- 渲染 ----------

/** 取一只标的的主行情：LOF 优先场内实时价，否则本体 */
function primaryTick(s: SymbolItem, ticks: Record<string, Tick>): Tick | undefined {
  const lofTick = s.lof && s.lofCode ? ticks[s.lofCode] : undefined;
  return lofTick ?? ticks[s.code];
}

function buildRows(cfg: Config, ticks: Record<string, Tick>): SidebarRow[] {
  return cfg.symbols.map((s) => {
    const lofTick = s.lof && s.lofCode ? ticks[s.lofCode] : undefined;
    const t = lofTick ?? ticks[s.code];
    const name = s.alias || t?.name || s.code.replace(/^(sh|sz|bj|hk|us)/, '');
    return {
      code: s.code,
      name,
      priceStr: t?.priceStr ?? '—',
      changePct: t?.changePct ?? 0,
      up: (t?.changePct ?? 0) >= 0,
      isFund: t?.isFund ?? s.market === 'fund',
      isLof: !!lofTick,
      target: s.alertAbove ?? s.alertBelow,
      hasPosition: !!(s.cost && s.shares),
    };
  });
}

function updateUI(cfg: Config, ticks: Record<string, Tick>) {
  cfg.symbols.forEach((s, idx) => {
    const item = items[idx];
    if (!item) {
      return;
    }
    // 休市隐藏：该标的所属市场未开盘则从状态栏隐藏（侧边栏仍可查看）
    if (cfg.hideStatusBarWhenClosed && !isMarketOpen(s.market)) {
      item.hide();
      return;
    }
    item.show();
    const lofTick = s.lof && s.lofCode ? ticks[s.lofCode] : undefined;
    const t = lofTick ?? ticks[s.code];
    const name =
      s.alias || t?.name || ticks[s.code]?.name || s.code.replace(/^(sh|sz|bj|hk|us)/, '');
    if (!t) {
      if (!item.text) {
        item.text = `${name} —`;
      }
      item.tooltip = '行情获取失败 / 暂无数据（点击看历史，或稍后重试）';
      return;
    }
    const up = t.changePct >= 0;
    const arrow = up ? '▲' : '▼';
    const approx = t.isFund && !lofTick ? '≈' : '';
    item.text = `${name} ${approx}${t.priceStr} ${arrow}${Math.abs(t.changePct)}%`;
    item.color = up ? cfg.riseColor : cfg.fallColor;
    item.tooltip = buildTooltip(s, ticks);
  });
}

function buildTooltip(s: SymbolItem, ticks: Record<string, Tick>): string {
  const lofTick = s.lof && s.lofCode ? ticks[s.lofCode] : undefined;
  const fundTick = ticks[s.code];
  const t = lofTick ?? fundTick;
  if (!t) {
    return s.alias || s.code;
  }
  const lines: string[] = [];
  const nm = s.alias || t.name || s.code;
  lines.push(`${nm} (${s.code})${s.lof ? ' · LOF' : t.isFund ? ' · 场外基金' : ''}`);

  const sg = (v: number) => (v >= 0 ? '+' : '');
  if (lofTick) {
    lines.push(`场内实时 ${lofTick.priceStr}  ${sg(lofTick.change)}${lofTick.change} (${sg(lofTick.changePct)}${lofTick.changePct}%)`);
    if (fundTick) {
      lines.push(`场外估值 ${fundTick.priceStr}  (${sg(fundTick.changePct)}${fundTick.changePct}%)`);
    }
  } else if (t.isFund) {
    lines.push(`估算净值 ${t.priceStr}  (${sg(t.changePct)}${t.changePct}%)`);
    lines.push(`昨日净值 ${t.prevClose}`);
  } else {
    lines.push(`现价 ${t.priceStr}  ${sg(t.change)}${t.change} (${sg(t.changePct)}${t.changePct}%)`);
    lines.push(`今开 ${t.open}  昨收 ${t.prevClose}`);
    lines.push(`最高 ${t.high}  最低 ${t.low}`);
  }

  if (s.cost && s.shares) {
    const profit = (t.price - s.cost) * s.shares;
    const pPct = s.cost ? ((t.price - s.cost) / s.cost) * 100 : 0;
    const ps = profit >= 0 ? '+' : '';
    lines.push(`—— 持仓 ${s.shares} @ ${s.cost} ——`);
    lines.push(`浮动盈亏 ${ps}${profit.toFixed(2)} (${ps}${pPct.toFixed(2)}%)`);
  }

  const al: string[] = [];
  if (s.alertAbove != null) {
    al.push(`≥${s.alertAbove}`);
  }
  if (s.alertBelow != null) {
    al.push(`≤${s.alertBelow}`);
  }
  if (s.alertPct != null) {
    al.push(`|涨跌|≥${s.alertPct}%`);
  }
  if (al.length) {
    lines.push(`提醒 ${al.join('  ')}`);
  }

  lines.push(`更新 ${t.time}  ·  点击看历史`);
  return lines.join('\n');
}

function updateTotal(cfg: Config, ticks: Record<string, Tick>) {
  if (!totalItem) {
    return;
  }
  let cost = 0;
  let value = 0;
  let has = false;
  for (const s of cfg.symbols) {
    if (s.cost && s.shares) {
      const t = primaryTick(s, ticks);
      if (!t) {
        continue;
      }
      has = true;
      cost += s.cost * s.shares;
      value += t.price * s.shares;
    }
  }
  if (!has) {
    totalItem.hide();
    return;
  }
  // 休市隐藏：所有持仓标的市场都未开盘则隐藏总盈亏（侧边栏仍可查看）
  if (
    cfg.hideStatusBarWhenClosed &&
    !cfg.symbols.some((s) => s.cost && s.shares && isMarketOpen(s.market))
  ) {
    totalItem.hide();
    return;
  }
  const profit = value - cost;
  const pct = cost ? (profit / cost) * 100 : 0;
  const up = profit >= 0;
  const sign = up ? '+' : '';
  totalItem.text = `$(graph) 总盈亏 ${sign}${profit.toFixed(0)} (${sign}${pct.toFixed(2)}%)`;
  totalItem.color = up ? cfg.riseColor : cfg.fallColor;
  totalItem.tooltip =
    `持仓总成本 ${cost.toFixed(2)}\n当前市值 ${value.toFixed(2)}\n` +
    `浮动盈亏 ${sign}${profit.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
  totalItem.show();
}

function checkAlerts(cfg: Config, ticks: Record<string, Tick>) {
  for (const s of cfg.symbols) {
    const t = primaryTick(s, ticks);
    if (!t) {
      continue;
    }
    const fired = alertState[s.code] ?? (alertState[s.code] = new Set<string>());
    const nm = s.alias || t.name || s.code;
    const fire = (key: string, cond: boolean, msg: string) => {
      if (cond) {
        if (!fired.has(key)) {
          fired.add(key);
          void vscode.window.showWarningMessage(msg);
        }
      } else {
        fired.delete(key);
      }
    };
    fire('above', s.alertAbove != null && t.price >= s.alertAbove, `📈 ${nm} 现价 ${t.priceStr} 已 ≥ ${s.alertAbove}`);
    fire('below', s.alertBelow != null && t.price <= s.alertBelow, `📉 ${nm} 现价 ${t.priceStr} 已 ≤ ${s.alertBelow}`);
    fire('pct', s.alertPct != null && Math.abs(t.changePct) >= s.alertPct, `⚡ ${nm} 涨跌幅 ${t.changePct}% 已达 ±${s.alertPct}%`);
  }
}

// ---------- 命令：增删 / 排序 / 目标价 / 历史 ----------

async function addSymbol() {
  const kw = await vscode.window.showInputBox({
    title: '添加自选',
    prompt: '输入名称或代码（如：茅台、600519、纳指、腾讯）',
    ignoreFocusOut: true,
  });
  if (!kw || !kw.trim()) {
    return;
  }
  let hits;
  try {
    hits = await searchStock(kw.trim());
  } catch {
    void vscode.window.showErrorMessage('搜索失败，请检查网络');
    return;
  }
  if (!hits.length) {
    void vscode.window.showInformationMessage('没有搜到匹配的标的');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    hits.map((h) => ({
      label: `${flagOf(h.code)} ${h.name}`,
      description: `${h.code}　${h.type}`,
      hit: h,
    })),
    { title: '选择要添加的标的', ignoreFocusOut: true }
  );
  if (!pick) {
    return;
  }
  const raw = getRawSymbols();
  if (raw.some((r) => parseSymbol(r)?.code === pick.hit.code)) {
    void vscode.window.showInformationMessage(`${pick.hit.name} 已在自选中`);
    return;
  }
  await writeSymbols([...raw, `${pick.hit.code}:${pick.hit.name}`]);
  void vscode.window.showInformationMessage(`已添加 ${pick.hit.name} (${pick.hit.code})`);
}

async function removeSymbol() {
  const cfg = getConfig();
  if (!cfg.symbols.length) {
    void vscode.window.showInformationMessage('自选为空');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    cfg.symbols.map((s) => ({ label: s.alias || s.code, description: s.code, code: s.code })),
    { title: '选择要删除的自选（可多选）', ignoreFocusOut: true, canPickMany: true }
  );
  if (!picks || !picks.length) {
    return;
  }
  const removeCodes = new Set(picks.map((p) => p.code));
  const raw = getRawSymbols().filter((r) => {
    const s = parseSymbol(r);
    return s ? !removeCodes.has(s.code) : true;
  });
  await writeSymbols(raw);
  void vscode.window.showInformationMessage(`已删除 ${picks.length} 项`);
}

/** 删除单项（侧边栏 × 回调） */
async function removeOne(code: string) {
  if (!code) {
    return;
  }
  const raw = getRawSymbols().filter((r) => parseSymbol(r)?.code !== code);
  await writeSymbols(raw);
}

/** 拖拽重排：把 fromCode 移动到 toCode 之前（toCode 为空 -> 末尾） */
async function reorderSymbols(fromCode: string, toCode?: string) {
  const raw = getRawSymbols();
  const idxFrom = raw.findIndex((r) => parseSymbol(r)?.code === fromCode);
  if (idxFrom < 0) {
    return;
  }
  const [moved] = raw.splice(idxFrom, 1);
  if (toCode === undefined) {
    raw.push(moved);
  } else {
    let idxTo = raw.findIndex((r) => parseSymbol(r)?.code === toCode);
    if (idxTo < 0) {
      idxTo = raw.length;
    }
    raw.splice(idxTo, 0, moved);
  }
  await writeSymbols(raw);
}

/** 侧边栏快捷设目标价：按当前价自动判断「涨到 / 跌到」，写入 alertAbove / alertBelow */
async function setTargetPrice(code: string, price: number) {
  if (!code || isNaN(price)) {
    return;
  }
  const raw = getRawSymbols();
  const idx = raw.findIndex((r) => parseSymbol(r)?.code === code);
  if (idx < 0) {
    return;
  }
  const parsed = parseSymbol(raw[idx]);
  if (!parsed) {
    return;
  }
  const cur =
    (parsed.lof && parsed.lofCode ? lastTicks[parsed.lofCode] : undefined)?.price ??
    lastTicks[code]?.price;
  const obj: Record<string, unknown> =
    typeof raw[idx] === 'string'
      ? { code: parsed.code, ...(parsed.alias ? { alias: parsed.alias } : {}) }
      : { ...(raw[idx] as Record<string, unknown>) };
  const below = cur != null && price < cur;
  if (below) {
    obj.alertBelow = price;
    delete obj.alertAbove;
  } else {
    obj.alertAbove = price;
    delete obj.alertBelow;
  }
  raw[idx] = obj;
  await writeSymbols(raw);
  void vscode.window.showInformationMessage(
    `已设 ${parsed.alias || code} 目标价 ${price}（${below ? '跌到' : '涨到'}提醒）`
  );
}

/** 清除目标价提醒 */
async function clearTarget(code: string) {
  const raw = getRawSymbols();
  const idx = raw.findIndex((r) => parseSymbol(r)?.code === code);
  if (idx < 0) {
    return;
  }
  const item = raw[idx];
  if (item && typeof item === 'object') {
    const o = { ...(item as Record<string, unknown>) };
    delete o.alertAbove;
    delete o.alertBelow;
    raw[idx] = o;
    await writeSymbols(raw);
    void vscode.window.showInformationMessage('已取消目标价提醒');
  }
}

function flagOf(code: string): string {
  const mk = detectMarket(code);
  return mk === 'hk' ? '🇭🇰' : mk === 'us' ? '🇺🇸' : mk === 'fund' ? '💰' : '🇨🇳';
}

async function showHistory(code?: string) {
  const cfg = getConfig();
  if (code) {
    const target =
      cfg.symbols.find((s) => s.code === code) ??
      ({ code: code.toLowerCase(), market: detectMarket(code.toLowerCase()) } as SymbolItem);
    await openHistory(target, cfg);
    return;
  }
  const target = await pickSymbolForHistory(cfg);
  if (target) {
    await openHistory(target, cfg);
  }
}

interface HistoryPick extends vscode.QuickPickItem {
  target: SymbolItem;
}

/** 历史选择器：默认列出自选，输入关键词则实时搜索任意标的（不必先加自选） */
function pickSymbolForHistory(cfg: Config): Promise<SymbolItem | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<HistoryPick>();
    qp.title = '查看历史价格';
    qp.placeholder = '输入名称 / 代码搜索任意标的，或从下方自选中选择';
    const base: HistoryPick[] = cfg.symbols.map((s) => ({
      label: `${flagOf(s.code)} ${s.alias || s.code}`,
      description: s.code,
      target: s,
    }));
    qp.items = base;

    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    qp.onDidChangeValue((value) => {
      if (searchTimer) {
        clearTimeout(searchTimer);
      }
      const v = value.trim();
      if (!v) {
        qp.busy = false;
        qp.items = base;
        return;
      }
      qp.busy = true;
      const mySeq = ++seq;
      searchTimer = setTimeout(async () => {
        try {
          const hits = await searchStock(v);
          if (mySeq !== seq) {
            return;
          }
          qp.items = hits.map((h) => {
            const c = h.code.toLowerCase();
            return {
              label: `${flagOf(c)} ${h.name}`,
              description: `${h.code}　${h.type}`,
              target: { code: c, alias: h.name, market: detectMarket(c) } as SymbolItem,
            };
          });
        } catch {
          if (mySeq === seq) {
            qp.items = [];
          }
        } finally {
          if (mySeq === seq) {
            qp.busy = false;
          }
        }
      }, 300);
    });

    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      qp.hide();
      resolve(sel?.target);
    });
    qp.onDidHide(() => {
      if (searchTimer) {
        clearTimeout(searchTimer);
      }
      qp.dispose();
      resolve(undefined);
    });
    qp.show();
  });
}

async function openHistory(target: SymbolItem, cfg: Config) {
  // LOF 看场内 K 线；普通基金看净值历史；A 股看 K 线；港美股暂不支持
  const useLofKline = target.lof && target.lofCode;
  if (!useLofKline && (target.market === 'hk' || target.market === 'us')) {
    void vscode.window.showInformationMessage(
      '历史价格支持 A 股 / 场内 ETF / 指数 / 场外基金；港股、美股暂不支持'
    );
    return;
  }
  try {
    const isFundNav = target.market === 'fund' && !useLofKline;
    const kl = isFundNav
      ? await fetchFundHistory(target.code, 30)
      : await fetchHistory(useLofKline ? target.lofCode! : target.code, 60);
    if (!kl.length) {
      void vscode.window.showInformationMessage('暂无历史数据');
      return;
    }
    showHistoryWebview(target.code, target.alias || target.code, kl, cfg.riseColor, cfg.fallColor, isFundNav);
  } catch {
    void vscode.window.showErrorMessage('获取历史数据失败');
  }
}
