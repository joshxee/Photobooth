# Production Deployment Guide

**Status:** ✅ Production Ready
**Target:** Sony A7 III Mark 2.0 Photobooth
**Last Updated:** February 2026

## Overview

This guide covers deploying the photobooth app for continuous multi-hour operation in production environments (events, parties, commercial installations).

---

## Hardware Requirements

### Minimum Requirements

- **Device:** Android tablet (recommended: 10"+ screen)
- **Android Version:** 10+ (API 29+) for programmatic WiFi
- **RAM:** 4GB minimum (8GB recommended)
- **Storage:** 2GB free space
- **Camera:** Sony A7 III (or compatible Sony Alpha camera)

### Recommended Setup

- **Tablet:** Samsung Galaxy Tab S8+ or similar
- **Mount:** Secure tripod or stand mount
- **Power:** USB-C power adapter (keep plugged in)
- **Camera:** Sony A7 III with fully charged battery + AC adapter
- **Network:** Dedicated WiFi network (camera's built-in AP)

---

## Pre-Deployment Checklist

### Camera Configuration

1. **WiFi Mode**
   - Enable "Ctrl w/ Smartphone" mode
   - Note the WiFi SSID (usually "DIRECT-...")
   - Note the WiFi password

2. **Camera Settings** (CRITICAL)
   - **Drive Mode:** Single Shooting
   - **File Format:** JPEG or RAW+JPEG
   - **Image Quality:** Fine or Extra Fine
   - **Focus Mode:** AF-S (Single-shot AF) or AF-C (Continuous AF)

3. **Power Management**
   - Use AC adapter (not battery alone)
   - Disable auto power-off: Menu → Setup → Power Save Start Time → Off
   - Disable sleep mode

### App Configuration

4. **Install APK**
   ```bash
   adb install composeApp/build/outputs/apk/debug/composeApp-debug.apk
   ```

5. **Settings Configuration**
   - Open app → Settings screen
   - Set number of photos (default: 4)
   - Set countdown duration (default: 3 seconds)
   - Save settings

6. **WiFi Connection**
   - Connect tablet to camera's WiFi network manually
   - Keep WiFi connected throughout operation
   - Disable mobile data (prevents switching away from camera WiFi)

### Environment Setup

7. **Tablet Placement**
   - Position at comfortable height (eye level)
   - Secure mounting (prevent movement/tipping)
   - Ensure power cable is secured

8. **Lighting**
   - Well-lit environment (avoid backlighting)
   - Consistent lighting (no flickering)

9. **Testing**
   - Run 5+ test capture sessions
   - Verify photo quality
   - Test network stability indicator
   - Confirm fullscreen mode activates

---

## Operation Guide

### Starting a Session

1. **Power On**
   - Turn on camera and wait for WiFi to activate
   - Ensure tablet is plugged into power
   - Launch photobooth app

2. **Initial Connection**
   - Select "Sony A7 III (Mark 2.0)" from camera selection
   - Wait for live view to appear (3-5 seconds)
   - Verify green WiFi indicator in top-right corner

3. **Ready State**
   - Live view should be smooth (not choppy)
   - No error messages
   - "Capture" button visible and enabled

### During Operation

**Normal Flow:**
1. User taps "Capture"
2. Countdown (3...2...1)
3. Photos captured (4 photos with countdown between each)
4. Photostrip displayed with 10-second countdown
5. Auto-return to live view
6. Repeat

**Monitoring:**
- Check WiFi indicator periodically (should be green)
- Watch for error messages
- Verify camera remains responsive

**User Interruptions:**
- Users can tap countdown to skip and return immediately
- "Home" button returns to camera selection (breaks session)
- "Take Another" button on photostrip immediately starts new capture

### Troubleshooting During Event

| Issue | Quick Fix |
|-------|-----------|
| **Live view frozen** | Tap "Home" → Re-select Mark 2.0 |
| **"Not connected"** | Check tablet WiFi → Reconnect to camera |
| **Camera slow/unresponsive** | Turn camera off/on → Reconnect |
| **WiFi indicator red** | Tap indicator → Check details → "Open WiFi Settings" |
| **App freezes** | Force close app → Relaunch → Re-select camera |
| **Photos not downloading** | Verify camera is in Single Shooting mode |

### Ending a Session

1. Tap "Home" button
2. Close app (optional)
3. Disconnect from camera WiFi
4. Turn off camera

---

## Performance Characteristics

### Expected Performance

- **Session Duration:** 2+ hours continuous operation
- **Memory Usage:** <200MB after 2 hours (with periodic cleanup)
- **Capture Time:**
  - Countdown: 3 seconds
  - Capture: ~1 second
  - Download: 1-2 seconds per photo
  - Preview: 1.5 seconds
  - **Total per photo:** ~6-8 seconds
  - **4-photo sequence:** ~30-35 seconds
- **Network Health Checks:** Every 20 seconds
- **Resource Cleanup:** Every 30 minutes (automatic)

### Resource Management

**Automatic Cleanup (every 30 minutes):**
```
[MARK2_VM] PERIODIC CLEANUP
[MARK2_VM] Session uptime: 120min
[MARK2_VM] Total captures: 40
[MARK2_VM] Total errors: 2
```

**Photo Memory Management:**
- Photos cleared immediately after photostrip navigation
- No photos persisted to storage (intentional for privacy)
- Bitmaps released when leaving photostrip screen

---

## Network Monitoring

### WiFi Status Indicator

Located in **top-right corner** of live view screen:

- **Green Circle:** Healthy connection (<500ms latency)
- **Yellow/Amber Circle:** Degraded connection (500ms+ latency)
- **Red Circle:** Disconnected or unreachable

**Tap indicator** to see detailed status:
- WiFi connection state
- Network SSID
- Camera reachability
- Latency
- Health state

### Reconnection Dialog

Automatically appears if connection is lost during capture:

**Options:**
1. **Retry Connection** - Attempts reconnection
2. **Open WiFi Settings** - Quick access to WiFi settings
3. **Continue Anyway** - Cancel capture and return to live view

**Auto-Retry:**
- Exponential backoff: 2s, 4s, 8s delays
- Max 5 attempts
- Shows attempt number and progress

---

## Fullscreen/Kiosk Mode

### Behavior

**Activated:** When entering camera live view screen
**Deactivated:** When leaving camera screen (Home button, navigation)

**System UI Hidden:**
- Status bar (top)
- Navigation bar (bottom)
- Gesture hints

**User Gestures:**
- Swipe from top/bottom edge temporarily shows system UI
- System UI auto-hides after 3 seconds
- User cannot exit app via system gestures (must use Home button)

### Immersive Sticky Mode

Uses Android's `SYSTEM_UI_FLAG_IMMERSIVE_STICKY`:
- System UI stays hidden during swipes
- No visual interruption during captures
- Prevents accidental app exit

---

## Session Statistics & Logging

### Viewing Logs

**Android Logcat (real-time):**
```bash
adb logcat -s SonyCameraApi
```

**Filter for specific operations:**
```bash
adb logcat | grep "MARK2_VM"
```

### Key Log Messages

**Session Start:**
```
[MARK2_VM] Initializing SonyMark2ViewModel
[MARK2_VM] Connected to camera
[MARK2_VM] Starting live view...
```

**Capture Sequence:**
```
[MARK2_VM] Starting Mark 2.0 capture sequence
[MARK2_VM] Photos: 4, Countdown: 3s
[MARK2_VM] ─── Photo 1/4 ───
[MARK2_VM] Countdown: 3
[MARK2_VM] Capturing photo 1...
[MARK2_VM] Downloading from: http://192.168.122.1:8080/...
[MARK2_VM] Downloaded 4523891 bytes
```

**Periodic Statistics:**
```
[MARK2_VM] PERIODIC CLEANUP
[MARK2_VM] Session uptime: 120min
[MARK2_VM] Total captures: 40
[MARK2_VM] Total errors: 2
```

**Session End:**
```
[MARK2_VM] SESSION STATISTICS
[MARK2_VM] Uptime: 125min
[MARK2_VM] Total captures: 42
[MARK2_VM] Total errors: 1
[MARK2_VM] Success rate: 97%
```

---

## Best Practices

### Do's ✅

- Keep tablet plugged into power throughout event
- Test complete workflow before event starts
- Monitor WiFi indicator during first 10 minutes
- Have backup plan (smartphone as hotspot backup)
- Keep camera manual nearby for settings verification
- Position camera with good lighting
- Run 5+ test captures before guests arrive

### Don'ts ❌

- Don't switch camera drive mode during operation
- Don't disconnect from camera WiFi during session
- Don't let tablet battery drain (keep plugged in)
- Don't cover camera's WiFi antenna
- Don't place tablet/camera in direct sunlight (overheating)
- Don't use camera's mobile data mode
- Don't force close app unless necessary

---

## Capacity Planning

### Single Session Capacity

**Assumptions:**
- 4 photos per strip
- 35 seconds per strip (including photostrip display)
- 2-hour event

**Expected Throughput:**
- **Captures per hour:** ~100 strips (400 photos)
- **2-hour event:** ~200 strips (800 photos)

**Memory Impact:**
- Photos cleared after each strip
- Steady-state memory: <200MB
- No storage accumulation (photos not saved)

### Multi-Hour Events

**Tested Stability:**
- ✅ 2+ hours continuous operation
- ✅ Memory stable (<50MB delta)
- ✅ Auto-recovery from timeouts
- ✅ Network monitoring with reconnection

**Recommended:**
- Monitor first hour closely
- Check WiFi indicator every 15 minutes
- Have backup device ready for 4+ hour events

---

## Troubleshooting

### Common Issues

#### Live View Not Appearing

**Symptoms:** Black screen, no live view after camera selection

**Solutions:**
1. Check camera is in "Ctrl w/ Smartphone" mode
2. Verify WiFi connection (tablet connected to camera's network)
3. Try reconnecting: Home → Sony Mark 2.0
4. Restart camera if problem persists

#### Photos Not Downloading

**Symptoms:** Countdown completes, but no photos appear

**Solutions:**
1. Verify camera is in **Single Shooting** mode (not Continuous)
2. Check file format is **JPEG** or **RAW+JPEG** (not RAW only)
3. Ensure camera has storage space on memory card
4. Check network indicator (should be green)

#### Connection Lost During Capture

**Symptoms:** Red WiFi indicator, reconnection dialog appears

**Solutions:**
1. Tap "Retry Connection" first
2. If retry fails, tap "Open WiFi Settings"
3. Verify tablet is connected to camera WiFi
4. Tap "Continue Anyway" to cancel capture and return to live view
5. Test capture again

#### Memory Issues (Rare)

**Symptoms:** App becomes slow or crashes after extended use

**Solutions:**
1. Force close app
2. Relaunch app
3. Re-select Sony Mark 2.0
4. If persists, restart tablet

#### Camera Unresponsive

**Symptoms:** Captures time out, camera doesn't respond

**Solutions:**
1. Turn camera off and on
2. Wait for WiFi to re-establish
3. Reconnect from app: Home → Sony Mark 2.0

---

## Maintenance

### Regular Checks

- **Weekly:** Clean camera lens
- **Monthly:** Update app if new version available
- **Before Event:** Test complete workflow end-to-end

### Version Updates

```bash
# Build new APK
./gradlew :composeApp:assembleDebug

# Install update
adb install -r composeApp/build/outputs/apk/debug/composeApp-debug.apk
```

---

## Support

### Logs for Bug Reports

If issues occur, collect logs:

```bash
# Capture full session logs
adb logcat -s SonyCameraApi > photobooth-session.log

# Include in bug report:
# - Session log file
# - Android version
# - Tablet model
# - Camera model & firmware version
# - Description of issue
```

### Known Limitations

- iOS: Cannot connect to camera WiFi programmatically (manual connection required)
- Android <10: Cannot connect to camera WiFi programmatically (manual connection required)
- RAW files: Not transferred to app (only JPEG downloaded)
- Desktop/Web: Network monitoring not implemented (Android-only feature)

---

## Security & Privacy

### Data Retention

- **Photos:** Not saved to storage (cleared after photostrip display)
- **Network Credentials:** Not stored persistently
- **Session Stats:** Logged but not persisted
- **User Data:** No personal data collected

### Network Security

- Camera WiFi uses WPA2-PSK encryption
- All communication over local network (no internet)
- No external data transmission
- Camera IP address: 192.168.122.1 (local only)

---

## Appendix

### Camera API Endpoints

Used by Mark 2.0:

- `getAvailableApiList` - Health check
- `startLiveview` - Start live view stream
- `stopLiveview` - Stop live view
- `actHalfPressShutter` - Autofocus
- `actTakePicture` - Capture photo, returns URL
- `downloadImage` - Download photo from URL

### WiFi Network Info

**Camera Access Point:**
- SSID: `DIRECT-xxxx` (varies by camera)
- IP Address: 192.168.122.1
- Port: 8080
- Protocol: HTTP (JSON-RPC)

### File Locations

**Source Code:**
- Mark 2.0 ViewModel: `composeApp/src/commonMain/kotlin/com/jc/photobooth/ui/photobooth/sony/mark2/SonyMark2ViewModel.kt`
- Mark 2.0 Screen: `composeApp/src/commonMain/kotlin/com/jc/photobooth/ui/photobooth/sony/mark2/SonyMark2Screen.kt`
- Network Monitor: `composeApp/src/androidMain/kotlin/com/jc/photobooth/network/CameraNetworkMonitor.kt`
- Photostrip Screen: `composeApp/src/commonMain/kotlin/com/jc/photobooth/ui/photostrip/PhotoStripScreen.kt`

**Build Outputs:**
- Debug APK: `composeApp/build/outputs/apk/debug/composeApp-debug.apk`
- Test Reports: `composeApp/build/reports/tests/testDebugUnitTest/index.html`
