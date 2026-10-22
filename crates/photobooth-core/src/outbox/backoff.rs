//! Retry timing (DESIGN §9.3): jittered exponential backoff from 1 s to a 5 min cap, never
//! sooner than the server's `Retry-After`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// The first retry waits up to this long.
pub const BACKOFF_BASE: Duration = Duration::from_secs(1);
/// No backoff step waits longer than this.
pub const BACKOFF_CAP: Duration = Duration::from_secs(5 * 60);
/// A `Retry-After` longer than this is cut to it, so one bad header can't park an item for
/// days. The daily-limit 429 on Workers Free is the longest legitimate wait we expect.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(60 * 60);

/// Source of backoff jitter: a fraction in `[0, 1]`. Injectable so tests are exact.
pub trait Jitter: Send + Sync {
    fn fraction(&self) -> f64;
}

/// The same fraction every time, for tests. `FixedJitter(1.0)` gives the exact backoff step.
#[derive(Clone, Copy, Debug)]
pub struct FixedJitter(pub f64);

impl Jitter for FixedJitter {
    fn fraction(&self) -> f64 {
        self.0.clamp(0.0, 1.0)
    }
}

/// xorshift64* seeded once from the OS RNG (through `uuid`'s v4 generator, which the outbox
/// already uses for photo IDs). Jitter only spreads retries out; it needs no cryptographic
/// strength, and this avoids a `rand` dependency.
#[derive(Debug)]
pub struct RandomJitter {
    state: AtomicU64,
}

impl RandomJitter {
    pub fn new() -> Self {
        let seed = uuid::Uuid::new_v4().as_u64_pair().0 | 1;
        Self::with_seed(seed)
    }

    pub fn with_seed(seed: u64) -> Self {
        Self {
            state: AtomicU64::new(seed.max(1)),
        }
    }
}

impl Default for RandomJitter {
    fn default() -> Self {
        Self::new()
    }
}

impl Jitter for RandomJitter {
    fn fraction(&self) -> f64 {
        let step = |mut x: u64| {
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            x
        };
        let prev = self
            .state
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |x| Some(step(x)))
            .unwrap_or(1);
        let out = step(prev).wrapping_mul(0x2545_F491_4F6C_DD1D);
        // The top 53 bits as a fraction in [0, 1).
        (out >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The wait before retry number `attempt` (1-based): a step of `1 s × 2^(attempt−1)`, capped
/// at 5 min, then jittered down to between half and all of it ("equal jitter"), so the first
/// retry is never instant and no wait exceeds the cap.
pub fn backoff_delay(attempt: u32, jitter: f64) -> Duration {
    let exp = attempt.saturating_sub(1).min(16);
    let step = BACKOFF_BASE.saturating_mul(1 << exp).min(BACKOFF_CAP);
    let jitter = jitter.clamp(0.0, 1.0);
    step.mul_f64(0.5 + 0.5 * jitter)
}

/// The backoff, but never less than the server's `Retry-After` (cut to [`MAX_RETRY_AFTER`]).
pub fn retry_delay(attempt: u32, jitter: f64, retry_after: Option<Duration>) -> Duration {
    let backoff = backoff_delay(attempt, jitter);
    match retry_after {
        Some(after) => backoff.max(after.min(MAX_RETRY_AFTER)),
        None => backoff,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_from_one_second() {
        let full = |n| backoff_delay(n, 1.0);
        assert_eq!(full(1), Duration::from_secs(1));
        assert_eq!(full(2), Duration::from_secs(2));
        assert_eq!(full(3), Duration::from_secs(4));
        assert_eq!(full(8), Duration::from_secs(128));
    }

    #[test]
    fn backoff_is_capped_at_five_minutes() {
        assert_eq!(backoff_delay(9, 1.0), Duration::from_secs(256));
        assert_eq!(
            backoff_delay(10, 1.0),
            BACKOFF_CAP,
            "the 512 s step is capped"
        );
        assert_eq!(backoff_delay(u32::MAX, 1.0), BACKOFF_CAP);
        for attempt in 0..200 {
            for jitter in [0.0, 0.3, 0.999, 1.0] {
                assert!(backoff_delay(attempt, jitter) <= BACKOFF_CAP);
            }
        }
    }

    #[test]
    fn jitter_spreads_between_half_and_full_step() {
        assert_eq!(backoff_delay(1, 0.0), Duration::from_millis(500));
        assert_eq!(backoff_delay(3, 0.5), Duration::from_secs(3));
        assert_eq!(backoff_delay(20, 0.0), BACKOFF_CAP / 2);
    }

    #[test]
    fn retry_after_wins_when_longer_than_the_backoff() {
        let after = Some(Duration::from_secs(30));
        assert_eq!(retry_delay(1, 1.0, after), Duration::from_secs(30));
        // A shorter Retry-After doesn't shorten the backoff.
        assert_eq!(
            retry_delay(10, 1.0, Some(Duration::from_secs(1))),
            BACKOFF_CAP
        );
        // It may exceed the backoff cap (the server knows best), up to an hour.
        assert_eq!(
            retry_delay(1, 1.0, Some(Duration::from_secs(900))),
            Duration::from_secs(900)
        );
        assert_eq!(
            retry_delay(1, 1.0, Some(Duration::from_secs(86_400))),
            MAX_RETRY_AFTER
        );
    }

    #[test]
    fn random_jitter_stays_in_range_and_varies() {
        let jitter = RandomJitter::with_seed(42);
        let samples: Vec<f64> = (0..1000).map(|_| jitter.fraction()).collect();
        assert!(samples.iter().all(|f| (0.0..1.0).contains(f)));
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        assert!((0.4..0.6).contains(&mean), "mean {mean}");
        assert!(samples.windows(2).any(|w| w[0] != w[1]));
        // Seeded from the OS, two generators differ.
        assert_ne!(
            RandomJitter::new().fraction(),
            RandomJitter::new().fraction()
        );
    }
}
