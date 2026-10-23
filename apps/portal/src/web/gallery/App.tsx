import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GalleryPhoto, GalleryPhotosPage } from "../../shared/schemas";
import { fetchPhotos, type Refusal, swapToken } from "./api";
import { appendOlder, type Feed, groupSessions, mergeLatest, receiveLatest, showPending, startFeed } from "./feed";
import { Lightbox } from "./Lightbox";
import { cleanUrl, parseLink, viewUrl } from "./link";
import { browserEnv, createPoller, FAST_WINDOW_MS, type PollerEnv } from "./poller";
import { EventView, Footer, Loading, type Meta, SessionView, Trouble, Unavailable } from "./Views";

// One view (the event, or one session with ?s=) plus a lightbox. No router: the view lives in the
// URL's query and the open photo in history.state, so Back closes the lightbox and then leaves the
// session view, as a guest expects.

type Phase = "loading" | "ready" | "unavailable" | "busy" | "error";

interface View {
  session: string | null;
  expected: number | null;
}

function metaOf(page: GalleryPhotosPage): Meta {
  return { eventName: page.eventName, localDate: page.localDate, eventOpen: page.eventOpen, contact: page.contact };
}

function photoState(state: unknown = history.state): string | null {
  return state && typeof state === "object" && "photo" in state && typeof state.photo === "string" ? state.photo : null;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function App({ env = browserEnv }: { env?: PollerEnv }) {
  const link = useMemo(() => parseLink(location.pathname, location.search, location.hash), []);
  const publicId = link?.publicId ?? "";
  // The booth's session link gets the 10 s polling and placeholders; a session opened from the
  // event view is history, so it polls like the event.
  const boothSession = link?.token && link.session ? link.session : null;
  const [phase, setPhase] = useState<Phase>(link ? "loading" : "unavailable");
  const [authed, setAuthed] = useState(false);
  const [view, setView] = useState<View>({ session: link?.session ?? null, expected: link?.expected ?? null });
  const [meta, setMeta] = useState<Meta | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [arriving, setArriving] = useState(boothSession !== null);
  const [attempt, setAttempt] = useState(0);
  // Bumped on every view change, so answers for an old view are dropped.
  const viewSeq = useRef(0);

  const refuse = useCallback(
    (r: Refusal) => {
      if (r.kind === "unavailable") setPhase("unavailable");
      else if (r.kind === "rate_limited") {
        setPhase("busy");
        env.setTimeout(() => setAttempt((n) => n + 1), r.retryAfterMs);
      } else setPhase("error");
    },
    [env],
  );

  // 1. The token from the fragment becomes the cookie; the address loses the fragment either way.
  useEffect(() => {
    if (!link) return;
    if (!link.token) {
      setAuthed(true);
      return;
    }
    history.replaceState(null, "", cleanUrl(link));
    void swapToken(link.publicId, link.token).then((r) => (r.kind === "ok" ? setAuthed(true) : refuse(r)));
  }, [link, refuse]);

  // The booth session's placeholders stand for at most the fast-polling window.
  useEffect(() => {
    if (!boothSession) return;
    const timer = env.setTimeout(() => setArriving(false), FAST_WINDOW_MS);
    return () => env.clearTimeout(timer);
  }, [boothSession, env]);

  // 2. The first page of the current view.
  useEffect(() => {
    if (!authed) return;
    const seq = ++viewSeq.current;
    setPhase("loading");
    void fetchPhotos(publicId, { session: view.session }).then((r) => {
      if (seq !== viewSeq.current) return;
      if (r.kind !== "ok") return refuse(r);
      setMeta(metaOf(r.page));
      setFeed(startFeed(r.page));
      setPhase("ready");
    });
  }, [authed, publicId, view.session, refuse, attempt]);

  // 3. Live updates while the event accepts uploads (poller.ts has the rates and why).
  const eventOpen = meta?.eventOpen ?? false;
  useEffect(() => {
    if (phase !== "ready" || !eventOpen) return;
    const seq = viewSeq.current;
    const session = view.session;
    const poller = createPoller({
      env,
      fast: session !== null && session === boothSession,
      async poll() {
        const r = await fetchPhotos(publicId, { session });
        if (seq !== viewSeq.current) return "stop";
        if (r.kind === "unavailable") {
          setPhase("unavailable");
          return "stop";
        }
        if (r.kind !== "ok") return undefined;
        setMeta(metaOf(r.page));
        setFeed((f) => (f ? (session ? mergeLatest(f, r.page) : receiveLatest(f, r.page)) : f));
        return r.page.eventOpen ? undefined : "stop";
      },
    });
    poller.start();
    return () => poller.stop();
  }, [phase, eventOpen, view.session, boothSession, publicId, env]);

  // Back and Forward: the view comes from the URL, the open photo from history.state.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      setPhotoId(photoState(e.state));
      const now = parseLink(location.pathname, location.search, "");
      if (!now) return;
      setView((v) => (v.session === now.session ? v : { session: now.session, expected: now.expected }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (session: string | null) => {
    history.pushState(null, "", viewUrl(publicId, session, null));
    setPhotoId(null);
    setView({ session, expected: null });
    window.scrollTo({ top: 0 });
  };

  const loadMore = async () => {
    if (!feed?.nextCursor || loadingMore) return;
    const seq = viewSeq.current;
    setLoadingMore(true);
    const r = await fetchPhotos(publicId, { cursor: feed.nextCursor, session: view.session });
    setLoadingMore(false);
    if (seq !== viewSeq.current || r.kind !== "ok") return;
    setFeed((f) => (f ? appendOlder(f, r.page) : f));
  };

  const showNew = () => {
    setFeed((f) => (f ? showPending(f) : f));
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    document.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  };

  const open = (photo: GalleryPhoto) => {
    history.pushState({ photo: photo.id }, "", location.pathname + location.search);
    setPhotoId(photo.id);
  };
  const close = () => {
    setPhotoId(null);
    if (photoState()) history.back();
  };

  if (phase === "unavailable") return <Unavailable />;
  if (phase === "busy" || phase === "error") return <Trouble busy={phase === "busy"} onRetry={() => setAttempt((n) => n + 1)} />;
  if (phase === "loading" || !meta || !feed) return <Loading />;

  // The lightbox walks the photos in the order they are shown.
  const ordered = view.session
    ? [...feed.photos].sort((a, b) => a.shot - b.shot)
    : groupSessions(feed.photos).flatMap((g) => g.photos);
  const index = photoId ? ordered.findIndex((p) => p.id === photoId) : -1;
  const waiting =
    view.session && view.session === boothSession
      ? view.expected
        ? Math.max(view.expected - feed.photos.length, 0)
        : arriving
          ? 1
          : 0
      : 0;

  return (
    <>
      <div className="page" inert={index >= 0}>
        <main>
          {view.session ? (
            <SessionView
              publicId={publicId}
              meta={meta}
              photos={feed.photos}
              waiting={waiting}
              countKnown={view.expected !== null}
              onOpen={open}
              onEvent={() => go(null)}
            />
          ) : (
            <EventView
              publicId={publicId}
              meta={meta}
              photos={feed.photos}
              pending={feed.pending.length}
              hasMore={feed.nextCursor !== null}
              loadingMore={loadingMore}
              onMore={loadMore}
              onShowNew={showNew}
              onOpen={open}
              onSession={go}
            />
          )}
        </main>
        <Footer meta={meta} />
      </div>
      {index >= 0 && (
        <Lightbox
          publicId={publicId}
          photos={ordered}
          index={index}
          onIndex={(i) => {
            const next = ordered[i];
            if (!next) return;
            history.replaceState({ photo: next.id }, "", location.pathname + location.search);
            setPhotoId(next.id);
          }}
          onClose={close}
        />
      )}
    </>
  );
}
