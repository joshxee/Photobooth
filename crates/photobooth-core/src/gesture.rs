//! Open-palm start. A platform [`PalmDetector`] looks for a palm in the guest's box on one
//! live-view frame; [`PalmHold`] decides when a run of those answers amounts to "start"; and
//! [`GestureTrigger`] feeds the session through the ordinary [`StartTrigger`] seam.
//!
//! The decision lives here, not in the platform detector, so the rules (hold time, tolerance
//! for a dropped frame, "inside the box") are plain Rust that is tested on any host. The
//! detector only finds hands.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{watch, Notify};

use crate::trigger::StartTrigger;

/// How long a palm must stay in the box before it counts as "start". The UI fills a ring over
/// this time. (The Kotlin app held 800 ms with nothing to see; a longer hold gives the guest a
/// visible countdown while their hand is still in view. 1 s looked a little rushed.)
pub const DEFAULT_HOLD: Duration = Duration::from_millis(1200);

/// How long the palm may drop out of sight (a missed frame, a flicker) without restarting the
/// hold. The Kotlin app tolerated 250 ms and a palm that kept dropping out never started a
/// session; this errs toward starting.
pub const DEFAULT_GAP_TOLERANCE: Duration = Duration::from_millis(500);

/// A rectangle in a live-view frame, as fractions of its width and height (0 to 1, origin at
/// the top-left of the *unmirrored* frame).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Region {
    /// The whole frame.
    pub const FULL: Region = Region {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    };

    /// `None` unless the rectangle is non-empty and lies inside the frame.
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Option<Self> {
        const EPS: f32 = 1e-4;
        let finite = [x, y, w, h].iter().all(|v| v.is_finite());
        let inside = x >= -EPS && y >= -EPS && x + w <= 1.0 + EPS && y + h <= 1.0 + EPS;
        (finite && w > EPS && h > EPS && inside).then(|| Region { x, y, w, h }.clamped())
    }

    pub fn center(&self) -> (f32, f32) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }

    /// Grown by `margin` (a fraction of this region's own size) on every side, kept inside the
    /// frame.
    pub fn grown(&self, margin: f32) -> Region {
        let dx = self.w * margin;
        let dy = self.h * margin;
        Region {
            x: self.x - dx,
            y: self.y - dy,
            w: self.w + 2.0 * dx,
            h: self.h + 2.0 * dy,
        }
        .clamped()
    }

    fn clamped(self) -> Region {
        let x0 = self.x.clamp(0.0, 1.0);
        let y0 = self.y.clamp(0.0, 1.0);
        let x1 = (self.x + self.w).clamp(0.0, 1.0);
        let y1 = (self.y + self.h).clamp(0.0, 1.0);
        Region {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }
}

/// What the UI shows about gesture start. Published after every sample while gestures are active.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct GestureUpdate {
    /// The palm found in the box, for the highlight on the live preview.
    pub palm: Option<Region>,
    /// A palm has been in the box and the hold is running or being forgiven; the UI's ring
    /// keeps filling until this goes false or the session starts.
    pub holding: bool,
    /// The length of the hold, so the UI can time its ring.
    pub hold_ms: u32,
}

/// A detector that could not classify a frame.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("gesture detector failed: {0}")]
pub struct DetectorError(pub String);

/// Finds an open palm in a live-view frame. Implemented by the platform (MediaPipe on Android).
#[async_trait]
pub trait PalmDetector: Send + Sync + 'static {
    /// Looks for an open palm inside `within` (the guest's box) and returns its bounding box in
    /// whole-frame coordinates. Any hand in the box counts: the detector must not keep
    /// following one hand, or a guest who swaps hands is never recognised.
    async fn find_palm(&self, jpeg: Bytes, within: Region)
        -> Result<Option<Region>, DetectorError>;
}

