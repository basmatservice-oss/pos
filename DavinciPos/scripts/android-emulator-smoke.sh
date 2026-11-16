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
if [[ -z "$PID" ]]; then
  echo "DavinciPos process is not alive after launcher startup."
  adb logcat -d -t 4000 | grep -E 'DavinciPos|FATAL EXCEPTION|Fatal signal' | tail -n 160 || true
  exit 1
fi

adb shell uiautomator dump /sdcard/davincipos-window.xml
adb pull /sdcard/davincipos-window.xml /tmp/davincipos-window.xml

# Parse the UI hierarchy as XML instead of grepping raw serialized XML.
# This handles XML escaping and whitespace normalization and prints the
# observed labels on failure so the next diagnosis is actionable.
python3 - <<'PY'
import sys
import xml.etree.ElementTree as ET

path = "/tmp/davincipos-window.xml"
try:
    root = ET.parse(path).getroot()
except Exception as error:
    print(f"Unable to parse Android UI hierarchy: {error}")
    with open(path, encoding="utf-8", errors="replace") as source:
        print(source.read()[:12000])
    raise SystemExit(1)

texts = []
for node in root.iter():
    value = " ".join((node.attrib.get("text") or "").split())
    if value:
        texts.append(value)

print("Observed Android UI text:")
for value in texts:
    print(f"  - {value}")

required = (
    "اختر طريقة تشغيل التطبيق",
    "الاتصال بخادم الكمبيوتر عبر Wi-Fi / LAN",
    "تشغيل محلي على الهاتف",
)
missing = [label for label in required if not any(label in value for value in texts)]
if missing:
    print("Missing expected launcher labels:")
    for label in missing:
        print(f"  - {label}")
    raise SystemExit(1)
PY

if adb logcat -d -t 4000 --pid="$PID" | grep -E 'FATAL EXCEPTION|Fatal signal [0-9]'; then
  echo "Android reported a fatal crash during launcher startup."
  exit 1
fi

echo "Android emulator startup chooser smoke test passed; app PID=$PID"
