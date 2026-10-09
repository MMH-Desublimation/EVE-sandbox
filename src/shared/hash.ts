/**
 * 纯函数哈希与 PRNG（无任何 Node 依赖，可在 Worker / 浏览器运行）。
 */

/** FNV-1a 32 位：字符串 → uint32。 */
export function fnv1a32(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 把若干整数混成一个 uint32（splitmix32 风格的雪崩混合）。 */
export function mix32(...nums: number[]): number {
  let h = 0x9e3779b9 >>> 0;
  for (const n of nums) {
    h = (h ^ (n >>> 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：给定 uint32 种子，产出 [0,1) 序列。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 稳定字符串指纹（16 位十六进制）。 */
export function fingerprint(text: string): string {
  const a = fnv1a32(text, 0x811c9dc5);
  const b = fnv1a32(text, 0x01000193);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
