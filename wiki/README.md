# Photobooth Technical Wiki

This wiki documents the technical architecture, design decisions, and implementation details of the Photobooth application.

## Contents

- [Core Domain](./Core-Domain.md) - Camera trait, session state machine, settings, mock camera, outbox retention rule (Rust)
- [Wired Camera Protocol](./Wired-Camera-Protocol.md) - Sony A7 III over PTP/USB: protocol, setup, unverified assumptions
- [Native Camera Plugin](./Native-Camera-Plugin.md) - CameraX behind the WebView, USB host, fd lifetime contract
- [Tauri App](./Tauri-App.md) - State flow, IPC design, security posture, on-device acceptance checklist
- [Frontend](./Frontend.md) - bun-only React UI, original-copy parity, Maestro selector conventions
- [Android Build](./Android-Build.md) - Toolchain, hand-edits in gen/android, signing, Windows gotchas

## Portal (in progress)

- [Portal implementation plan](./portal/README.md) - 19 sessions (00-18) for the guest web portal on Cloudflare Workers; start with its [PROGRESS.md](./portal/PROGRESS.md)
- [Portal design](./portal/DESIGN.md) - the accepted solution design
- [Portal](./Portal.md) - what was built and why (updated as sessions land): one Worker, host routing, `run_worker_first`, local hostnames
- [Booth Upload](./Booth-Upload.md) - the booth outbox: format, durability, retry rules (session 08; client and upload loop to come)

## Purpose

This documentation focuses on:
- **Design decisions** and the reasoning behind them
- **Trade-offs** made during implementation
- **Known limitations** and areas for future improvement
- **Architecture patterns** used throughout the codebase

## Maintenance

This wiki should be updated whenever:
- New features are added
- Existing features are refactored or removed
- Architectural decisions are made
- Platform-specific implementations change
