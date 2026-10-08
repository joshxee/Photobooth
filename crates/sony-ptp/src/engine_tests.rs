//! End-to-end tests of the engine against the simulated camera, plus record/replay.

use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::codes::{op, prop, rc};
use crate::container::{encode_data, encode_response};
use crate::error::Error;
use crate::ptp::{Ptp, Timeouts};
use crate::sim::{Fault, SimConfig, SimHandle, SimTransport};
use crate::sony::{Sony, SonyConfig};
use crate::transport::{RecordingTransport, ReplayTransport, Transcript, Transport};

fn engine(cfg: SimConfig) -> (Sony<SimTransport>, SimHandle) {
    let (transport, handle) = SimTransport::new(cfg);
    (Sony::new(transport, SonyConfig::no_delays()), handle)
}

fn connected(cfg: SimConfig) -> (Sony<SimTransport>, SimHandle) {
    let (mut sony, handle) = engine(cfg);
    sony.connect().expect("handshake succeeds");
    (sony, handle)
}

const DOWN: u16 = 2;
const UP: u16 = 1;

// ----- handshake ------------------------------------------------------------------------

#[test]
fn handshake_runs_the_documented_sequence_with_correct_transaction_ids() {
    let (mut sony, sim) = engine(SimConfig {
        ext_info_empty_replies: 3,
        ..SimConfig::default()
    });
    let info = sony.connect().unwrap().clone();
    assert_eq!(info.model, "ILCE-7M3");
    assert_eq!(info.manufacturer, "Sony Corporation");
    assert!(sony.is_connected());

    let ops = sim.ops();
    let seq: Vec<(u16, Vec<u32>)> = ops.iter().map(|r| (r.op, r.params.clone())).collect();
    assert_eq!(
        seq,
        vec![
            (op::GET_DEVICE_INFO, vec![]),
            (op::OPEN_SESSION, vec![1]),
            (op::SDIO_CONNECT, vec![1, 0, 0]),
            (op::SDIO_CONNECT, vec![2, 0, 0]),
            // three empty answers, then the fourth succeeds
            (op::SDIO_GET_EXT_DEVICE_INFO, vec![0xC8]),
            (op::SDIO_GET_EXT_DEVICE_INFO, vec![0xC8]),
            (op::SDIO_GET_EXT_DEVICE_INFO, vec![0xC8]),
            (op::SDIO_GET_EXT_DEVICE_INFO, vec![0xC8]),
            (op::SDIO_CONNECT, vec![3, 0, 0]),
        ]
    );
    // Session-less operations use transaction id 0; in-session ids count up from 1.
    let txids: Vec<u32> = ops.iter().map(|r| r.txid).collect();
    assert_eq!(txids, vec![0, 0, 1, 2, 3, 4, 5, 6, 7]);
}

#[test]
fn camera_in_the_wrong_usb_mode_gets_a_pc_remote_hint() {
    let (mut sony, _) = engine(SimConfig {
        pc_remote: false,
        ..SimConfig::default()
    });
    let err = sony.connect().unwrap_err();
    assert!(
        matches!(&err, Error::Protocol(m) if m.contains("PC Remote")),
        "got {err}"
    );
    assert!(!sony.is_connected());
}

#[test]
fn a_stalled_camera_reports_a_timeout_that_suggests_the_usb_mode() {
    let (mut sony, _) = engine(SimConfig {
        faults: vec![Fault::Stall {
            op: op::GET_DEVICE_INFO,
            nth: 1,
        }],
        ..SimConfig::default()
    });
    let err = sony.connect().unwrap_err();
    assert!(matches!(err, Error::Timeout(_)), "got {err}");
    assert!(err.suggests_wrong_usb_mode());
}

#[test]
fn handshake_gives_up_if_extended_info_never_arrives() {
    let (mut sony, sim) = engine(SimConfig {
        ext_info_empty_replies: 1_000,
        ..SimConfig::default()
    });
    let err = sony.connect().unwrap_err();
    assert!(matches!(err, Error::Timeout(_)), "got {err}");
    // 1 initial attempt + 20 retries.
    assert_eq!(sim.count(op::SDIO_GET_EXT_DEVICE_INFO), 21);
    assert_eq!(sim.count(op::SDIO_CONNECT), 2, "phase 3 is never reached");
}

