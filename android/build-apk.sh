#!/bin/bash
# 一键构建安卓 APK（JDK/Gradle/SDK 均为免安装版）
set -e
export JAVA_HOME="C:/tools/android-build/jdk/jdk-17.0.20.1+1"
export PATH="$JAVA_HOME/bin:$PATH"
cd "$(dirname "$0")"
node sync-assets.cjs
"/c/tools/android-build/gradle/gradle-8.7/bin/gradle.bat" assembleDebug --no-daemon
ls -la app/build/outputs/apk/debug/
