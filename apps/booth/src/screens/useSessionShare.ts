import { useEffect, useState } from "react";

import { portalSessionQr } from "../ipc/commands";
import type { SessionShare } from "../ipc/types";

const NONE: SessionShare = { mode: "none" };

/**
 * What Rust says the review of `sessionId` offers the guest (its QR code, a line about the
 * event gallery, or nothing new), asked once per session. Null until Rust answers. A failed
 * call is not the guest's problem: the review falls back to the screen it had before the portal.
 */
export function useSessionShare(sessionId: string | null): SessionShare | null {
  const [answer, setAnswer] = useState<{ id: string; share: SessionShare } | null>(null);
  useEffect(() => {
    if (sessionId === null) return;
    let current = true;
    portalSessionQr(sessionId)
      .then((share) => share ?? NONE)
      .catch(() => NONE)
      .then((share) => {
        if (current) setAnswer({ id: sessionId, share });
      });
    return () => {
      current = false;
    };
  }, [sessionId]);
  return answer !== null && answer.id === sessionId ? answer.share : null;
}
