# Sony A7 III Bluetooth Pairing Troubleshooting Guide

## ⚠️ CRITICAL DISCOVERY

**Sony cameras DO NOT appear in normal Android Bluetooth settings!**

Sony uses a **proprietary BLE advertisement** that requires:
- Android's **Companion Device API** (what alpharemote uses), OR
- Sony's official app (Imaging Edge Mobile / Creators' App)

**You cannot pair directly through Android Settings → Bluetooth.**

## Recommended Approach

### Option 1: Use alpharemote App (Easiest for Testing)

1. Download [alpharemote](https://play.google.com/store/apps/details?id=de.staacks.alpharemote)
2. Camera: Menu → Network → Bluetooth → Pairing
3. alpharemote: Tap "Pair Camera" → Select ILCE-7M3
4. Test shutter control

### Option 2: Use Our App (After Implementation)

Our app now includes `CompanionDeviceHelper.kt` for camera discovery.
Use the "Discover Camera" button in Bluetooth Test screen (to be implemented).

### Option 3: Use Sony's Official App First

1. Check camera firmware: Menu → Setup → Version
2. Download appropriate app:
   - Ver 2.00+: [Creators' App](https://play.google.com/store/apps/details?id=com.sony.imaging.cameraandphone)
   - Ver 1.xx: [Imaging Edge Mobile](https://play.google.com/store/apps/details?id=com.sony.playmemories.mobile)
3. Pair through Sony app
4. Camera appears in Android Bluetooth settings
5. Get MAC address from Settings → Bluetooth → Paired devices
6. Use MAC address in our app

## ~~Quick Start (If Working)~~ ❌ DOESN'T WORK

~~1. Camera: Menu → Network → Bluetooth → Pairing~~
~~2. Android: Settings → Bluetooth → Scan for devices~~
~~3. Select "ILCE-7M3" → Pair~~
~~4. Confirm on both devices~~

**This does not work!** Sony cameras don't appear in normal Bluetooth scan.

## Detailed Troubleshooting

### Camera Setup

**Step 1: Enable Bluetooth Remote Control**
```
Menu → Network → Bluetooth Settings
├── Bluetooth Function: On
├── Bluetooth Remote Ctrl: On  ← MUST BE ON!
└── Pairing: (select to enter pairing mode)
```

**Step 2: Clear Existing Pairings**
```
Menu → Network → Bluetooth → Device Management
└── Delete all existing paired devices
```

**Step 3: Disable WiFi (Temporarily)**
```
Menu → Network → Wi-Fi
└── Wi-Fi: Off
```

**Step 4: Enter Pairing Mode**
```
Menu → Network → Bluetooth → Pairing
```
Camera screen should show:
- "Pairing..." or "Waiting for connection"
- Bluetooth icon flashing
- Device name (e.g., "ILCE-7M3")

### Android Setup

**Step 1: Enable Location Services**
```
Android Settings → Location → On
```
*(Required for Bluetooth scanning on Android 6.0+)*

**Step 2: Reset Bluetooth**
```
Android Settings → Bluetooth → Off → Wait 3 seconds → On
```

**Step 3: Scan for Devices**
```
Android Settings → Bluetooth → Pair new device
```
Wait 10-15 seconds for camera to appear.

**Look for:**
- "ILCE-7M3" (A7 III)
- "ILCE-7M4" (A7 IV)
- "Sony Camera"
- Check camera screen for exact broadcast name

### Common Problems & Solutions

#### Problem: Camera doesn't appear in scan

**Solution 1: Camera is already paired to another device**
- Camera can only pair with ONE device
- Delete existing pairings on camera
- Menu → Network → Bluetooth → Device Management → Delete all

**Solution 2: Bluetooth Remote Ctrl is OFF**
- This is the most common issue!
- Menu → Network → Bluetooth → Bluetooth Remote Ctrl: **On**

**Solution 3: Camera not in pairing mode**
- Camera must actively be in pairing mode
- Not just "Bluetooth On" - need to select "Pairing"
- Menu → Network → Bluetooth → Pairing (select this!)

**Solution 4: WiFi interference**
- Turn off camera WiFi temporarily
- Menu → Network → Wi-Fi → Off
- Try Bluetooth pairing again
- Re-enable WiFi after pairing if needed

**Solution 5: Android cache issue**
- Clear Bluetooth cache:
  - Settings → Apps → Show system apps
  - Find "Bluetooth" → Storage → Clear cache
  - Restart Android device

#### Problem: Camera appears but pairing fails

**Solution 1: Confirm on camera screen**
- Camera will show pairing request
- Must press OK on camera to confirm

**Solution 2: PIN code mismatch**
- Some cameras show PIN on screen
- Enter exactly as shown on Android

**Solution 3: Reset camera network settings**
- Menu → Setup → Reset → Network Settings Reset
- Reconfigure Bluetooth from scratch

#### Problem: Pairing succeeds but app can't connect

**Solution 1: Check MAC address**
- Android Settings → Bluetooth → Paired devices
- Tap camera name → Show MAC address
- Copy exact address (e.g., AA:BB:CC:DD:EE:FF)
- Enter in app exactly as shown (with colons)

**Solution 2: App permissions**
- Android Settings → Apps → Photobooth
- Permissions → Bluetooth → Allow
- Location → Allow (required for Bluetooth scanning)

**Solution 3: Remote control enabled**
- After pairing, camera might disable remote control
- Check: Menu → Network → Bluetooth → Bluetooth Remote Ctrl: On

## Verification Checklist

Before testing in app, verify:

- [ ] Camera Bluetooth Function: On
- [ ] Camera Bluetooth Remote Ctrl: On
- [ ] Camera successfully paired in Android Bluetooth settings
- [ ] Camera appears in Android's "Paired devices" list
- [ ] Android Bluetooth permission granted to app
- [ ] Android Location services enabled
- [ ] Camera MAC address noted down

## Camera Models & Bluetooth Names

| Camera Model | Bluetooth Name | Notes |
|--------------|----------------|-------|
| Sony α7 III | ILCE-7M3 | Tested - working |
| Sony α7 IV | ILCE-7M4 | Should work |
| Sony α7R III | ILCE-7RM3 | Should work |
| Sony α7R IV | ILCE-7RM4 | Should work |
| Sony α6400 | ILCE-6400 | Should work |
| Sony α6600 | ILCE-6600 | Should work |
| Sony α9 | ILCE-9 | Should work |

## Testing in App

Once paired in Android settings:

1. Launch Photobooth app
2. Tap "Test Bluetooth Camera"
3. Enter camera MAC address from Bluetooth settings
4. Tap "Connect to Camera"
5. Wait for "Connected" status
6. Try "Take Photo" button

Expected behavior:
- Connection: 2-3 seconds
- Status shows: "Connected: ILCE-7M3"
- Camera makes shutter sound when "Take Photo" pressed
- Photo saved to camera SD card

## References

- [alpharemote troubleshooting](https://github.com/Staacks/alpharemote#troubleshooting)
- Sony A7 III manual: Bluetooth section
- [Sony Support - Bluetooth pairing](https://www.sony.com/electronics/support/articles/00266597)
