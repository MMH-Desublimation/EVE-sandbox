/**
 * 宿主桥：页面（或 Worker 经主线程代理）向 StatOracle 发请求。
 *
 * 两种实现共用同一接口：
 *   - 生产：WebView2 宿主。页面通过 `chrome.webview.postMessage` 把请求交给宿主进程，
 *     宿主进程再与 Python StatOracle 子进程做 JSON 行通信（D-04：非网络 API）。
 *   - 开发：Node 开发宿主的 HTTP 端点（仅开发期使用）。
 */
export interface OraclePayload {
  op: string;
  [key: string]: unknown;
}

export interface OracleReply {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export interface OracleBridge {
  request(payload: OraclePayload): Promise<OracleReply>;
}

/* ------------------------------------------------------------------ 开发期 */

export class HttpBridge implements OracleBridge {
  #url: string;
  constructor(url = "/oracle") {
    this.#url = url;
  }

  async request(payload: OraclePayload): Promise<OracleReply> {
    const res = await fetch(this.#url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`oracle HTTP ${res.status}`);
    return (await res.json()) as OracleReply;
  }
}

/* ------------------------------------------------------------------ 生产 */

interface WebView2 {
  postMessage: (msg: unknown) => void;
  addEventListener: (type: "message", cb: (e: { data: unknown }) => void) => void;
  removeEventListener: (type: "message", cb: (e: { data: unknown }) => void) => void;
}

export class WebView2Bridge implements OracleBridge {
  #wv: WebView2;
  #pending = new Map<number, { resolve: (r: OracleReply) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #onMessage: (e: { data: unknown }) => void;

  constructor(wv: WebView2) {
    this.#wv = wv;
    this.#onMessage = (e) => {
      const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      if (!data || (data as { kind?: string }).kind !== "oracle") return;
      const msg = data as { id: number; ok: boolean } & Record<string, unknown>;
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      p.resolve(msg as unknown as OracleReply);
    };
    wv.addEventListener("message", this.#onMessage);
  }

  request(payload: OraclePayload): Promise<OracleReply> {
    const id = this.#nextId++;
    return new Promise<OracleReply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#wv.postMessage(JSON.stringify({ kind: "oracle", id, payload }));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error("宿主响应超时"));
      }, 120_000);
    });
  }

  dispose(): void {
    this.#wv.removeEventListener("message", this.#onMessage);
  }
}

/**
 * 选择通信通路。
 *
 * ★ 离线保证：**只有宿主桥（WebView2）是发行形态下的通路**。
 *   HTTP 通路被严格限定为 localhost（开发宿主），发行包里页面运行在
 *   `https://eve.sandbox/`，既不满足条件、也没有可达的服务器 ——
 *   因此在发行形态下不存在任何可用的网络路径。
 */
export function createBridge(): OracleBridge {
  const wv = (globalThis as { chrome?: { webview?: WebView2 } }).chrome?.webview;
  if (wv) return new WebView2Bridge(wv);

  const devOrigin =
    typeof location !== "undefined" &&
    (location.hostname === "127.0.0.1" || location.hostname === "localhost");
  if (devOrigin) return new HttpBridge("/oracle");

  throw new Error(
    "未找到宿主桥（chrome.webview）。本软件在发行形态下必须运行于宿主窗口内；"
    + "开发调试请通过 npm run dev 启动本地开发宿主。",
  );
}