#[test]
fn connecting_twice_closes_and_reopens_the_session() {
    let (mut sony, sim) = connected(SimConfig::default());
    sony.connect().expect("reconnect works");
    assert_eq!(sim.count(op::CLOSE_SESSION), 1);
    assert_eq!(sim.count(op::OPEN_SESSION), 3, "open, rejected, reopened");
    assert!(sony.is_connected());
}

#[test]
fn disconnect_closes_the_session() {
    let (mut sony, sim) = connected(SimConfig::default());
    sony.disconnect().unwrap();
    assert!(!sony.is_connected());
    assert!(!sim.session_open());
    assert!(matches!(sony.capture(), Err(Error::NotConnected)));
}

#[test]
fn operations_require_a_connection() {
    let (mut sony, _) = engine(SimConfig::default());
    assert!(matches!(sony.capture(), Err(Error::NotConnected)));
    assert!(matches!(sony.live_frame(), Err(Error::NotConnected)));
    assert!(matches!(
        sony.wait_for_live_view(),
        Err(Error::NotConnected)
    ));
}

// ----- capture --------------------------------------------------------------------------

#[test]
fn capture_presses_s1_then_s2_and_releases_s2_before_s1() {
    let (mut sony, sim) = connected(SimConfig::default());
    let photo = sony.capture().unwrap();

    assert_eq!(
        sim.shutter_log(),
        vec![
            (prop::SHUTTER_HALF, DOWN),
            (prop::SHUTTER_FULL, DOWN),
            (prop::SHUTTER_FULL, UP),
            (prop::SHUTTER_HALF, UP),
        ]
    );
    assert!(!sim.shutter_held());
    assert_eq!(sim.exposures(), 1);

    assert!(photo.jpeg.starts_with(&[0xFF, 0xD8]) && photo.jpeg.ends_with(&[0xFF, 0xD9]));
    assert_eq!(photo.jpeg.len(), 3_000 + 4);
    assert_eq!((photo.width, photo.height), (6000, 4000));
    assert_eq!(photo.filename, "DSC00001.JPG");
}

#[test]
fn consecutive_captures_return_distinct_images() {
    let (mut sony, sim) = connected(SimConfig::default());
    let a = sony.capture().unwrap();
    let b = sony.capture().unwrap();
    assert_ne!(a.jpeg, b.jpeg);
    assert_eq!(a.filename, "DSC00001.JPG");
    assert_eq!(b.filename, "DSC00002.JPG");
    assert_eq!(sim.exposures(), 2);
}

#[test]
fn large_images_are_reassembled_across_many_usb_transfers() {
    for max_transfer in [64, 511, 512, 1000, 4096] {
        let (mut sony, _) = connected(SimConfig {
            jpeg_payload_len: 100_000,
            max_transfer,
            ..SimConfig::default()
        });
        let photo = sony.capture().unwrap();
        assert_eq!(photo.jpeg.len(), 100_004, "max_transfer={max_transfer}");
    }
}

#[test]
fn capture_works_by_polling_alone_when_no_event_arrives() {
    let (mut sony, _) = connected(SimConfig {
        send_object_added_event: false,
        image_ready_after_polls: 5,
        ..SimConfig::default()
    });
    sony.capture().expect("polling ObjectInMemory is enough");
}

#[test]
fn capture_falls_back_to_get_device_prop_value_when_the_dataset_op_is_missing() {
    let (mut sony, sim) = connected(SimConfig {
        props_via_ext_info: false,
        send_object_added_event: false,
        ..SimConfig::default()
    });
    sony.capture().unwrap();
    assert!(sim.count(op::GET_DEVICE_PROP_VALUE) > 0);
    // After the first fallback the engine remembers and stops trying the dataset op.
    let tried = sim.count(op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO);
    sony.capture().unwrap();
    assert_eq!(sim.count(op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO), tried);
}

