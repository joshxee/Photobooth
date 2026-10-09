//! The seam through which a session is started from the attract screen. A future
//! `GestureTrigger` (open-palm detection) plugs in here without touching the session.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Notify;

/// Something that can start a session. The session runs one forwarding task per registered
/// trigger and leaves `Attract` when any of them fires.
#[async_trait]
pub trait StartTrigger: Send + Sync + 'static {
    /// Short identifier for logs.
    fn name(&self) -> &'static str;
    /// Completes each time the trigger fires. The session calls this in a loop.
    async fn fired(&self);
}

/// Fired when a guest taps the attract screen.
#[derive(Default)]
pub struct TapTrigger {
    notify: Notify,
}

impl TapTrigger {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn fire(&self) {
        self.notify.notify_one();
    }
}

#[async_trait]
impl StartTrigger for TapTrigger {
    fn name(&self) -> &'static str {
        "tap"
    }

    async fn fired(&self) {
        self.notify.notified().await;
    }
}

/// Fired from the developer panel (test mode), independent of the guest-facing trigger.
#[derive(Default)]
pub struct DevPanelTrigger {
    notify: Notify,
}

impl DevPanelTrigger {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn fire(&self) {
        self.notify.notify_one();
    }
}

#[async_trait]
impl StartTrigger for DevPanelTrigger {
    fn name(&self) -> &'static str {
        "dev_panel"
    }

    async fn fired(&self) {
        self.notify.notified().await;
    }
}
