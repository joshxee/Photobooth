# Photobooth Technical Wiki

This wiki documents the technical architecture, design decisions, and implementation details of the Photobooth application.

## Contents

- [Architecture Overview](./Architecture.md) - High-level system design and component organization
- [Camera System](./Camera-System.md) - Camera implementation and key design decisions
- [State Management](./State-Management.md) - State handling patterns and ViewModel architecture
- [Testing Strategy](./Testing-Strategy.md) - Test organization and coverage approach
- [Platform Support](./Platform-Support.md) - Cross-platform implementation details
- [Tauri Migration Plan](./Tauri-Migration-Plan.md) - Why and how the app is moving to Tauri v2 (Android first cut)
- [Tauri Workstreams](./Tauri-Workstreams.md) - Directory ownership, shared contracts, definition of done
- [Core Domain](./Core-Domain.md) - Camera trait, session state machine, settings, mock camera (Rust)
- [Wired Camera Protocol](./Wired-Camera-Protocol.md) - Sony A7 III over PTP/USB: protocol, setup, unverified assumptions
- [Native Camera Plugin](./Native-Camera-Plugin.md) - CameraX behind the WebView, USB host, fd lifetime contract
- [Tauri App](./Tauri-App.md) - State flow, IPC design, security posture, on-device acceptance checklist
- [Frontend](./Frontend.md) - bun-only React UI, original-copy parity, Maestro selector conventions
- [Android Build](./Android-Build.md) - Toolchain, hand-edits in gen/android, signing, Windows gotchas

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
