import { useCallback, useEffect, useState } from 'react';

export const TOKEN_KEY = 'xingtu-price-monitor-token';
const DATA_CHANGED_EVENT = 'xingtu-data-changed';
let refreshScheduled = false;

// 写操作完成后通知所有已挂载页面，包括顶部未读铃铛；GET 不产生事件。
export function invalidateData() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  window.setTimeout(() => { refreshScheduled = false; window.dispatchEvent(new Event(DATA_CHANGED_EVENT)); }, 0);
}

// 所有页面通过同一接口层读取采集流水，避免各页自行生成或缓存价格。
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`/api${path}`, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/status') && !path.startsWith('/auth/bootstrap')) {
      localStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(new Event('xingtu-auth-expired'));
    }
    throw new Error(result?.error?.message || `请求失败（HTTP ${response.status}）`);
  }
  const method = (init.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) && !path.startsWith('/auth/') && path !== '/collectors/preview') invalidateData();
  return result as T;
}

export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
  const search = new URLSearchParams(entries.map(([key, value]) => [key, String(value)]));
  return search.size ? `?${search.toString()}` : '';
}

export function useRemote<T>(url: string | null) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!url) return;
    // 标签页隐藏时暂停轮询，恢复可见或切回窗口时立即更新。
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener(DATA_CHANGED_EVENT, reload);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, 30_000);
    return () => { window.clearInterval(timer); window.removeEventListener(DATA_CHANGED_EVENT, reload); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [url, reload]);
  useEffect(() => {
    if (!url) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(url, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '请求失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [url, revision]);
  return { data, loading, error, reload };
}
