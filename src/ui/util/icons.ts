/**
 * 单位图标：按**吨位**取形状（用户提供的线稿 PNG），按**势力**染色 + 微发光。
 *
 * 图标来源：`src/ui/assets/ships/<吨位>.png`（纯白线稿、透明背景）。
 * 用户的规则：同吨位、不同科技等级的船用**同一个图标**
 *   （多米尼克斯级 / 多米尼克斯级海军型 / 罪恶级 / 克洛诺斯级 → battleship.png）。
 * 吨位判定在 `shared/hullclass.ts`，依据 SDE 的 Category/Group，而非船名正则。
 *
 * 性能（§8.7）：把"形状 × 颜色"的渲染结果缓存到离屏 Canvas，之后只做 drawImage。
 */
import { setStyle } from "./dom.ts";
import {
  ICON_CLASSES, iconSizeOf, type IconClass,
} from "../../shared/hullclass.ts";

export type { IconClass };
export { iconSizeOf };

/** 超采样倍率：线稿细，需要比显示尺寸大几倍才不发虚。 */
const SUPERSAMPLE = 3;
/** 发光半径占图标尺寸的比例（"微发光"）。 */
const GLOW_RATIO = 0.10;

const images = new Map<IconClass, HTMLImageElement>();
const failed = new Set<IconClass>();
const cache = new Map<string, HTMLCanvasElement>();
let preloaded = false;

/**
 * 预载全部吨位线稿。返回的 Promise 在全部尝试完成后 resolve；
 * 加载失败的类别会退回程序化形状，不影响使用。
 */
export function preloadIcons(): Promise<void> {
  if (preloaded) return Promise.resolve();
  preloaded = true;
  const targets = ICON_CLASSES.filter((c) => c !== "unknown");
  return Promise.all(
    targets.map(
      (cls) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.decoding = "async";
          img.onload = () => {
            images.set(cls, img);
            resolve();
          };
          img.onerror = () => {
            failed.add(cls);
            resolve();
          };
          img.src = new URL(`../assets/ships/${cls}.png`, import.meta.url).href;
        }),
    ),
  ).then(() => {
    cache.clear();
  });
}

/** 已成功加载的图标数（供诊断/验收）。 */
export function iconsReady(): { loaded: number; failed: number } {
  return { loaded: images.size, failed: failed.size };
}

/** 取得（并缓存）已染色 + 发光的图标。 */
export function tintedIcon(cls: IconClass, color: string): HTMLCanvasElement {
  const key = `${cls}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = renderIcon(cls, color);
  cache.set(key, cv);
  return cv;
}

function renderIcon(cls: IconClass, color: string): HTMLCanvasElement {
  const half = iconSizeOf(cls);
  const px = Math.max(16, Math.round(half * 2 * SUPERSAMPLE));
  const cv = document.createElement("canvas");
  cv.width = px;
  cv.height = px;
  const g = cv.getContext("2d");
  if (!g) return cv;

  const img = images.get(cls);
  if (!img) {
    // 预载未完成 / 该类别没有素材 → 程序化兜底形状
    drawFallback(g, px, color);
    return cv;
  }

  // 1) 白色线稿 + 微发光（叠两次让发光更实）
  g.save();
  g.shadowColor = color;
  g.shadowBlur = Math.max(3, px * GLOW_RATIO);
  g.drawImage(img, 0, 0, px, px);
  g.drawImage(img, 0, 0, px, px);
  g.restore();

  // 2) source-in：把线稿整体染成势力色（保留原有 alpha，因此发光晕也一并被染色）
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, px, px);
  g.globalCompositeOperation = "source-over";

  // 3) 轻微提亮线稿本体，保证在深色沙盘上可读
  g.globalCompositeOperation = "lighter";
  g.globalAlpha = 0.35;
  g.drawImage(img, 0, 0, px, px);
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";

  return cv;
}

/** 无素材时的兜底形状（圆 + 中线），保持"不同吨位不同大小"。 */
function drawFallback(g: CanvasRenderingContext2D, px: number, color: string): void {
  const c = px / 2;
  const r = c - px * 0.12;
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, px / 14);
  g.shadowColor = color;
  g.shadowBlur = px * GLOW_RATIO;
  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.stroke();
}

/** 图标在沙盘上的半宽（CSS px）。 */
export function iconSize(cls: IconClass): number {
  return iconSizeOf(cls);
}

export function applySideColor(node: HTMLElement, cssVar: string): void {
  setStyle(node, "color", `var(${cssVar})`);
}
