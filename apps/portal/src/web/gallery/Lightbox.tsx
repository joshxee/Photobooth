import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import type { GalleryPhoto } from "../../shared/schemas";
import { Icon } from "../ui/icons";
import { mediaUrl } from "./api";
import { formatTime } from "./format";

const SWIPE_PX = 50;

function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([""], "photo.jpg", { type: "image/jpeg" })] });
  } catch {
    return false;
  }
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
}

interface Props {
  publicId: string;
  /** Every photo in the view, in display order. */
  photos: GalleryPhoto[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
}

/**
 * The full-screen viewer: the HD variant, Download, and Share where the phone can share files
 * (on iPhone that is how a photo reaches Photos). A modal dialog: focus moves in, Tab stays
 * inside, Escape or Back closes, and focus returns to the photo it was opened from.
 */
export function Lightbox({ publicId, photos, index, onIndex, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const startX = useRef<number | null>(null);
  const [shareFile, setShareFile] = useState<File | null>(null);
  const [canShare] = useState(canShareFiles);
  const photo = photos[index];

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLElement>(".viewer__close")?.focus();
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  useEffect(() => setShareFile(null), [photo?.id]);

  if (!photo) return null;
  const session = photos.filter((p) => p.sessionId === photo.sessionId);
  const position = session.indexOf(photo) + 1;
  const label = `Photo ${position} of ${session.length}, ${formatTime(photo.publishedAt)}`;
  const hd = mediaUrl(publicId, photo.id, "hd");

  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < photos.length) onIndex(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowLeft") {
      go(-1);
    } else if (e.key === "ArrowRight") {
      go(1);
    } else if (e.key === "Tab" && dialog.current) {
      const items = focusables(dialog.current);
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    startX.current = e.clientX;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    if (dx > SWIPE_PX) go(-1);
    else if (dx < -SWIPE_PX) go(1);
  };

  // The HD image is cached immutably, so once it has loaded this read is a cache hit, not a request.
  const prepareShare = async () => {
    if (!canShare) return;
    try {
      const blob = await (await fetch(hd, { credentials: "same-origin" })).blob();
      setShareFile(new File([blob], `photo-${photo.shot}.jpg`, { type: "image/jpeg" }));
    } catch {
      setShareFile(null);
    }
  };
  const share = async () => {
    if (!shareFile) return;
    try {
      await navigator.share({ files: [shareFile] });
    } catch {
      // Cancelled by the guest, or not allowed: nothing to report.
    }
  };

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={label} ref={dialog} onKeyDown={onKeyDown}>
      <div className="viewer__bar">
        <button type="button" className="viewer__close icon-btn" aria-label="Back to the photos" onClick={onClose}>
          <Icon name="back" size={24} />
        </button>
        <p className="viewer__title">
          <span>{formatTime(photo.publishedAt)}</span>
          <span className="viewer__pos">
            {position} of {session.length}
          </span>
        </p>
      </div>
      <div className="viewer__stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <img
          key={photo.id}
          className="viewer__img"
          src={hd}
          width={photo.width}
          height={photo.height}
          alt={label}
          onLoad={prepareShare}
          draggable={false}
        />
        {index > 0 && (
          <button type="button" className="viewer__nav viewer__nav--prev icon-btn" aria-label="Previous photo" onClick={() => go(-1)}>
            <Icon name="back" size={24} />
          </button>
        )}
        {index < photos.length - 1 && (
          <button type="button" className="viewer__nav viewer__nav--next icon-btn" aria-label="Next photo" onClick={() => go(1)}>
            <Icon name="next" size={24} />
          </button>
        )}
      </div>
      <div className={`viewer__actions${canShare ? " viewer__actions--two" : ""}`}>
        <a className="btn btn--light viewer__download" href={mediaUrl(publicId, photo.id, "hd", true)} download>
          <Icon name="download" />
          <span>Download</span>
        </a>
        {canShare && (
          <button type="button" className="btn btn--dark" onClick={share} disabled={!shareFile}>
            <Icon name="share" />
            <span>Share</span>
          </button>
        )}
      </div>
    </div>
  );
}
