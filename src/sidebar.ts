import * as vscode from 'vscode';

/** 侧边栏一行的展示数据 */
export interface SidebarRow {
  code: string;
  name: string;
  priceStr: string;
  changePct: number;
  up: boolean;
  isFund: boolean;
  isLof: boolean;
  target?: number; // 已设的目标价（alertAbove 或 alertBelow）
  hasPosition: boolean;
}

export interface SidebarCallbacks {
  onHistory: (code: string) => void;
  onSetTarget: (code: string, price: number) => void;
  onClearTarget: (code: string) => void;
  onRemove: (code: string) => void;
  onReorder: (fromCode: string, toCode?: string) => void;
  onAdd: () => void;
  onRefresh: () => void;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

/** 活动栏「盯盘」侧边栏：自选实时价 + 目标价快捷设置 + 看历史 + 拖拽排序 + 删除 */
export class StockSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private rows: SidebarRow[] = [];
  private rise = '#f5222d';
  private fall = '#52c41a';

  constructor(private readonly cb: SidebarCallbacks) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: Record<string, unknown>) => {
      const code = String(m.code ?? '');
      switch (m.type) {
        case 'ready':
          // webview 脚本就绪后主动握手，此时再推数据才不会丢（修复首次空白）
          this.post();
          if (!this.rows.length) {
            this.cb.onRefresh();
          }
          break;
        case 'history':
          this.cb.onHistory(code);
          break;
        case 'setTarget':
          this.cb.onSetTarget(code, Number(m.price));
          break;
        case 'clearTarget':
          this.cb.onClearTarget(code);
          break;
        case 'remove':
          this.cb.onRemove(code);
          break;
        case 'reorder':
          this.cb.onReorder(String(m.fromCode ?? ''), m.toCode ? String(m.toCode) : undefined);
          break;
        case 'add':
          this.cb.onAdd();
          break;
        case 'refresh':
          this.cb.onRefresh();
          break;
      }
    });
    this.post();
  }

  update(rows: SidebarRow[], rise: string, fall: string): void {
    this.rows = rows;
    this.rise = rise;
    this.fall = fall;
    this.post();
  }

  private post(): void {
    this.view?.webview.postMessage({ type: 'update', rows: this.rows, rise: this.rise, fall: this.fall });
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; }
  .bar { display: flex; gap: 6px; padding: 6px 8px; position: sticky; top: 0; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .bar button { flex: 1; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: 4px; font-size: 12px; }
  .bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .row { display: flex; align-items: center; gap: 4px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.dragover { border-top: 2px solid var(--vscode-focusBorder); }
  .grip { cursor: grab; opacity: .35; font-size: 11px; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .price { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .target { width: 56px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 2px 4px; font-size: 11px; }
  .target.set { border-color: var(--vscode-focusBorder); }
  .del { cursor: pointer; opacity: .4; padding: 0 2px; }
  .del:hover { opacity: 1; color: var(--vscode-errorForeground); }
  .empty { padding: 16px; opacity: .6; text-align: center; }
  .hint { padding: 4px 8px; opacity: .5; font-size: 10px; }
</style></head><body>
  <div class="bar">
    <button id="add">➕ 添加自选</button>
    <button id="refresh">🔄 刷新</button>
  </div>
  <div id="list"></div>
  <div class="hint">点名称看历史 · 目标价输入后回车 · 拖动 ⋮⋮ 排序</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  let dragFrom = null;
  function esc(s){ const d=document.createElement('div'); d.textContent=s==null?'':String(s); return d.innerHTML; }
  function render(rows, rise, fall){
    const list = document.getElementById('list');
    list.innerHTML = '';
    if(!rows.length){ list.innerHTML = '<div class="empty">暂无自选，点上方「添加自选」</div>'; return; }
    for(const r of rows){
      const row = document.createElement('div');
      row.className = 'row';
      row.draggable = true;
      row.dataset.code = r.code;
      const color = r.up ? rise : fall;
      const arrow = r.up ? '▲' : '▼';
      const approx = (r.isFund && !r.isLof) ? '≈' : '';
      const priceTxt = (r.priceStr === '—') ? '—' : (approx + r.priceStr + ' ' + arrow + Math.abs(r.changePct) + '%');
      row.innerHTML =
        '<span class="grip">⋮⋮</span>' +
        '<span class="name" title="点击看历史">' + esc(r.name) + '</span>' +
        '<span class="price" style="color:' + color + '">' + priceTxt + '</span>' +
        '<input class="target' + (r.target!=null?' set':'') + '" type="number" step="any" placeholder="目标价"' +
          ' value="' + (r.target!=null?r.target:'') + '" title="输入目标价后回车设置提醒；清空回车取消"/>' +
        '<span class="del" title="删除">×</span>';
      row.querySelector('.name').onclick = () => vscode.postMessage({type:'history', code:r.code});
      row.querySelector('.del').onclick = (e) => { e.stopPropagation(); vscode.postMessage({type:'remove', code:r.code}); };
      const inp = row.querySelector('.target');
      inp.onclick = (e) => e.stopPropagation();
      inp.onkeydown = (e) => {
        if(e.key === 'Enter'){
          const v = inp.value.trim();
          if(v === '') vscode.postMessage({type:'clearTarget', code:r.code});
          else { const p = parseFloat(v); if(!isNaN(p)) vscode.postMessage({type:'setTarget', code:r.code, price:p}); }
          inp.blur();
        }
      };
      row.ondragstart = () => { dragFrom = r.code; };
      row.ondragover = (e) => { e.preventDefault(); row.classList.add('dragover'); };
      row.ondragleave = () => row.classList.remove('dragover');
      row.ondrop = (e) => {
        e.preventDefault(); row.classList.remove('dragover');
        if(dragFrom && dragFrom !== r.code) vscode.postMessage({type:'reorder', fromCode:dragFrom, toCode:r.code});
        dragFrom = null;
      };
      list.appendChild(row);
    }
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if(m && m.type === 'update') render(m.rows, m.rise, m.fall);
  });
  document.getElementById('add').onclick = () => vscode.postMessage({type:'add'});
  document.getElementById('refresh').onclick = () => vscode.postMessage({type:'refresh'});
  vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}