/// Turns a stream of "palm / no palm" observations into a single "start" decision.
///
/// It fires once the palm has been seen continuously for `hold`, where a gap of up to
/// `gap_tolerance` between sightings does not break the run. After firing it stays quiet until
/// the palm has been absent for longer than the tolerance, so a hand left raised cannot start a
/// second session the moment the first one ends.
#[derive(Debug)]
pub struct PalmHold {
    hold: Duration,
    gap_tolerance: Duration,
    run: Option<Run>,
    /// Set by firing; cleared once the palm has really gone.
    latched: bool,
    /// When the palm was last seen while latched.
    latched_seen: Option<Instant>,
}

#[derive(Clone, Copy, Debug)]
struct Run {
    started: Instant,
    last_seen: Instant,
}

impl PalmHold {
    pub fn new(hold: Duration, gap_tolerance: Duration) -> Self {
        Self {
            hold,
            gap_tolerance,
            run: None,
            latched: false,
            latched_seen: None,
        }
    }

    /// Records one observation made at `now` (non-decreasing). `true` means "start now".
    pub fn observe(&mut self, now: Instant, palm: bool) -> bool {
        if self.latched {
            if palm {
                self.latched_seen = Some(now);
            } else if self
                .latched_seen
                .is_none_or(|seen| now.saturating_duration_since(seen) > self.gap_tolerance)
            {
                self.latched = false;
                self.latched_seen = None;
            }
            return false;
        }

        if palm {
            let run = match self.run {
                Some(run) if now.saturating_duration_since(run.last_seen) <= self.gap_tolerance => {
                    Run {
                        started: run.started,
                        last_seen: now,
                    }
                }
                _ => Run {
                    started: now,
                    last_seen: now,
                },
            };
            self.run = Some(run);
            if now.saturating_duration_since(run.started) >= self.hold {
                self.run = None;
                self.latched = true;
                self.latched_seen = Some(now);
                return true;
            }
        } else if let Some(run) = self.run {
            if now.saturating_duration_since(run.last_seen) > self.gap_tolerance {
                self.run = None;
            }
        }
        false
    }

    /// A palm is being held (or briefly out of sight) and the hold has not completed.
    pub fn holding(&self) -> bool {
        self.run.is_some()
    }

    /// Forgets any run in progress (the screen changed, the camera went away). A latch stays,
    /// so a palm that is still up afterwards does not count as a fresh gesture.
    pub fn reset(&mut self) {
        self.run = None;
    }
}

impl Default for PalmHold {
    fn default() -> Self {
        Self::new(DEFAULT_HOLD, DEFAULT_GAP_TOLERANCE)
    }
}

/// Starts a session when a raised palm has been held long enough.
pub struct GestureTrigger {
    hold: Mutex<PalmHold>,
    notify: Notify,
}

impl GestureTrigger {
    pub fn new() -> Arc<Self> {
        Self::with_hold(PalmHold::default())
    }

    pub fn with_hold(hold: PalmHold) -> Arc<Self> {
        Arc::new(Self {
            hold: Mutex::new(hold),
            notify: Notify::new(),
        })
    }

    /// Feeds one observation. Fires the trigger when the hold completes.
    pub fn observe(&self, now: Instant, palm: bool) {
        if lock(&self.hold).observe(now, palm) {
            self.notify.notify_one();
        }
    }

    /// Whether a hold is in progress; see [`PalmHold::holding`].
    pub fn holding(&self) -> bool {
        lock(&self.hold).holding()
    }

    /// The length of the hold, in milliseconds.
    pub fn hold_ms(&self) -> u32 {
        u32::try_from(lock(&self.hold).hold.as_millis()).unwrap_or(u32::MAX)
    }

    /// Drops a hold in progress; see [`PalmHold::reset`].
    pub fn reset(&self) {
        lock(&self.hold).reset();
    }
}

