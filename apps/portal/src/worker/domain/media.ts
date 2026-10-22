// R2 object keys (DESIGN §7, D6). One bucket, `events/` prefix only, fixed keys per photo: a
// retried upload overwrites the same object, and purging an event is one prefix delete.
import type { Variant } from "../../shared/schemas";

export function variantKey(eventId: string, photoId: string, variant: Variant): string {
  return `events/${eventId}/${photoId}/${variant}.jpg`;
}
