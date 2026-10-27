// A list that loads a page at a time with an opaque cursor, as the photo grid and the audit list
// do. A new `key` (a different filter) starts over; `refresh` reloads the first page without
// blanking what is shown; `loadMore` appends the next page. An answer that is no longer the latest
// request is dropped, so a slow page never lands on top of a newer filter.
import { useCallback, useEffect, useRef, useState } from "react";
import { isNotAuthorised } from "./api";
import { useAdmin } from "./env";

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface PagedList<T> {
  items: T[];
  next: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  /** Edit the loaded items in place (after a hide or a delete), without a request. */
  update(fn: (items: T[]) => T[]): void;
}

type State<T> = { items: T[]; next: string | null; loading: boolean; loadingMore: boolean; error: unknown };
type Mode = "reset" | "refresh" | "more";

export function usePaged<T>(fetchPage: (cursor: string | null) => Promise<Page<T>>, key: string): PagedList<T> {
  const { onNotAuthorised } = useAdmin();
  const latest = useRef(fetchPage);
  latest.current = fetchPage;
  const sequence = useRef(0);
  const [state, setState] = useState<State<T>>({ items: [], next: null, loading: true, loadingMore: false, error: null });
  const next = useRef<string | null>(null);
  next.current = state.next;

  const load = useCallback(
    async (mode: Mode) => {
      const mine = ++sequence.current;
      const cursor = mode === "more" ? next.current : null;
      setState((s) =>
        mode === "reset"
          ? { items: [], next: null, loading: true, loadingMore: false, error: null }
          : { ...s, loadingMore: mode === "more", error: null },
      );
      try {
        const page = await latest.current(cursor);
        if (mine !== sequence.current) return;
        setState((s) => ({ items: mode === "more" ? [...s.items, ...page.items] : page.items, next: page.next, loading: false, loadingMore: false, error: null }));
      } catch (error) {
        if (mine !== sequence.current) return;
        if (isNotAuthorised(error)) onNotAuthorised();
        setState((s) => ({ ...s, loading: false, loadingMore: false, error }));
      }
    },
    [onNotAuthorised],
  );

  useEffect(() => {
    void load("reset");
  }, [key, load]);

  return {
    ...state,
    refresh: () => load("refresh"),
    loadMore: () => load("more"),
    update: (fn) => setState((s) => ({ ...s, items: fn(s.items) })),
  };
}
