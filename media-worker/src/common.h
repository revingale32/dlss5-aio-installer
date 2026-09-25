// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - DLSS 5 neural rendering for pictures, videos and the live desktop.
// Part of the DLSS 5 AIO Installer. Apache-2.0.
//
// Shared plumbing: UTF-8/UTF-16 conversion, a JSON-lines event stream on stdout
// (what the installer app reads), a plain-text log file, and a cancel flag that
// the stdin watcher sets when the app asks us to stop or goes away.
#pragma once

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

namespace dm
{
std::string Utf8(const std::wstring &text);
std::wstring Wide(const std::string &text);
std::string JsonEscape(const std::string &text);
std::string Hex32(unsigned long value);

// Plain-text log. Every Emit() line is mirrored into it too.
void LogOpen(const std::wstring &path);
void Log(const char *format, ...);
void LogClose();

// One JSON object per line on stdout. Build with JsonLine, then Emit().
class JsonLine
{
public:
    explicit JsonLine(const char *event);
    JsonLine &Str(const char *key, const std::string &value);
    JsonLine &WStr(const char *key, const std::wstring &value);
    JsonLine &Int(const char *key, long long value);
    JsonLine &Num(const char *key, double value);
    JsonLine &Bool(const char *key, bool value);
    JsonLine &Raw(const char *key, const std::string &json);
    void Emit();
    const std::string &Text() const { return text_; }

private:
    std::string text_;
};

void EmitError(const std::string &message, bool fatal);
void EmitWarning(const std::string &message);

// Set by the stdin watcher ("cancel"/"stop" line or the pipe closing) and by
// the desktop hotkey. Everything long-running polls it.
extern std::atomic<bool> g_cancel;
void StartStdinWatcher();
// Next line the app sent on stdin that was not cancel/stop (a live command), if any.
bool PopCommand(std::string &line);

double NowMs();
std::wstring FileNameOf(const std::wstring &path);
std::wstring StemOf(const std::wstring &path);
std::wstring ExtensionOf(const std::wstring &path);   // lower-case, with the dot
std::wstring DirectoryOf(const std::wstring &path);
bool FileExists(const std::wstring &path);
bool DirectoryExists(const std::wstring &path);
bool EnsureDirectory(const std::wstring &path);
unsigned long long FileSize(const std::wstring &path);
} // namespace dm