#[async_trait]
impl StartTrigger for GestureTrigger {
    fn name(&self) -> &'static str {
        "gesture"
    }

    async fn fired(&self) {
        self.notify.notified().await;
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Samples the newest live-view frame, looks for a palm in `region()` and feeds `trigger`, until
/// the frame source is dropped. Frames are taken one at a time and never queued, so a slow
/// detector lowers the sampling rate instead of building latency. What the UI should show goes
/// to `updates` after every sample.
///
/// While `active` returns `false` (not on the attract screen, gestures switched off) frames
/// are ignored and any hold in progress is dropped. A detector error counts as "no palm": a
/// flaky detector must not start sessions, and a hold that was broken restarts.
pub async fn run_sampler(
    mut frames: watch::Receiver<Option<Bytes>>,
    detector: Arc<dyn PalmDetector>,
    trigger: Arc<GestureTrigger>,
    updates: Arc<watch::Sender<GestureUpdate>>,
    active: impl Fn() -> bool + Send + 'static,
    region: impl Fn() -> Region + Send + 'static,
) {
    let idle = GestureUpdate {
        palm: None,
        holding: false,
        hold_ms: trigger.hold_ms(),
    };
    while frames.changed().await.is_ok() {
        let Some(frame) = frames.borrow_and_update().clone() else {
            continue;
        };
        if !active() {
            trigger.reset();
            updates.send_if_modified(|current| {
                let changed = *current != idle;
                *current = idle;
                changed
            });
            continue;
        }
        let within = region();
        let palm = match detector.find_palm(frame, within).await {
            // The detector is told to look only in the box, but what counts is that the palm
            // itself is there.
            Ok(Some(found)) => {
                let (cx, cy) = found.center();
                within.contains(cx, cy).then_some(found)
            }
            Ok(None) => None,
            Err(err) => {
                tracing::warn!(%err, "gesture detection failed");
                None
            }
        };
        trigger.observe(tokio::time::Instant::now().into_std(), palm.is_some());
        updates.send_replace(GestureUpdate {
            palm,
            holding: trigger.holding(),
            hold_ms: idle.hold_ms,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOLD: Duration = Duration::from_millis(800);
    const GAP: Duration = Duration::from_millis(250);

    fn hold() -> PalmHold {
        PalmHold::new(HOLD, GAP)
    }

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    /// Feeds `palm` every `step` ms from `from` to `to` inclusive; returns the first firing time.
    fn feed(
        h: &mut PalmHold,
        base: Instant,
        from: u64,
        to: u64,
        step: u64,
        palm: bool,
    ) -> Option<u64> {
        (from..=to)
            .step_by(step as usize)
            .find(|&t| h.observe(ms(base, t), palm))
    }

    #[test]
    fn fires_once_the_palm_has_been_held_long_enough() {
        let base = Instant::now();
        let mut h = hold();
        assert_eq!(feed(&mut h, base, 0, 2_000, 100, true), Some(800));
    }

    #[test]
    fn does_not_fire_before_the_hold_completes() {
        let base = Instant::now();
        let mut h = hold();
        assert_eq!(feed(&mut h, base, 0, 700, 100, true), None);
        assert!(h.holding());
    }

    #[test]
    fn a_dropped_frame_inside_the_tolerance_keeps_the_run() {
        let base = Instant::now();
        let mut h = hold();
        assert_eq!(feed(&mut h, base, 0, 300, 100, true), None);
        assert!(!h.observe(ms(base, 400), false)); // 100 ms after the last sighting
        assert!(h.holding(), "the ring keeps going through a flicker");
        assert_eq!(feed(&mut h, base, 500, 1_200, 100, true), Some(800)); // back after 200 ms
    }

    #[test]
    fn a_gap_longer_than_the_tolerance_restarts_the_hold() {
        let base = Instant::now();
        let mut h = hold();
        assert_eq!(feed(&mut h, base, 0, 700, 100, true), None);
        assert!(!h.observe(ms(base, 800), false));
        assert!(!h.observe(ms(base, 1_000), false)); // 300 ms after the last sighting: broken
        assert!(!h.holding());
        // The next palm starts a fresh run, so 800 ms more are needed, not 100.
        assert_eq!(feed(&mut h, base, 1_100, 3_000, 100, true), Some(1_900));
    }

    #[test]
    fn a_sighting_after_a_long_gap_starts_a_fresh_run_without_a_miss_in_between() {
        let base = Instant::now();
        let mut h = hold();
        assert!(!h.observe(base, true));
        // No observation for a second, then a palm: the old run must not count.
        assert!(!h.observe(ms(base, 1_000), true));
        assert_eq!(feed(&mut h, base, 1_100, 3_000, 100, true), Some(1_800));
    }

    #[test]
    fn a_raised_hand_does_not_fire_twice() {
        let base = Instant::now();
        let mut h = hold();
        assert_eq!(feed(&mut h, base, 0, 800, 100, true), Some(800));
        // Hand stays up for seconds: no second firing.
        assert_eq!(feed(&mut h, base, 900, 5_000, 100, true), None);
    }

    #[test]
    fn firing_again_needs_the_palm_to_go_away_first() {
        let base = Instant::now();
        let mut h = hold();
        assert_eq!(feed(&mut h, base, 0, 800, 100, true), Some(800));
        assert_eq!(feed(&mut h, base, 900, 1_500, 100, false), None);
        assert_eq!(feed(&mut h, base, 1_600, 3_000, 100, true), Some(2_400));
    }

    #[test]
    fn reset_drops_a_run_in_progress_but_not_the_latch() {
        let base = Instant::now();
        let mut h = hold();
        assert_eq!(feed(&mut h, base, 0, 500, 100, true), None);
        h.reset();
        assert_eq!(feed(&mut h, base, 600, 1_300, 100, true), None); // restarted: 700 ms only
        assert!(h.observe(ms(base, 1_400), true));
        h.reset();
        assert_eq!(feed(&mut h, base, 1_500, 4_000, 100, true), None); // still latched
    }

    #[tokio::test]
    async fn the_trigger_fires_when_the_hold_completes() {
        let trigger = GestureTrigger::with_hold(hold());
        let base = Instant::now();
        for t in (0..=800).step_by(100) {
            trigger.observe(ms(base, t), true);
        }
        tokio::time::timeout(Duration::from_secs(1), trigger.fired())
            .await
            .expect("the trigger fired");
        assert_eq!(trigger.name(), "gesture");
    }

    /// Answers from a script; an exhausted script means "no palm".
    struct Scripted(Mutex<Vec<Result<Option<Region>, DetectorError>>>);

    #[async_trait]
    impl PalmDetector for Scripted {
        async fn find_palm(
            &self,
            _jpeg: Bytes,
            _within: Region,
        ) -> Result<Option<Region>, DetectorError> {
            let mut script = lock(&self.0);
            if script.is_empty() {
                Ok(None)
            } else {
                script.remove(0)
            }
        }
    }

    const BOX: Region = Region {
        x: 0.4,
        y: 0.2,
        w: 0.4,
        h: 0.6,
    };

    fn palm_in_box() -> Result<Option<Region>, DetectorError> {
        Ok(Some(Region {
            x: 0.5,
            y: 0.3,
            w: 0.2,
            h: 0.3,
        }))
    }

    struct Rig {
        frames: watch::Sender<Option<Bytes>>,
        trigger: Arc<GestureTrigger>,
        updates: watch::Receiver<GestureUpdate>,
        task: tokio::task::JoinHandle<()>,
    }

    fn rig(script: Vec<Result<Option<Region>, DetectorError>>, hold_ms: u64, active: bool) -> Rig {
        let (frames, rx) = watch::channel(None);
        let trigger = GestureTrigger::with_hold(PalmHold::new(
            Duration::from_millis(hold_ms),
            Duration::from_millis(250),
        ));
        let (updates_tx, updates_rx) = watch::channel(GestureUpdate {
            palm: None,
            holding: false,
            hold_ms: 0,
        });
        let task = tokio::spawn(run_sampler(
            rx,
            Arc::new(Scripted(Mutex::new(script))),
            trigger.clone(),
            Arc::new(updates_tx),
            move || active,
            || BOX,
        ));
        Rig {
            frames,
            trigger,
            updates: updates_rx,
            task,
        }
    }

    async fn feed_frames(rig: &Rig, n: usize) {
        for _ in 0..n {
            rig.frames
                .send(Some(Bytes::from_static(&[0xFF, 0xD8])))
                .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_sampler_starts_a_session_after_a_held_palm() {
        let rig = rig(vec![palm_in_box(); 20], 300, true);
        let fired = tokio::spawn({
            let trigger = rig.trigger.clone();
            async move { trigger.fired().await }
        });
        feed_frames(&rig, 10).await;
        tokio::time::timeout(Duration::from_secs(1), fired)
            .await
            .expect("fired in time")
            .expect("task");
        rig.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn the_sampler_ignores_frames_while_inactive() {
        let rig = rig(vec![palm_in_box(); 20], 100, false);
        feed_frames(&rig, 10).await;
        let waited = tokio::time::timeout(Duration::from_millis(50), rig.trigger.fired()).await;
        assert!(waited.is_err(), "an inactive sampler never fires");
        assert_eq!(rig.updates.borrow().palm, None);
        rig.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_detector_error_counts_as_no_palm() {
        let mut script = vec![
            palm_in_box(),
            palm_in_box(),
            Err(DetectorError("boom".into())),
        ];
        script.extend(vec![palm_in_box(); 8]);
        let rig = rig(script, 300, true);
        let fired = tokio::spawn({
            let trigger = rig.trigger.clone();
            async move { trigger.fired().await }
        });
        feed_frames(&rig, 11).await;
        tokio::time::timeout(Duration::from_secs(1), fired)
            .await
            .expect("a single error does not break the hold")
            .expect("task");
        rig.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_palm_outside_the_box_does_not_count() {
        let outside = Ok(Some(Region {
            x: 0.0,
            y: 0.0,
            w: 0.2,
            h: 0.2,
        }));
        let rig = rig(vec![outside; 20], 100, true);
        feed_frames(&rig, 10).await;
        let waited = tokio::time::timeout(Duration::from_millis(50), rig.trigger.fired()).await;
        assert!(waited.is_err());
        let update = *rig.updates.borrow();
        assert_eq!(update.palm, None);
        assert!(!update.holding);
        rig.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn the_ui_sees_the_palm_and_the_hold_progress() {
        let rig = rig(vec![palm_in_box(); 3], 1000, true);
        feed_frames(&rig, 3).await;
        let update = *rig.updates.borrow();
        assert!(update.palm.is_some(), "the palm is highlighted");
        assert!(update.holding, "the ring is running");
        assert_eq!(update.hold_ms, 1000);
        feed_frames(&rig, 6).await; // the palm is gone for longer than the tolerance
        let update = *rig.updates.borrow();
        assert_eq!(update.palm, None);
        assert!(!update.holding, "the ring resets when the palm is lost");
        rig.task.abort();
    }

    #[test]
    fn regions_validate_and_grow_within_the_frame() {
        assert!(
            Region::new(0.5, 0.5, 0.6, 0.2).is_none(),
            "spills out of the frame"
        );
        assert!(Region::new(0.1, 0.1, 0.0, 0.2).is_none(), "empty");
        assert!(Region::new(f32::NAN, 0.1, 0.2, 0.2).is_none());
        let r = Region::new(0.7, 0.2, 0.3, 0.4).unwrap();
        let grown = r.grown(0.5);
        assert!((grown.x - 0.55).abs() < 1e-5 && (grown.x + grown.w - 1.0).abs() < 1e-5);
        assert!(r.contains(0.8, 0.3) && !r.contains(0.5, 0.3));
    }
}
