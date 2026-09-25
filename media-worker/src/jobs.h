// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - the three kinds of work. Apache-2.0.
#pragma once

#include "engine.h"

#include <string>
#include <vector>

namespace dm
{
struct JobItem
{
    std::wstring input;
    std::wstring output;
};

struct Settings
{
    NrLook look;
    float mix = 1.0f;                     // 0..1
    unsigned long long maxWorkPixels = 3840ull * 2160ull;   // 0 = always full size
    int refine = 1;                       // stills: evaluations of the same frame (first one resets)
    // video
    std::string codec = "h264";           // h264 | hevc
    std::string quality = "high";         // standard | high | max
    std::string audio = "copy";           // copy | aac | none
    float stabilize = 0.6f;               // 0..1, video and desktop
    bool motionToNr = false;              // hand optical flow to NR as well
    float sceneCut = 0.24f;               // mean luma change that counts as a new shot
    // stills
    int jpegQuality = 95;
    // desktop
    int monitor = -1;                     // -1 = primary
    int fpsCap = 60;
    double durationSeconds = 0.0;         // desktop: stop by itself after this long (0 = until stopped)
    std::wstring snapshotDir;             // desktop diagnostics: save one before/after pair here
    std::wstring diffDumpDir;             // desktop diagnostics: save what changed in the first flagged frames here
    bool split = false;                   // desktop: left half original, right half DLSS 5 (Ctrl+Alt+S toggles)
    std::string present = "dcomp";        // desktop overlay: dcomp (DirectComposition) | hwnd (flip swap chain)
    int overlayCheck = 0;                 // desktop diagnostics, then exit: 1 = the overlay must reach the screen
                                          // (not hidden from capture), 2 = it must stay hidden from capture
    // diagnostics: decode and re-encode without neural rendering (no GPU needed)
    bool passthrough = false;
};

bool RunImages(Engine *engine, const std::vector<JobItem> &items, const Settings &settings);
bool RunVideos(Engine *engine, const std::vector<JobItem> &items, const Settings &settings);
bool RunDesktop(Engine &engine, const Settings &settings);
bool RunProbe(Engine &engine, const Settings &settings);
// mp4fix.cpp: adds the edit list Media Foundation leaves out so the video starts at 0:00
bool Mp4FixVideoStart(const std::wstring &path, std::string &note);
// images.cpp: writes 8-bit RGBA as PNG/JPEG/TIFF by extension (used by desktop snapshots too)
bool SaveRgba(const std::wstring &path, const unsigned char *rgba, unsigned width, unsigned height, bool alpha, int jpegQuality, std::string &error);
} // namespace dm
