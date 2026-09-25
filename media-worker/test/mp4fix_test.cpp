// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// Test harness: dlss5-mp4fix-test.exe <file.mp4> - patches the file in place and prints the result.
#include "jobs.h"
#include <cstdio>
int wmain(int argc, wchar_t **argv)
{
    if (argc < 2) return 2;
    std::string note;
    const bool fixed = dm::Mp4FixVideoStart(argv[1], note);
    printf("%s: %s\n", fixed ? "fixed" : "unchanged", note.c_str());
    return fixed ? 0 : 1;
}
