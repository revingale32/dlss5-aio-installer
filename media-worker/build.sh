#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
# Cross-build dlss5-media.exe with clang + mingw-w64 (same toolchain as the add-on).
set -e
cd "$(dirname "$0")"
MWR=/usr/x86_64-w64-mingw32; G=/usr/lib/gcc/x86_64-w64-mingw32/13-win32
mkdir -p build/caseshim
for h in Windows.h Shlwapi.h Psapi.h Unknwn.h Objbase.h; do l=$(echo "$h" | tr 'A-Z' 'a-z'); [ -f "$MWR/include/$l" ] && ln -sf "$MWR/include/$l" "build/caseshim/$h"; done
CXX="clang++ --target=x86_64-w64-mingw32 -fms-extensions --sysroot=$MWR -nostdinc++ -I$G/include/c++ -I$G/include/c++/x86_64-w64-mingw32 -I$G/include/c++/backward -Ibuild/caseshim -I$MWR/include -L$G -L$MWR/lib -static-libgcc -static-libstdc++"
FLAGS="-std=c++20 -O2 -DNDEBUG -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -Ithird_party/ngx -Ithird_party/nvof -Isrc -Wall -Wno-unknown-pragmas -Wno-missing-field-initializers -Wno-unused-parameter -Wno-sign-compare -Wno-unused-function -Wno-pragma-pack"
objs=""
for f in src/common.cpp src/engine.cpp src/images.cpp src/video.cpp src/mp4fix.cpp src/desktop.cpp src/main.cpp third_party/nvof/nvof-motion-provider.cpp; do
  o=build/$(basename "${f%.cpp}").o
  $CXX $FLAGS -c "$f" -o "$o"
  objs="$objs $o"
done
# Version information (Properties > Details): who made it, the licence, the official download.
x86_64-w64-mingw32-windres -I"$MWR/include" src/version.rc -O coff -o build/version.o
objs="$objs build/version.o"
$CXX -municode -o build/dlss5-media.exe $objs -static -lpthread \
  -ld3d12 -ldxgi -ld3d11 -ld3dcompiler -ldcomp -lwindowscodecs -lole32 -loleaut32 -luuid -lmfplat -lmfreadwrite -lmfuuid \
  -lshlwapi -luser32 -lgdi32 -ladvapi32 -lpropsys -lshell32
x86_64-w64-mingw32-strip build/dlss5-media.exe
ls -la build/dlss5-media.exe
