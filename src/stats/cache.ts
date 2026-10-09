/**
 * 属性缓存层（契约 §5.1）。
 *
 * 键 = (fitFingerprint, stateBitmap, envKey)，值 = 属性表。
 * 负责「同一配装 + 同一状态组合，属性表只算一次」。
 * 依据 SPIKE 实测（单次 9.2ms 稳态），无需预计算或跨会话持久化。
 */
import type { AttrKey, FitStats } from "../shared/contract.ts";
import { attrKeyString } from "../shared/contract.ts";
import { fitFingerprint, makeAttrKey, stateBitmap } from "../shared/attrkey.ts";

export { fitFingerprint, makeAttrKey, stateBitmap };

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/** 有容量上限的简单 LRU（Map 的插入序即可当 LRU 用）。 */
export class AttrCache {
  #map = new Map<string, FitStats>();
  #max: number;
  #hits = 0;
  #misses = 0;

  constructor(max = 4096) {
    this.#max = max;
  }

  get(key: AttrKey): FitStats | undefined {
    const k = attrKeyString(key);
    const hit = this.#map.get(k);
    if (hit === undefined) {
      this.#misses++;
      return undefined;
    }
    this.#hits++;
    // 命中后移到队尾（LRU）
    this.#map.delete(k);
    this.#map.set(k, hit);
    return hit;
  }

  set(key: AttrKey, value: FitStats): void {
    const k = attrKeyString(key);
    if (this.#map.has(k)) this.#map.delete(k);
    this.#map.set(k, value);
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next();
      if (!oldest.done) this.#map.delete(oldest.value);
    }
  }

  /** 取或算（幂等）。 */
  async getOrCompute(key: AttrKey, compute: () => Promise<FitStats>): Promise<FitStats> {
    const cached = this.get(key);
    if (cached) return cached;
    const value = await compute();
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.#map.clear();
    this.#hits = 0;
    this.#misses = 0;
  }

  stats(): CacheStats {
    const total = this.#hits + this.#misses;
    return {
      size: this.#map.size,
      hits: this.#hits,
      misses: this.#misses,
      hitRate: total === 0 ? 0 : this.#hits / total,
    };
  }
}
