import * as vscode from 'vscode';
import { Kline } from './providers';

/** 按标的 key 复用 Webview 面板，避免重复点开同一标的堆积多个面板 */
const panels = new Map<string, vscode.WebviewPanel>();

/** 在 Webview 中展示历史走势（零依赖手绘 SVG）+ 明细表。isFund 时按净值口径渲染。 */
export function showHistoryWebview(
  key: string,
  title: string,
  klines: Kline[],
  riseColor: string,
  fallColor: string,
  isFund = false
): void {
  const heading = `历史${isFund ? '净值' : '价格'} · ${title}`;
  const html = renderHtml(title, klines, riseColor, fallColor, isFund);

  const existing = panels.get(key);
  if (existing) {
    existing.title = heading;
    existing.webview.html = html;
    existing.reveal(vscode.ViewColumn.Active);
    return;
  }

  const panel = vscode.window.createWebviewPanel('stockWatcherHistory', heading, vscode.ViewColumn.Active, {
    enableScripts: false,
  });
  panel.webview.html = html;
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(
  title: string,
  klines: Kline[],
  rise: string,
  fall: string,
  isFund: boolean
): string {
  if (!klines.length) {
    return `<!DOCTYPE html><html><body style="padding:20px;font-family:sans-serif">暂无历史数据</body></html>`;
  }

  const closes = klines.map((k) => k.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const n = closes.length;

  const W = 760;
  const H = 260;
  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const xAt = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, n - 1);
  const yAt = (v: number) => H - padB - ((v - min) * (H - padT - padB)) / span;
  const points = closes.map((c, i) => `${xAt(i).toFixed(1)},${yAt(c).toFixed(1)}`).join(' ');
  const up = closes[n - 1] >= closes[0];
  const lineColor = up ? rise : fall;

  const first = klines[0];
  const last = klines[n - 1];
  const totalPct = first.close ? ((last.close - first.close) / first.close) * 100 : 0;
  const totalSign = totalPct >= 0 ? '+' : '';

  // y 轴：5 档价格刻度 + 水平网格线
  const Y = 4;
  let grid = '';
  for (let i = 0; i <= Y; i++) {
    const v = min + (span * i) / Y;
    const y = yAt(v);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--vscode-panel-border)" stroke-width="0.5" opacity="0.45"/>`;
    grid += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--vscode-foreground)" opacity="0.55">${v.toFixed(3)}</text>`;
  }

  // x 轴：最多 6 个日期标签
  const X = Math.min(6, n);
  let xlab = '';
  for (let i = 0; i < X; i++) {
    const idx = X === 1 ? 0 : Math.round((i * (n - 1)) / (X - 1));
    const x = xAt(idx);
    const anchor = i === 0 ? 'start' : i === X - 1 ? 'end' : 'middle';
    xlab += `<text x="${x.toFixed(1)}" y="${H - 10}" text-anchor="${anchor}" font-size="9" fill="var(--vscode-foreground)" opacity="0.55">${esc(klines[idx].day.slice(5))}</text>`;
  }

  let head: string;
  let rows: string;
  if (isFund) {
    head = `<tr><th>日期</th><th>单位净值</th><th>日增长</th></tr>`;
    const desc = klines.slice().reverse();
    rows = desc
      .map((k, i) => {
        const prev = desc[i + 1];
        const pct = prev && prev.close ? ((k.close - prev.close) / prev.close) * 100 : 0;
        const color = pct >= 0 ? rise : fall;
        const ps = pct >= 0 ? '+' : '';
        return `<tr><td>${esc(k.day)}</td><td>${k.close}</td><td style="color:${color}">${ps}${pct.toFixed(2)}%</td></tr>`;
      })
      .join('');
  } else {
    head = `<tr><th>日期</th><th>开</th><th>高</th><th>低</th><th>收</th><th>成交量</th></tr>`;
    rows = klines
      .slice()
      .reverse()
      .map((k) => {
        const color = k.close >= k.open ? rise : fall;
        return (
          `<tr><td>${esc(k.day)}</td>` +
          `<td>${k.open}</td><td>${k.high}</td><td>${k.low}</td>` +
          `<td style="color:${color};font-weight:600">${k.close}</td>` +
          `<td>${Math.round(k.volume / 100)}手</td></tr>`
        );
      })
      .join('');
  }

  const label = isFund ? '净值' : '收盘价';
  const source = isFund ? '天天基金' : '新浪财经';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family,sans-serif);padding:16px;color:var(--vscode-foreground)}
    h2{margin:0 0 4px}
    .sub{opacity:.7;font-size:12px;margin-bottom:12px}
    .pct{font-weight:600;color:${lineColor}}
    svg{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px}
    table{border-collapse:collapse;width:100%;margin-top:16px;font-size:13px}
    th,td{padding:6px 10px;text-align:right;border-bottom:1px solid var(--vscode-panel-border)}
    th{opacity:.7;font-weight:500}
    td:first-child,th:first-child{text-align:left}
  </style></head><body>
    <h2>${esc(title)}</h2>
    <div class="sub">近 ${n} 个交易日${label}走势　区间 <span class="pct">${totalSign}${totalPct.toFixed(2)}%</span>　数据：${source}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%">
      ${grid}
      <polyline fill="none" stroke="${lineColor}" stroke-width="1.8" points="${points}"/>
      ${xlab}
    </svg>
    <table>${head}${rows}</table>
  </body></html>`;
}