#[test]
fn raw_companion_is_consumed_and_discarded() {
    let (mut sony, sim) = connected(SimConfig {
        raw_plus_jpeg: true,
        ..SimConfig::default()
    });
    let photo = sony.capture().unwrap();
    assert_eq!(photo.filename, "DSC00001.JPG");
    assert_eq!(photo.jpeg.len(), 3_004);
    assert_eq!(sim.count(op::GET_OBJECT), 2, "RAW then JPEG");
}

#[test]
fn big_objects_are_downloaded_in_chunks() {
    let (mut sony, sim) = connected(SimConfig {
        jpeg_payload_len: 3_000,
        ..SimConfig::default()
    });
    // Shrink the thresholds so the 3 KB test image counts as "large".
    let mut cfg = SonyConfig::no_delays();
    cfg.chunk_threshold = 2_000;
    cfg.chunk_size = 1_000;
    let (transport, sim2) = SimTransport::new(SimConfig::default());
    let mut chunked = Sony::new(transport, cfg);
    chunked.connect().unwrap();
    let photo = chunked.capture().unwrap();

    assert_eq!(photo.jpeg.len(), 3_004);
    assert_eq!(sim2.chunk_requests(), 4, "1000 + 1000 + 1000 + 4 bytes");
    assert_eq!(
        sim2.count(op::GET_OBJECT),
        0,
        "never used the whole-object path"
    );
    // Same bytes as the non-chunked path.
    let plain = sony.capture().unwrap();
    assert_eq!(plain.jpeg.len(), photo.jpeg.len());
    assert_eq!(sim.chunk_requests(), 0);
}

#[test]
fn chunk_requests_split_the_offset_into_low_and_high_words() {
    let mut cfg = SonyConfig::no_delays();
    cfg.chunk_threshold = 1;
    cfg.chunk_size = 2_000;
    let (transport, sim) = SimTransport::new(SimConfig::default());
    let mut sony = Sony::new(transport, cfg);
    sony.connect().unwrap();
    sony.capture().unwrap();
    let requests: Vec<_> = sim
        .ops()
        .into_iter()
        .filter(|r| r.op == op::SDIO_GET_PARTIAL_LARGE_OBJECT)
        .collect();
    assert_eq!(requests[0].params, vec![0xFFFF_C001, 0, 0, 2_000]);
    assert_eq!(requests[1].params, vec![0xFFFF_C001, 2_000, 0, 1_004]);
}

#[test]
fn chunked_download_falls_back_when_the_camera_does_not_support_it() {
    let mut cfg = SonyConfig::no_delays();
    cfg.chunk_threshold = 1_000;
    let (transport, sim) = SimTransport::new(SimConfig {
        chunked_download_supported: false,
        ..SimConfig::default()
    });
    let mut sony = Sony::new(transport, cfg);
    sony.connect().unwrap();
    let photo = sony.capture().unwrap();
    assert_eq!(photo.jpeg.len(), 3_004);
    assert_eq!(sim.count(op::GET_OBJECT), 1);
}

#[test]
fn a_busy_camera_error_is_reported_with_its_name() {
    let (mut sony, _) = connected(SimConfig {
        faults: vec![Fault::Respond {
            op: op::SDIO_CONTROL_DEVICE,
            nth: 1,
            code: rc::DEVICE_BUSY,
        }],
        ..SimConfig::default()
    });
    let err = sony.capture().unwrap_err();
    assert!(
        matches!(&err, Error::Response { code, .. } if *code == rc::DEVICE_BUSY),
        "got {err}"
    );
    assert!(err.to_string().contains("DeviceBusy"), "{err}");
}

#[test]
fn a_missing_image_times_out_and_leaves_the_shutter_released() {
    let (mut sony, sim) = connected(SimConfig {
        image_ready_after_polls: u32::MAX,
        send_object_added_event: false,
        ..SimConfig::default()
    });
    let err = sony.capture().unwrap_err();
    assert!(matches!(err, Error::Timeout(_)), "got {err}");
    assert!(!sim.shutter_held());
}

// ----- shutter safety -------------------------------------------------------------------

