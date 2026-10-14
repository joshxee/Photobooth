//! Persistent app settings: a JSON file with validated ranges and atomic saves.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::camera::CameraId;

/// How a guest starts a session from the attract screen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartTriggerKind {
    #[default]
    Tap,
    /// A raised open palm also starts a session. The tap button keeps working.
    Gesture,
}

/// Names accepted for [`TestModeSettings::pattern`].
pub const TEST_PATTERNS: [&str; 3] = ["bars", "checker", "gradient"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TestModeSettings {
    /// How long a mock capture takes.
    pub capture_delay_ms: u32,
    /// Every Nth capture fails; 0 disables.
    pub fail_every_n: u32,
    /// Image pattern of mock captures; one of [`TEST_PATTERNS`].
    pub pattern: String,
}

impl Default for TestModeSettings {
    fn default() -> Self {
        Self {
            capture_delay_ms: 300,
            fail_every_n: 0,
            pattern: "bars".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub selected_camera: CameraId,
    pub number_of_photos: u8,
    pub countdown_seconds: u8,
    pub strip_display_seconds: u8,
    pub headline: String,
    pub event_date: String,
    pub mirror_preview: bool,
    pub start_trigger: StartTriggerKind,
    pub test_mode: TestModeSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            selected_camera: CameraId::DEVICE,
            number_of_photos: 3,
            countdown_seconds: 3,
            strip_display_seconds: 12,
            headline: "Sarah & Tom's Wedding".to_owned(),
            event_date: "06.05.2026".to_owned(),
            mirror_preview: true,
            start_trigger: StartTriggerKind::Tap,
            test_mode: TestModeSettings::default(),
        }
    }
}

/// A partial update. Absent fields are left unchanged; unknown fields are rejected so a
/// typo from the UI is an error instead of a silent no-op.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SettingsPatch {
    pub selected_camera: Option<CameraId>,
    pub number_of_photos: Option<u8>,
    pub countdown_seconds: Option<u8>,
    pub strip_display_seconds: Option<u8>,
    pub headline: Option<String>,
    pub event_date: Option<String>,
    pub mirror_preview: Option<bool>,
    pub start_trigger: Option<StartTriggerKind>,
    pub test_mode: Option<TestModePatch>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TestModePatch {
    pub capture_delay_ms: Option<u32>,
    pub fail_every_n: Option<u32>,
    pub pattern: Option<String>,
}

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("{field} must be between {min} and {max} (got {got})")]
    OutOfRange {
        field: &'static str,
        min: u32,
        max: u32,
        got: u32,
    },
    #[error("{field}: {reason}")]
    Invalid { field: &'static str, reason: String },
    #[error("settings file I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("settings file is not valid JSON: {0}")]
    Parse(#[from] serde_json::Error),
}

fn check_range(field: &'static str, got: u32, min: u32, max: u32) -> Result<(), SettingsError> {
    if (min..=max).contains(&got) {
        Ok(())
    } else {
        Err(SettingsError::OutOfRange {
            field,
            min,
            max,
            got,
        })
    }
}

fn check_text(field: &'static str, value: &str, max_chars: usize) -> Result<(), SettingsError> {
    if value.chars().count() > max_chars {
        return Err(SettingsError::Invalid {
            field,
            reason: format!("must be at most {max_chars} characters"),
        });
    }
    if value.chars().any(char::is_control) {
        return Err(SettingsError::Invalid {
            field,
            reason: "must not contain control characters".to_owned(),
        });
    }
    Ok(())
}

impl Settings {
    pub fn validate(&self) -> Result<(), SettingsError> {
        check_range("number_of_photos", self.number_of_photos.into(), 1, 10)?;
        check_range("countdown_seconds", self.countdown_seconds.into(), 1, 10)?;
        check_range(
            "strip_display_seconds",
            self.strip_display_seconds.into(),
            5,
            30,
        )?;
        check_text("headline", &self.headline, 80)?;
        check_text("event_date", &self.event_date, 32)?;
        check_text("selected_camera", self.selected_camera.as_str(), 64)?;
        if self.selected_camera.as_str().is_empty() {
            return Err(SettingsError::Invalid {
                field: "selected_camera",
                reason: "must not be empty".to_owned(),
            });
        }
        check_range(
            "test_mode.capture_delay_ms",
            self.test_mode.capture_delay_ms,
            0,
            30_000,
        )?;
        check_range(
            "test_mode.fail_every_n",
            self.test_mode.fail_every_n,
            0,
            1000,
        )?;
        if !TEST_PATTERNS.contains(&self.test_mode.pattern.as_str()) {
            return Err(SettingsError::Invalid {
                field: "test_mode.pattern",
                reason: format!("must be one of {}", TEST_PATTERNS.join(", ")),
            });
        }
        Ok(())
    }

    /// Merges `patch` and validates the result. `self` is only modified on success.
    pub fn patch(&mut self, patch: SettingsPatch) -> Result<(), SettingsError> {
        let mut next = self.clone();
        if let Some(v) = patch.selected_camera {
            next.selected_camera = v;
        }
        if let Some(v) = patch.number_of_photos {
            next.number_of_photos = v;
        }
        if let Some(v) = patch.countdown_seconds {
            next.countdown_seconds = v;
        }
        if let Some(v) = patch.strip_display_seconds {
            next.strip_display_seconds = v;
        }
        if let Some(v) = patch.headline {
            next.headline = v;
        }
        if let Some(v) = patch.event_date {
            next.event_date = v;
        }
        if let Some(v) = patch.mirror_preview {
            next.mirror_preview = v;
        }
        if let Some(v) = patch.start_trigger {
            next.start_trigger = v;
        }
        if let Some(t) = patch.test_mode {
            if let Some(v) = t.capture_delay_ms {
                next.test_mode.capture_delay_ms = v;
            }
            if let Some(v) = t.fail_every_n {
                next.test_mode.fail_every_n = v;
            }
            if let Some(v) = t.pattern {
                next.test_mode.pattern = v;
            }
        }
        next.validate()?;
        *self = next;
        Ok(())
    }
}

/// Reads and writes [`Settings`] at a fixed path.
#[derive(Clone, Debug)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads the file; a missing file yields defaults. A present but invalid file is an
    /// error — callers decide whether to fall back (see [`Self::load_or_default`]).
    pub fn load(&self) -> Result<Settings, SettingsError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Settings::default()),
            Err(e) => return Err(e.into()),
        };
        let settings: Settings = serde_json::from_slice(&bytes)?;
        settings.validate()?;
        Ok(settings)
    }

    /// Like [`Self::load`] but never fails: an unreadable or invalid file is replaced in
    /// memory by defaults (the bad file is left in place for inspection until the next save)
    /// and the problem is logged. A kiosk must come up even with a damaged settings file.
    pub fn load_or_default(&self) -> Settings {
        match self.load() {
            Ok(settings) => settings,
            Err(err) => {
                tracing::warn!(path = %self.path.display(), %err, "settings unreadable; using defaults");
                Settings::default()
            }
        }
    }

    /// Validates, then writes to a temp file in the same directory and renames it over the
    /// target, so a crash mid-write never leaves a truncated settings file.
    pub fn save(&self, settings: &Settings) -> Result<(), SettingsError> {
        settings.validate()?;
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let json = serde_json::to_vec_pretty(settings)?;
        {
            let mut file = fs::File::create(&tmp)?;
            file.write_all(&json)?;
            file.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch_json(json: &str) -> SettingsPatch {
        serde_json::from_str(json).expect("valid patch json")
    }

    #[test]
    fn defaults_are_valid_and_match_spec() {
        let s = Settings::default();
        s.validate().unwrap();
        assert_eq!(s.number_of_photos, 3);
        assert_eq!(s.countdown_seconds, 3);
        assert_eq!(s.strip_display_seconds, 12);
        assert!(s.mirror_preview);
        assert_eq!(s.start_trigger, StartTriggerKind::Tap);
    }

    #[test]
    fn range_boundaries_are_inclusive() {
        for (n, ok) in [(0u8, false), (1, true), (10, true), (11, false)] {
            let s = Settings {
                number_of_photos: n,
                ..Settings::default()
            };
            assert_eq!(s.validate().is_ok(), ok, "number_of_photos={n}");
        }
        for (n, ok) in [(0u8, false), (1, true), (10, true), (11, false)] {
            let s = Settings {
                countdown_seconds: n,
                ..Settings::default()
            };
            assert_eq!(s.validate().is_ok(), ok, "countdown_seconds={n}");
        }
        for (n, ok) in [(4u8, false), (5, true), (30, true), (31, false)] {
            let s = Settings {
                strip_display_seconds: n,
                ..Settings::default()
            };
            assert_eq!(s.validate().is_ok(), ok, "strip_display_seconds={n}");
        }
    }

    #[test]
    fn gesture_trigger_is_accepted() {
        let s = Settings {
            start_trigger: StartTriggerKind::Gesture,
            ..Settings::default()
        };
        assert!(s.validate().is_ok());
    }

    #[test]
    fn unknown_test_pattern_is_rejected() {
        let mut s = Settings::default();
        s.test_mode.pattern = "plaid".to_owned();
        assert!(s.validate().is_err());
    }

    #[test]
    fn patch_merges_only_provided_fields() {
        let mut s = Settings::default();
        s.patch(patch_json(
            r#"{"headline":"Ada's Party","test_mode":{"fail_every_n":4}}"#,
        ))
        .unwrap();
        assert_eq!(s.headline, "Ada's Party");
        assert_eq!(s.test_mode.fail_every_n, 4);
        assert_eq!(s.test_mode.capture_delay_ms, 300, "untouched nested field");
        assert_eq!(s.number_of_photos, 3, "untouched field");
    }

    #[test]
    fn invalid_patch_leaves_settings_unchanged() {
        let mut s = Settings::default();
        let before = s.clone();
        let err = s
            .patch(patch_json(r#"{"headline":"ok","number_of_photos":99}"#))
            .unwrap_err();
        assert!(matches!(err, SettingsError::OutOfRange { .. }));
        assert_eq!(
            s, before,
            "headline must not be applied when another field is invalid"
        );
    }

    #[test]
    fn patch_rejects_unknown_fields() {
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"headlin":"typo"}"#).is_err());
    }

    #[test]
    fn control_characters_in_text_are_rejected() {
        let mut s = Settings::default();
        let err = s
            .patch(SettingsPatch {
                headline: Some("bad\nline".to_owned()),
                ..SettingsPatch::default()
            })
            .unwrap_err();
        assert!(matches!(err, SettingsError::Invalid { .. }));
    }

    #[test]
    fn json_shape_uses_snake_case_ids_and_triggers() {
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["selected_camera"], "device");
        assert_eq!(json["start_trigger"], "tap");
        assert_eq!(json["test_mode"]["pattern"], "bars");
    }

    #[test]
    fn missing_fields_in_file_fall_back_to_defaults() {
        let s: Settings = serde_json::from_str(r#"{"headline":"Only this"}"#).unwrap();
        assert_eq!(s.headline, "Only this");
        assert_eq!(s.number_of_photos, 3);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join("nested").join("settings.json"));
        let mut s = Settings::default();
        s.patch(patch_json(
            r#"{"selected_camera":"test","countdown_seconds":5}"#,
        ))
        .unwrap();
        store.save(&s).unwrap();
        assert_eq!(store.load().unwrap(), s);
        assert!(
            !store.path().with_extension("json.tmp").exists(),
            "temp file must be renamed away"
        );
    }

    #[test]
    fn save_overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join("settings.json"));
        store.save(&Settings::default()).unwrap();
        let next = Settings {
            headline: "Second".to_owned(),
            ..Settings::default()
        };
        store.save(&next).unwrap();
        assert_eq!(store.load().unwrap().headline, "Second");
    }

    #[test]
    fn save_refuses_invalid_settings_and_keeps_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join("settings.json"));
        store.save(&Settings::default()).unwrap();
        let bad = Settings {
            number_of_photos: 0,
            ..Settings::default()
        };
        assert!(store.save(&bad).is_err());
        assert_eq!(store.load().unwrap(), Settings::default());
    }

    #[test]
    fn missing_file_loads_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join("absent.json"));
        assert_eq!(store.load().unwrap(), Settings::default());
    }

    #[test]
    fn corrupt_file_is_an_error_but_load_or_default_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"{ not json").unwrap();
        let store = SettingsStore::new(&path);
        assert!(matches!(store.load(), Err(SettingsError::Parse(_))));
        assert_eq!(store.load_or_default(), Settings::default());
    }

    #[test]
    fn out_of_range_file_is_rejected_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, br#"{"number_of_photos":200}"#).unwrap();
        assert!(SettingsStore::new(&path).load().is_err());
    }
}
