/** Static screenshot composition over the fixture's real app.html/ChatPanel. Not product code. */
export function renderMock({ scene }) {
  const shell = document.querySelector('.shell').cloneNode(true);
  document.querySelector('.shell').replaceWith(shell);
  const main = shell.querySelector('main');
  const template = main.querySelector('.p-chat').cloneNode(true);
  const icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const rows = [...shell.querySelectorAll('a.inst')].filter(e => e.querySelector('.inst-name'));
  const names = ['General', '提案助理', '審查助理', '文件助理'];
  for (const [i, row] of rows.entries()) {
    const name = names[i] || '文件助理';
    row.querySelector('.inst-name').textContent = name;
    if (row.querySelector('.inst-alt')) row.querySelector('.inst-alt').textContent = ['general', 'proposal', 'review', 'notes'][i] || 'notes';
    if (row.querySelector('.av-text')) row.querySelector('.av-text').textContent = ['G', '提', '審', '文'][i] || '文';
    row.title = name;
    row.classList.toggle('active', i === (scene === 'right' || scene === 'float' ? 2 : 1));
    row.classList.remove('replied', 'just');
    const li = row.closest('li');
    li.querySelector('.inst-star')?.remove();
    li.querySelector('.inst-gear')?.remove();
    const more = document.createElement('button');
    more.className = 'icon-btn mock-sidebar-more' + (scene === 'sidebar' && i === 2 ? ' is-on' : '');
    more.textContent = '⋯'; more.setAttribute('aria-label', name + '的更多操作');
    li.append(more);
  }
  const single = ['sidebar', 'header'].includes(scene);
  const workspace = document.createElement('div'); workspace.className = 'mock-workspace' + (single ? ' mock-opening' : '');
  const toolbar = document.createElement('div'); toolbar.className = 'mock-toolbar';
  const heading = document.createElement('strong'); heading.textContent = scene === 'sidebar' || scene === 'header' ? '提案助理' : '桌面雙對話'; toolbar.append(heading);
  const badge = document.createElement('span'); badge.className = 'mock-badge'; badge.textContent = '設計稿・僅示意'; toolbar.append(badge);
  const grow = document.createElement('span'); grow.className = 'mock-grow'; toolbar.append(grow);
  if (!['sidebar', 'header'].includes(scene)) {
    const seg = document.createElement('div'); seg.className = 'seg';
    for (const [value, label] of [['right', '左右'], ['stack', '上下'], ['float', '浮窗']]) {
      const b = document.createElement('button'); b.textContent = label;
      b.className = value === scene || scene === 'snap' && value === 'right' ? 'is-on' : '';
      seg.append(b);
    }
    toolbar.append(seg);
    const swap = document.createElement('button'); swap.className = 'btn btn-sm'; swap.textContent = '交換位置'; toolbar.append(swap);
  }
  const open = document.createElement('button'); open.className = 'btn btn-sm'; open.textContent = '另開對話 ▾'; toolbar.append(open);
  if (!single) workspace.append(toolbar);
  const area = document.createElement('div'); area.className = 'mock-area layout-' + (scene === 'stack' ? 'stack' : 'right'); workspace.append(area);
  const makePane = (which, focused) => {
    const panel = template.cloneNode(true); panel.className = 'panel p-chat mock-pane' + (focused ? ' is-focused' : '');
    panel.setAttribute('data-mock-pane', which);
    const name = which === 'a' ? '提案助理' : '審查助理';
    const head = panel.querySelector('.panel-head'); head.replaceChildren();
    const grip = document.createElement('span'); grip.className = 'mock-grip'; grip.textContent = '⠿'; grip.setAttribute('aria-label', '拖曳窗格標頭');
    const title = document.createElement('div'); title.className = 'panel-title';
    const h = document.createElement('h2'); h.textContent = name;
    if (focused) { const f = document.createElement('span'); f.className = 'mock-focus'; f.textContent = '目前窗格'; h.append(f); }
    const sub = document.createElement('div'); sub.className = 'panel-sub';
    const dot = document.createElement('span'); dot.className = 'status'; dot.innerHTML = '<span class="dot ok"></span>'; dot.append('閒置'); sub.append(dot);
    title.append(h, sub); head.append(grip, title);
    const more = document.createElement('button'); more.className = 'icon-btn'; more.textContent = '⋯'; more.setAttribute('aria-label', name + '的更多操作');
    const close = document.createElement('button'); close.className = 'icon-btn'; close.innerHTML = icon; close.setAttribute('aria-label', '收起' + name);
    head.append(more, close);
    for (const child of [...panel.children]) if (child !== head && !child.classList.contains('chat-split')) child.remove();
    const messages = [...panel.querySelectorAll('.msg')];
    const user = messages.find(m => m.classList.contains('user'));
    const agent = messages.find(m => m.classList.contains('agent'));
    for (const m of messages) if (m !== user && m !== agent) m.remove();
    user.querySelector('.body .md').replaceChildren();
    const q = document.createElement('p'); q.textContent = which === 'a' ? '請整理桌面雙對話的提案，讓我能一邊比較、一邊工作。' : '請檢查提案，找出可以簡化的地方。'; user.querySelector('.body .md').append(q);
    user.querySelector('.sender').textContent = '你';
    agent.querySelector('.sender').textContent = name;
    const body = agent.querySelector('.body .md'); body.replaceChildren();
    const p = document.createElement('p'); p.textContent = which === 'a' ? '建議預設左右並排，每個對話都有自己的輸入框，草稿與捲動位置互不影響。' : '可以先限制兩個不同的對話。一般點側欄只切換目前窗格，避免不小心換掉另一邊。'; body.append(p);
    const list = document.createElement('ul');
    for (const text of which === 'a' ? ['左右並排：比較與複製最直接。', '上下排列：適合較長的程式碼。', '右下浮窗：保留主要對話的空間。'] : ['焦點以框線和文字一起標示。', '引用到另一窗格後，仍由人按送出。', '收起窗格不會停止 Agent。']) {
      const li = document.createElement('li'); li.textContent = text; list.append(li);
    }
    body.append(list);
    const end = document.createElement('p'); end.textContent = which === 'a' ? '拖曳標頭可改變排列；分隔線可以調整比例。' : '手機維持單一對話，兩個選擇用頁籤切換。'; body.append(end);
    if (scene === 'right' && which === 'a') {
      p.className = 'mock-quote-select';
      const action = document.createElement('div'); action.className = 'mock-quote-menu'; action.textContent = '引用到另一窗格：審查助理 ↗'; p.after(action);
    }
    panel.querySelectorAll('.msg .time').forEach((e, i) => e.textContent = i === 0 ? '14:30' : '14:31');
    const textarea = panel.querySelector('textarea');
    textarea.value = scene === 'right' && which === 'b' ? '> 提案助理：每個對話都有自己的輸入框。\n請幫我確認這個做法。' : which === 'a' ? '把這份提案整理成三個重點…' : '請補充關閉窗格時的行為…';
    if (scene === 'right' && which === 'b') { textarea.style.height = '66px'; textarea.style.minHeight = '66px'; }
    textarea.setAttribute('aria-label', '傳訊息給' + name);
    panel.querySelectorAll('.model-entry-row .btn').forEach((b, i) => { b.textContent = i === 0 ? 'Claude Code ▾' : '預設模型 ▾'; });
    const send = panel.querySelector('.btn-send'); send.disabled = false;
    if (single) {
      const original = template.querySelector('.panel-head').cloneNode(true);
      original.querySelector('h1').textContent = name;
      original.querySelector('.panel-actions').prepend(badge.cloneNode(true), open.cloneNode(true));
      head.replaceWith(original); panel.classList.remove('is-focused');
    }
    panel.querySelectorAll('[id]').forEach((e, i) => { e.id = 'mock-' + which + '-' + i; });
    panel.querySelectorAll('[aria-controls], [aria-labelledby], [for]').forEach(e => { e.removeAttribute('aria-controls'); e.removeAttribute('aria-labelledby'); e.removeAttribute('for'); });
    return panel;
  };
  const a = makePane('a', scene !== 'right' && scene !== 'float'); area.append(a);
  if (!['sidebar', 'header'].includes(scene)) {
    if (scene !== 'float') { const sep = document.createElement('div'); sep.className = 'mock-separator'; sep.setAttribute('role', 'separator'); area.append(sep); }
    const b = makePane('b', scene === 'right' || scene === 'float');
    if (scene === 'float') { b.classList.add('mock-float'); const resize = document.createElement('span'); resize.className = 'mock-resize'; resize.textContent = '◢'; b.append(resize); }
    area.append(b);
  }
  main.replaceChildren(workspace);
  if (scene === 'sidebar') {
    const menu = document.createElement('div'); menu.className = 'mock-popup mock-sidebar-popup';
    const title = document.createElement('div'); title.className = 'mock-popup-title'; title.textContent = '審查助理'; menu.append(title);
    for (const [i, label] of ['開啟對話', '在另一窗格開啟'].entries()) { const b = document.createElement('button'); b.textContent = (i ? '◫  ' : '↗  ') + label; if (i) b.className = 'is-highlight'; menu.append(b); }
    shell.append(menu);
    const anchor = shell.querySelectorAll('.mock-sidebar-more')[2].getBoundingClientRect();
    menu.style.left = (anchor.right - 20) + 'px'; menu.style.top = (anchor.bottom + 4) + 'px';
    const hint = document.createElement('div'); hint.className = 'mock-instruction'; hint.textContent = '從 Agent 的「⋯」開啟第二個對話；預設左右並排。'; area.append(hint);
  }
  if (scene === 'header') {
    const menu = document.createElement('div'); menu.className = 'mock-popup mock-header-popup';
    const title = document.createElement('div'); title.className = 'mock-popup-title'; title.textContent = '在另一窗格開啟'; menu.append(title);
    const input = document.createElement('input'); input.className = 'input mock-search'; input.placeholder = '搜尋 Agent…'; menu.append(input);
    for (const [i, label] of ['審查助理', '文件助理'].entries()) { const b = document.createElement('button'); b.textContent = label; if (!i) b.className = 'is-highlight'; menu.append(b); }
    workspace.append(menu);
  }
  if (scene === 'snap') {
    const shade = document.createElement('div'); shade.className = 'mock-drag-shade';
    const preview = document.createElement('div'); preview.className = 'mock-drop-preview'; shade.append(preview);
    for (const [pos, label] of [['left','◧  左側'],['right','◨  右側'],['top','⬒  上方'],['bottom','⬓  下方'],['floating','▣  右下浮窗']]) {
      const t = document.createElement('div'); t.className = 'mock-drop-target ' + pos + (pos === 'right' ? ' is-active' : ''); t.textContent = label; shade.append(t);
    }
    const ghost = document.createElement('div'); ghost.className = 'mock-drag-ghost'; ghost.textContent = '⠿  審查助理   ↗'; shade.append(ghost);
    const hint = document.createElement('div'); hint.className = 'mock-drop-hint'; hint.textContent = '放開以停靠右側 · Esc 取消'; shade.append(hint); area.append(shade);
  }
  document.title = '桌面雙對話 · 設計提案';
}