#[test]
fn a_failed_s2_press_still_releases_both_buttons_in_order() {
    let (mut sony, sim) = connected(SimConfig {
        faults: vec![Fault::WriteError {
            op: op::SDIO_CONTROL_DEVICE,
            nth: 2, // the S2-down command
        }],
        ..SimConfig::default()
    });
    let err = sony.capture().unwrap_err();
    assert!(matches!(err, Error::Io(_)), "got {err}");
    assert!(!sim.shutter_held());
    // S2 is released before S1.
    assert_eq!(
        sim.shutter_log(),
        vec![
            (prop::SHUTTER_HALF, DOWN),
            (prop::SHUTTER_FULL, UP),
            (prop::SHUTTER_HALF, UP),
        ]
    );
    assert_eq!(sim.exposures(), 0, "no picture was taken");
}

#[test]
fn a_failed_s1_press_still_sends_a_release() {
    let (mut sony, sim) = connected(SimConfig {
        faults: vec![Fault::WriteError {
            op: op::SDIO_CONTROL_DEVICE,
            nth: 1,
        }],
        ..SimConfig::default()
    });
    assert!(sony.shoot().is_err());
    assert_eq!(sim.shutter_log(), vec![(prop::SHUTTER_HALF, UP)]);
    assert!(!sim.shutter_held());
}

#[test]
fn a_panic_mid_sequence_still_releases_the_shutter() {
    let (mut sony, sim) = connected(SimConfig {
        faults: vec![Fault::PanicOnWrite {
            op: op::SDIO_CONTROL_DEVICE,
            nth: 2,
        }],
        ..SimConfig::default()
    });
    let result = catch_unwind(AssertUnwindSafe(|| sony.shoot()));
    assert!(result.is_err(), "the simulated transport panicked");
    assert!(!sim.shutter_held(), "the drop-guard released the shutter");
    assert_eq!(
        sim.shutter_log(),
        vec![
            (prop::SHUTTER_HALF, DOWN),
            (prop::SHUTTER_FULL, UP),
            (prop::SHUTTER_HALF, UP),
        ]
    );
}

// ----- live view ------------------------------------------------------------------------

#[test]
fn live_view_yields_valid_jpegs_after_it_becomes_active() {
    let (mut sony, _) = connected(SimConfig {
        live_view_after_polls: 2,
        ..SimConfig::default()
    });
    sony.wait_for_live_view().unwrap();
    let a = sony.live_frame().unwrap().expect("a frame");
    let b = sony.live_frame().unwrap().expect("another frame");
    for f in [&a, &b] {
        assert!(
            f.starts_with(&[0xFF, 0xD8]) && f.ends_with(&[0xFF, 0xD9]),
            "SOI/EOI stripped of Sony's envelope"
        );
        assert_eq!(f.len(), 404);
    }
    assert_ne!(a, b);
}

#[test]
fn live_frame_is_none_while_the_camera_is_not_ready() {
    let (mut sony, _) = connected(SimConfig {
        live_view_after_polls: 1_000,
        ..SimConfig::default()
    });
    assert_eq!(sony.live_frame().unwrap(), None);
    assert!(matches!(sony.wait_for_live_view(), Err(Error::Timeout(_))));
}

#[test]
fn capture_does_not_need_live_view() {
    let (mut sony, _) = connected(SimConfig {
        live_view_after_polls: 1_000_000,
        ..SimConfig::default()
    });
    sony.capture().expect("capture is independent of live view");
}

// ----- PTP layer ------------------------------------------------------------------------

/// Returns data and response containers glued together in one read, plus empty packets.
struct Glued {
    reads: Vec<Vec<u8>>,
}

impl Transport for Glued {
    fn write_bulk(&mut self, buf: &[u8], _: std::time::Duration) -> crate::Result<usize> {
        Ok(buf.len())
    }
    fn read_bulk(&mut self, buf: &mut [u8], _: std::time::Duration) -> crate::Result<usize> {
        if self.reads.is_empty() {
            return Err(Error::Timeout("bulk read"));
        }
        let next = self.reads.remove(0);
        buf[..next.len()].copy_from_slice(&next);
        Ok(next.len())
    }
    fn read_interrupt(&mut self, _: &mut [u8], _: std::time::Duration) -> crate::Result<usize> {
        Err(Error::Timeout("interrupt read"))
    }
    fn reset(&mut self) -> crate::Result<()> {
        Ok(())
    }
}

