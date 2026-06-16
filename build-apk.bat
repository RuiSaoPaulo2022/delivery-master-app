@echo off
chcp 65001 >nul
echo ================================================
echo   交维大师 Android APP - Build Script
echo   Delivery ^& Ops Master v0.1.0
echo ================================================
echo.

cd /d "%~dp0"

echo [1/4] Checking prerequisites...
where java >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Java JDK not found. Please install JDK 17+ and add to PATH.
    echo         Download: https://adoptium.net/
    pause
    exit /b 1
)

where gradle >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [INFO] Gradle not in PATH, will use Gradle Wrapper from Android project.
)

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 18+.
    pause
    exit /b 1
)

echo [OK] Prerequisites check passed.
echo.

echo [2/4] Syncing web assets to Android project...
call npx cap sync
if %ERRORLEVEL% neq 0 (
    echo [ERROR] cap sync failed.
    pause
    exit /b 1
)
echo [OK] Web assets synced.
echo.

echo [3/4] Building APK (debug)...
cd android
call gradlew assembleDebug
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Gradle build failed.
    cd ..
    pause
    exit /b 1
)
cd ..
echo [OK] APK built successfully.
echo.

echo [4/4] APK location:
echo      app-android\android\app\build\outputs\apk\debug\app-debug.apk
echo.

set APK_PATH=%~dp0android\app\build\outputs\apk\debug\app-debug.apk
if exist "%APK_PATH%" (
    echo [SUCCESS] APK file: %APK_PATH%
    echo           Size:
    for %%A in ("%APK_PATH%") do echo           %%~zA bytes
) else (
    echo [WARN] APK file not found at expected location.
)

echo.
echo ================================================
echo   Build complete! Install the APK to your phone:
echo   1. Transfer app-debug.apk to Android phone
echo   2. Open the APK file to install
echo   3. Enable "Install from unknown sources" if prompted
echo ================================================
pause
