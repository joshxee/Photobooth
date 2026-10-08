//! The only place captured photos live: an in-memory map. Nothing here (or in any crate
//! above) writes photos to disk.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;

type Key = (String, u8);

/// Thread-safe, cheaply cloneable handle to the shared photo map keyed by
/// `(session_id, shot)`. Shots are 1-based.
#[derive(Clone, Default)]
pub struct PhotoStore {
    inner: Arc<Mutex<HashMap<Key, Bytes>>>,
}

impl PhotoStore {
    pub fn new() -> Self {
        Self::default()
    }

    // A panic while holding the lock cannot leave the map half-updated (each operation is a
    // single HashMap call), so recovering from poisoning is sound.
    fn map(&self) -> MutexGuard<'_, HashMap<Key, Bytes>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn put(&self, session_id: &str, shot: u8, jpeg: Bytes) {
        self.map().insert((session_id.to_owned(), shot), jpeg);
    }

    pub fn get(&self, session_id: &str, shot: u8) -> Option<Bytes> {
        self.map().get(&(session_id.to_owned(), shot)).cloned()
    }

    /// Removes every photo of every session.
    pub fn clear(&self) {
        self.map().clear();
    }

    pub fn len(&self) -> usize {
        self.map().len()
    }

    pub fn is_empty(&self) -> bool {
        self.map().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_round_trip() {
        let store = PhotoStore::new();
        store.put("s1", 1, Bytes::from_static(b"one"));
        store.put("s1", 2, Bytes::from_static(b"two"));
        assert_eq!(store.get("s1", 1).unwrap(), Bytes::from_static(b"one"));
        assert_eq!(store.get("s1", 2).unwrap(), Bytes::from_static(b"two"));
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn missing_entries_are_none() {
        let store = PhotoStore::new();
        store.put("s1", 1, Bytes::from_static(b"x"));
        assert!(store.get("s1", 2).is_none());
        assert!(store.get("other", 1).is_none());
    }

    #[test]
    fn clear_removes_everything() {
        let store = PhotoStore::new();
        store.put("s1", 1, Bytes::from_static(b"x"));
        store.put("s2", 1, Bytes::from_static(b"y"));
        store.clear();
        assert!(store.is_empty());
        assert!(store.get("s1", 1).is_none());
    }

    #[test]
    fn clones_share_state() {
        let a = PhotoStore::new();
        let b = a.clone();
        a.put("s", 1, Bytes::from_static(b"x"));
        assert!(b.get("s", 1).is_some());
        b.clear();
        assert!(a.get("s", 1).is_none());
    }

    #[test]
    fn concurrent_puts_do_not_lose_entries() {
        let store = PhotoStore::new();
        let threads: Vec<_> = (0..8u8)
            .map(|t| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for shot in 0..50u8 {
                        store.put(&format!("s{t}"), shot, Bytes::from(vec![t, shot]));
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(store.len(), 8 * 50);
    }
}
