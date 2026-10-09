/**
 * DOM 工具（§8.7 性能要求）。
 *
 * ★ 上一版 C3 的根因是"每帧 querySelector + 重复写样式 → 回流卡顿"。
 *   本文件把"缓存子元素 + 写入前比较旧值"变成默认用法：
 *   所有 setter 都做**变更检测**，值没变就不碰 DOM。
 */

const lastText = new WeakMap<Element, string>();
const lastWidth = new WeakMap<Element, number>();
const lastClass = new WeakMap<Element, Set<string>>();
const lastStyle = new WeakMap<Element, Map<string, string>>();

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setText(node: Element, text: string): void {
  if (lastText.get(node) === text) return;
  lastText.set(node, text);
  node.textContent = text;
}

export function setWidth(node: HTMLElement, px: number): void {
  const v = Math.round(px * 100) / 100;
  if (lastWidth.get(node) === v) return;
  lastWidth.set(node, v);
  node.style.width = `${v}px`;
}

export function setClass(node: Element, token: string, on: boolean): void {
  let set = lastClass.get(node);
  if (!set) {
    set = new Set(node.classList);
    lastClass.set(node, set);
  }
  const has = set.has(token);
  if (has === on) return;
  if (on) set.add(token);
  else set.delete(token);
  node.classList.toggle(token, on);
}

export function setStyle(node: HTMLElement, prop: string, value: string): void {
  let map = lastStyle.get(node);
  if (!map) {
    map = new Map();
    lastStyle.set(node, map);
  }
  if (map.get(prop) === value) return;
  map.set(prop, value);
  node.style.setProperty(prop, value);
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ---------------------------------------------------------------- 上下文菜单 */

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  run?: () => void;
  separator?: boolean;
  /** 子菜单：鼠标悬停时在右侧展开（例如「跃迁至」→ 0/10/20/…km 距离选项）。 */
  submenu?: MenuItem[];
}

let menuNode: HTMLElement | null = null;

/** 关闭上下文菜单（含所有已展开的子菜单）。 */
export function hideContextMenu(): void {
  for (const m of Array.from(document.querySelectorAll(".ctx-menu"))) m.remove();
  menuNode = null;
}

export function showContextMenu(x: number, y: number, title: string, items: MenuItem[]): void {
  hideContextMenu();
  const root = el("div", "ctx-menu");
  const head = el("div", "ctx-title", title);
  root.appendChild(head);

  /** 递归渲染菜单项（子菜单复用同一渲染逻辑）。 */
  function fillMenu(node: HTMLElement, list: MenuItem[]): void {
    for (const it of list) {
      if (it.separator) {
        node.appendChild(el("div", "ctx-sep"));
        continue;
      }
      const row = el("div", "ctx-item" + (it.disabled ? " disabled" : ""));
      row.appendChild(el("span", "ctx-label", it.label));
      if (it.hint) row.appendChild(el("span", "ctx-hint", it.hint));
      const hasSub = !it.disabled && !!it.submenu && it.submenu.length > 0;
      if (hasSub) {
        row.appendChild(el("span", "ctx-arrow", "▸"));
        // 子菜单：悬停展开；离开时给 140ms 宽限期，便于把鼠标移进子菜单
        let timer = 0;
        let child: HTMLElement | null = null;
        const closeChild = () => {
          if (child) { child.remove(); child = null; }
        };
        row.addEventListener("mouseenter", () => {
          window.clearTimeout(timer);
          closeChild();
          child = el("div", "ctx-menu ctx-submenu");
          fillMenu(child, it.submenu!);
          document.body.appendChild(child);
          const r = row.getBoundingClientRect();
          child.style.left = `${Math.min(r.right + 2, window.innerWidth - child.offsetWidth - 8)}px`;
          child.style.top = `${Math.min(r.top, window.innerHeight - child.offsetHeight - 8)}px`;
          child.addEventListener("mouseenter", () => window.clearTimeout(timer));
          child.addEventListener("mouseleave", () => { timer = window.setTimeout(closeChild, 140); });
        });
        row.addEventListener("mouseleave", () => { timer = window.setTimeout(closeChild, 140); });
        // 有子菜单的父项本身不执行动作
        node.appendChild(row);
        continue;
      }
      if (!it.disabled && it.run) {
        row.addEventListener("click", () => {
          hideContextMenu();
          it.run?.();
        });
      }
      node.appendChild(row);
    }
  }

  fillMenu(root, items);
  document.body.appendChild(root);
  const rect = root.getBoundingClientRect();
  root.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  root.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  menuNode = root;

  // 点击菜单之外的任何地方 → 关闭（子菜单里的点击除外，否则子项点不中）
  const close = (ev: MouseEvent) => {
    const t = ev.target as Node;
    for (const m of Array.from(document.querySelectorAll(".ctx-menu"))) {
      if (m.contains(t)) return;
    }
    hideContextMenu();
    window.removeEventListener("mousedown", close);
  };
  setTimeout(() => window.addEventListener("mousedown", close), 0);
}

/** 节流：把高频调用压到至少 intervalMs 一次。 */
export function throttle(fn: () => void, intervalMs: number): () => void {
  let last = 0;
  let timer: number | null = null;
  return () => {
    const now = performance.now();
    const wait = intervalMs - (now - last);
    if (wait <= 0) {
      last = now;
      fn();
    } else if (timer === null) {
      timer = window.setTimeout(() => {
        timer = null;
        last = performance.now();
        fn();
      }, wait);
    }
  };
}