#[test]
fn ptp_handles_two_containers_in_one_read_and_empty_packets() {
    let mut both = encode_data(op::GET_OBJECT, 0, &[1, 2, 3]);
    both.extend(encode_response(rc::OK, 0, &[]));
    let mut ptp = Ptp::new(
        Glued {
            reads: vec![vec![], both],
        },
        Timeouts::default(),
    );
    let r = ptp.call(op::GET_OBJECT, &[1], None).unwrap();
    assert_eq!(r.data, vec![1, 2, 3]);
    assert!(r.is_ok());
}

#[test]
fn ptp_keeps_the_surplus_bytes_for_the_next_transaction() {
    let mut first = encode_response(rc::OK, 0, &[]);
    first.extend(encode_response(rc::DEVICE_BUSY, 0, &[]));
    let mut ptp = Ptp::new(Glued { reads: vec![first] }, Timeouts::default());
    assert!(ptp
        .transaction(op::GET_DEVICE_INFO, &[], None)
        .unwrap()
        .is_ok());
    assert_eq!(
        ptp.transaction(op::GET_DEVICE_INFO, &[], None)
            .unwrap()
            .code,
        rc::DEVICE_BUSY
    );
}

#[test]
fn ptp_rejects_garbage_lengths_and_endless_empty_packets() {
    let mut garbage = vec![0u8; 12];
    garbage[..4].copy_from_slice(&u32::MAX.to_le_bytes());
    let mut ptp = Ptp::new(
        Glued {
            reads: vec![garbage],
        },
        Timeouts::default(),
    );
    assert!(matches!(
        ptp.transaction(op::GET_DEVICE_INFO, &[], None),
        Err(Error::Protocol(_))
    ));

    let mut ptp = Ptp::new(
        Glued {
            reads: vec![vec![]; 10],
        },
        Timeouts::default(),
    );
    assert!(matches!(
        ptp.transaction(op::GET_DEVICE_INFO, &[], None),
        Err(Error::Protocol(_))
    ));
}

#[test]
fn a_mismatched_response_transaction_id_is_tolerated() {
    let reply = encode_response(rc::OK, 99, &[]);
    let mut ptp = Ptp::new(Glued { reads: vec![reply] }, Timeouts::default());
    assert!(ptp
        .transaction(op::GET_DEVICE_INFO, &[], None)
        .unwrap()
        .is_ok());
}

// ----- record / replay ------------------------------------------------------------------

fn record_a_session() -> (Transcript, crate::sony::Capture) {
    let (sim, _) = SimTransport::new(SimConfig::default());
    let mut sony = Sony::new(
        RecordingTransport::new(sim, "simulated A7 III capture"),
        SonyConfig::no_delays(),
    );
    sony.connect().unwrap();
    let photo = sony.capture().unwrap();
    sony.disconnect().unwrap();
    let (_, transcript) = sony.into_transport().into_parts();
    (transcript, photo)
}

#[test]
fn a_recorded_session_replays_to_the_same_result_without_a_camera() {
    let (transcript, original) = record_a_session();
    assert!(
        transcript.entries.len() > 20,
        "a real session is many transfers"
    );

    // Through JSON, as a checked-in fixture would be.
    let transcript = Transcript::from_json(&transcript.to_json()).unwrap();
    let mut sony = Sony::new(ReplayTransport::new(transcript), SonyConfig::no_delays());
    sony.connect().unwrap();
    let replayed = sony.capture().unwrap();
    sony.disconnect().unwrap();

    assert_eq!(replayed, original);
    sony.into_transport().assert_finished().unwrap();
}

#[test]
fn replay_catches_a_change_in_wire_behaviour() {
    let (transcript, _) = record_a_session();
    let mut sony = Sony::new(ReplayTransport::new(transcript), SonyConfig::no_delays());
    sony.connect().unwrap();
    // The recording took a picture here; skipping straight to disconnect diverges.
    let err = sony.disconnect().unwrap_err();
    assert!(matches!(err, Error::Replay(_)), "got {err}");
}
