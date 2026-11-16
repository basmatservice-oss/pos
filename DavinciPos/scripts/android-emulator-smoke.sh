#!/usr/bin/env bash
set -euo pipefail

APK="$(find DavinciPos/android/app/build/outputs/apk -type f -name '*.apk' -print -quit)"
if [[ -z "$APK" || ! -s "$APK" ]]; then
  echo "Android APK was not found after assembleDebug."
  find DavinciPos/android/app/build/outputs -maxdepth 5 -type f -print 2>/dev/null || true
  exit 1
fi

adb install -r "$APK"
adb shell am force-stop com.basmatservice.davincipos
adb shell am start -W -n com.basmatservice.davincipos/.MainActivity
sleep 5
PID="$(adb shell pidof com.basmatservice.davincipos | tr -d '\r')"
test -n "$PID"
adb shell uiautomator dump /sdcard/davincipos-window.xml
adb pull /sdcard/davincipos-window.xml /tmp/davincipos-window.xml
grep -Fq 'اختر طريقة تشغيل التطبيق' /tmp/davincipos-window.xml
grep -Fq 'الاتصال بخادم الكمبيوتر عبر Wi-Fi / LAN' /tmp/davincipos-window.xml
grep -Fq 'تشغيل محلي على الهاتف' /tmp/davincipos-window.xml
if adb logcat -d -t 2500 --pid="$PID" | grep -E 'FATAL EXCEPTION|Fatal signal [0-9]'; then
  echo "Android reported a fatal crash during launcher startup."
  exit 1
fi
echo "Android emulator startup chooser smoke test passed; app PID=$PID"
