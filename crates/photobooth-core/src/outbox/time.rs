//! Wall-clock helpers without a date crate: records store Unix milliseconds, and the portal
//! contract wants `toISOString()` form (UTC, exactly three fractional digits, `Z`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch; times before it count as the epoch.
pub fn to_unix_millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub fn from_unix_millis(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

/// Drops sub-millisecond precision, so a time survives a round trip through a record.
pub fn truncate_to_millis(t: SystemTime) -> SystemTime {
    from_unix_millis(to_unix_millis(t))
}

/// `2026-10-22T09:30:12.345Z`.
pub fn iso_millis(t: SystemTime) -> String {
    let ms = to_unix_millis(t);
    let (days, ms_of_day) = (ms / 86_400_000, ms % 86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (secs, millis) = (ms_of_day / 1000, ms_of_day % 1000);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm,
/// restricted to non-negative days).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

/// `#[serde(with = "unix_millis")]` for `SystemTime` fields.
pub(crate) mod unix_millis {
    use std::time::SystemTime;

    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(t: &SystemTime, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(super::to_unix_millis(*t))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<SystemTime, D::Error> {
        u64::deserialize(d).map(super::from_unix_millis)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_the_contract_fixture_form() {
        // capturedAt in apps/portal/contract/fixtures/device.intent-request.valid.json.
        assert_eq!(
            iso_millis(from_unix_millis(1_792_661_412_345)),
            "2026-10-22T09:30:12.345Z"
        );
        assert_eq!(iso_millis(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_millis(from_unix_millis(951_782_400_000)),
            "2000-02-29T00:00:00.000Z",
            "leap day"
        );
        assert_eq!(
            iso_millis(from_unix_millis(4_102_444_799_999)),
            "2099-12-31T23:59:59.999Z"
        );
    }

    #[test]
    fn iso_always_has_three_fractional_digits() {
        assert_eq!(
            iso_millis(from_unix_millis(1_792_661_412_000)),
            "2026-10-22T09:30:12.000Z"
        );
        assert_eq!(
            iso_millis(from_unix_millis(1_792_661_412_005)),
            "2026-10-22T09:30:12.005Z"
        );
    }

    #[test]
    fn times_before_the_epoch_clamp_to_it() {
        let before = UNIX_EPOCH - Duration::from_secs(5);
        assert_eq!(to_unix_millis(before), 0);
    }

    #[test]
    fn truncation_drops_sub_millisecond_precision() {
        let t = from_unix_millis(1_000) + Duration::from_micros(999);
        assert_eq!(truncate_to_millis(t), from_unix_millis(1_000));
    }
}
