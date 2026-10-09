//! Drives a real camera attached to *this* machine: connect, print device info, shoot, save
//! the JPEG, and optionally run a live-view loop.
//!
//! ```text
//! cargo run -p sony-ptp --features desktop-usb --example shoot -- \
//!     [--out photo.jpg] [--live 100] [--record session.json]
//! ```
//!
//! `--record` writes every USB transfer to a JSON transcript that `ReplayTransport` can play
//! back in `cargo test`, turning a hardware session into a regression fixture.
//!
//! Requires the camera in *PC Remote* USB mode. On Windows libusb also needs a WinUSB driver
//! bound to the camera (e.g. via Zadig); on macOS/Linux it works out of the box.

use std::time::Instant;

use sony_ptp::{RecordingTransport, RusbTransport, Sony, SonyConfig};

struct Args {
    out: String,
    live_frames: u32,
    record: Option<String>,
}

fn parse_args() -> Args {
    let mut args = Args {
        out: "photo.jpg".to_owned(),
        live_frames: 0,
        record: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--out" => args.out = it.next().expect("--out needs a path"),
            "--live" => {
                args.live_frames = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("--live needs a frame count");
            }
            "--record" => args.record = Some(it.next().expect("--record needs a path")),
            other => panic!("unknown argument {other}"),
        }
    }
    args
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();
    let usb = RusbTransport::open_first_sony()?;
    let transport = RecordingTransport::new(usb, "examples/shoot");
    let mut camera = Sony::new(transport, SonyConfig::default());

    let info = camera.connect()?.clone();
    println!(
        "connected: {} {} (firmware {}, serial {})",
        info.manufacturer, info.model, info.device_version, info.serial_number
    );
    println!("operations advertised: {}", info.operations.len());

    let started = Instant::now();
    let capture = camera.capture()?;
    println!(
        "captured {} ({}x{}, {} bytes) in {:?}",
        capture.filename,
        capture.width,
        capture.height,
        capture.jpeg.len(),
        started.elapsed()
    );
    std::fs::write(&args.out, &capture.jpeg)?;
    println!("saved {}", args.out);

    if args.live_frames > 0 {
        camera.wait_for_live_view()?;
        let started = Instant::now();
        let mut got = 0;
        for _ in 0..args.live_frames {
            if camera.live_frame()?.is_some() {
                got += 1;
            }
        }
        println!(
            "live view: {got}/{} frames in {:?}",
            args.live_frames,
            started.elapsed()
        );
    }

    camera.disconnect()?;
    if let Some(path) = args.record {
        let (_, transcript) = camera.into_transport().into_parts();
        std::fs::write(&path, transcript.to_json())?;
        println!(
            "transcript written to {path} ({} calls)",
            transcript.entries.len()
        );
    }
    Ok(())
}
