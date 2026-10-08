import { useState, type CSSProperties } from "react";

import { photoUrl } from "../ipc/photo";

interface PhotoStripProps {
  sessionId: string;
  /** 1-based shot numbers available from the backend. */
  photos: number[];
  headline: string;
  date: string;
  /** Size multiplier. Omit to let CSS decide (the review screen uses 1.3 landscape, 1.45 portrait). */
  scale?: number;
}

/** A vertical strip of photos with a white border, slight tilt and drop shadow. */
export function PhotoStrip({ sessionId, photos, headline, date, scale }: PhotoStripProps) {
  const style = scale === undefined ? undefined : ({ "--scale": scale } as CSSProperties);
  return (
    <div className="strip" style={style} data-testid="photo-strip">
      {photos.map((shot) => (
        <StripPhoto key={`${sessionId}-${shot}`} sessionId={sessionId} shot={shot} />
      ))}
      <div className="strip__meta">
        <span>{headline.toUpperCase()}</span>
        <span>{date}</span>
      </div>
    </div>
  );
}

function StripPhoto({ sessionId, shot }: { sessionId: string; shot: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="strip__photo">
      {failed ? (
        <div className="strip__missing" role="img" aria-label={`Photo ${shot} unavailable`}>
          PHOTO {shot}
        </div>
      ) : (
        <img
          src={photoUrl(sessionId, shot)}
          alt={`Photo ${shot}`}
          onError={() => setFailed(true)}
          draggable={false}
        />
      )}
    </div>
  );
}
