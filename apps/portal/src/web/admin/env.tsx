// What the views take from the browser, behind one seam so tests can drive time, visibility,
// downloads and the clipboard. Also the loading hook the views share.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { isNotAuthorised } from "./api";
import { qrPng } from "./qr";
import { type RefreshEnv, browserEnv } from "./refresh";

export interface AdminEnv extends RefreshEnv {
  now(): number;
  /** Hands a generated file to the browser's download. */
  saveFile(blob: Blob, filename: string): void;
  copyText(text: string): Promise<void>;
  png(text: string): Promise<Blob>;
}

export const browserAdminEnv: AdminEnv = {
  ...browserEnv,
  now: () => Date.now(),
  saveFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
  copyText: (text) => navigator.clipboard.writeText(text),
  png: qrPng,
};

interface Ctx {
  env: AdminEnv;
  /** The API said 401/403: the app shows the Not authorised page. */
  onNotAuthorised(): void;
}

const AdminContext = createContext<Ctx | null>(null);
export const AdminProvider = AdminContext.Provider;

export function useAdmin(): Ctx {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("AdminProvider is missing");
  return ctx;
}

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Reloads without blanking what is shown; a failure keeps the last data and sets `error`. */
  reload(): Promise<void>;
  setData(data: T): void;
}

/** Loads on mount and whenever `key` changes. A 401 or 403 sends the app to Not authorised. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const { onNotAuthorised } = useAdmin();
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const latest = useRef(load);
  latest.current = load;
  const alive = useRef(true);
  const requestKey = useRef(key);
  requestKey.current = key;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const forKey = requestKey.current;
    try {
      const data = await latest.current();
      if (alive.current && forKey === requestKey.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (!alive.current || forKey !== requestKey.current) return;
      if (isNotAuthorised(error)) onNotAuthorised();
      setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, [onNotAuthorised]);

  useEffect(() => {
    setState({ data: null, error: null, loading: true });
    void reload();
  }, [key, reload]);

  const setData = useCallback((data: T) => setState({ data, error: null, loading: false }), []);
  return { ...state, reload, setData };
}
