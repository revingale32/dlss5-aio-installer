// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - shared plumbing. Apache-2.0.
#include "common.h"

#include <cstdarg>
#include <deque>
#include <cstdio>
#include <cwctype>
#include <mutex>
#include <thread>

namespace dm
{
std::atomic<bool> g_cancel{false};

static std::mutex g_out_lock;
static FILE *g_log_file = nullptr;

std::string Utf8(const std::wstring &text)
{
    if (text.empty()) return {};
    const int needed = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(needed > 0 ? needed : 0), '\0');
    if (needed > 0)
        WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), needed, nullptr, nullptr);
    return out;
}

std::wstring Wide(const std::string &text)
{
    if (text.empty()) return {};
    const int needed = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(needed > 0 ? needed : 0), L'\0');
    if (needed > 0)
        MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), needed);
    return out;
}

std::string JsonEscape(const std::string &text)
{
    std::string out;
    out.reserve(text.size() + 8);
    for (const unsigned char c : text)
    {
        switch (c)
        {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20)
            {
                char buffer[8];
                snprintf(buffer, sizeof(buffer), "\\u%04x", c);
                out += buffer;
            }
            else out += static_cast<char>(c);
        }
    }
    return out;
}

std::string Hex32(unsigned long value)
{
    char buffer[16];
    snprintf(buffer, sizeof(buffer), "0x%08lX", value);
    return buffer;
}

static void WriteLogLine(const char *line)
{
    if (!g_log_file) return;
    SYSTEMTIME now;
    GetLocalTime(&now);
    fprintf(g_log_file, "%02u:%02u:%02u.%03u %s\n", now.wHour, now.wMinute, now.wSecond, now.wMilliseconds, line);
    fflush(g_log_file);
}

void LogOpen(const std::wstring &path)
{
    std::lock_guard<std::mutex> lock(g_out_lock);
    if (g_log_file) { fclose(g_log_file); g_log_file = nullptr; }
    if (path.empty()) return;
    g_log_file = _wfopen(path.c_str(), L"ab");
}

void LogClose()
{
    std::lock_guard<std::mutex> lock(g_out_lock);
    if (g_log_file) { fclose(g_log_file); g_log_file = nullptr; }
}

void Log(const char *format, ...)
{
    char buffer[4096];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    std::lock_guard<std::mutex> lock(g_out_lock);
    WriteLogLine(buffer);
}

JsonLine::JsonLine(const char *event)
{
    text_ = "{\"event\":\"";
    text_ += JsonEscape(event);
    text_ += "\"";
}

JsonLine &JsonLine::Str(const char *key, const std::string &value)
{
    text_ += ",\""; text_ += key; text_ += "\":\""; text_ += JsonEscape(value); text_ += "\"";
    return *this;
}

JsonLine &JsonLine::WStr(const char *key, const std::wstring &value) { return Str(key, Utf8(value)); }

JsonLine &JsonLine::Int(const char *key, long long value)
{
    text_ += ",\""; text_ += key; text_ += "\":"; text_ += std::to_string(value);
    return *this;
}

JsonLine &JsonLine::Num(const char *key, double value)
{
    char buffer[64];
    if (value != value) snprintf(buffer, sizeof(buffer), "null");
    else snprintf(buffer, sizeof(buffer), "%.4f", value);
    text_ += ",\""; text_ += key; text_ += "\":"; text_ += buffer;
    return *this;
}

JsonLine &JsonLine::Bool(const char *key, bool value)
{
    text_ += ",\""; text_ += key; text_ += "\":"; text_ += value ? "true" : "false";
    return *this;
}

JsonLine &JsonLine::Raw(const char *key, const std::string &json)
{
    text_ += ",\""; text_ += key; text_ += "\":"; text_ += json;
    return *this;
}

void JsonLine::Emit()
{
    std::lock_guard<std::mutex> lock(g_out_lock);
    const std::string line = text_ + "}";
    fputs(line.c_str(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
    WriteLogLine(line.c_str());
}

void EmitError(const std::string &message, bool fatal)
{
    JsonLine("error").Str("message", message).Bool("fatal", fatal).Emit();
}

void EmitWarning(const std::string &message)
{
    JsonLine("warning").Str("message", message).Emit();
}

namespace
{
std::mutex g_commandLock;
std::deque<std::string> g_commands;
}

bool PopCommand(std::string &line)
{
    std::lock_guard<std::mutex> lock(g_commandLock);
    if (g_commands.empty()) return false;
    line = std::move(g_commands.front());
    g_commands.pop_front();
    return true;
}

void StartStdinWatcher()
{
    // The app writes "cancel" (or "stop") and a newline, or simply closes our
    // stdin by going away. Either way everything winds down at the next check.
    std::thread([]
    {
        HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
        if (input == nullptr || input == INVALID_HANDLE_VALUE) return;
        std::string pending;
        char buffer[256];
        for (;;)
        {
            DWORD read = 0;
            if (!ReadFile(input, buffer, sizeof(buffer), &read, nullptr) || read == 0)
            {
                // A console with no pipe attached never returns; a closed pipe does.
                const DWORD type = GetFileType(input);
                if (type == FILE_TYPE_PIPE || type == FILE_TYPE_DISK)
                {
                    Log("stdin closed - cancelling");
                    g_cancel = true;
                }
                return;
            }
            pending.append(buffer, read);
            size_t newline;
            while ((newline = pending.find('\n')) != std::string::npos)
            {
                std::string line = pending.substr(0, newline);
                pending.erase(0, newline + 1);
                while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
                if (line == "cancel" || line == "stop")
                {
                    Log("stdin: %s", line.c_str());
                    g_cancel = true;
                }
                else if (!line.empty())
                {
                    // Anything else is a live command for the running mode (desktop: "look ...", "split 0|1").
                    std::lock_guard<std::mutex> lock(g_commandLock);
                    if (g_commands.size() < 64) g_commands.push_back(line);
                }
            }
        }
    }).detach();
}

double NowMs()
{
    static LARGE_INTEGER frequency = {};
    if (frequency.QuadPart == 0) QueryPerformanceFrequency(&frequency);
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return static_cast<double>(now.QuadPart) * 1000.0 / static_cast<double>(frequency.QuadPart);
}

std::wstring FileNameOf(const std::wstring &path)
{
    const size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? path : path.substr(slash + 1);
}

std::wstring StemOf(const std::wstring &path)
{
    std::wstring name = FileNameOf(path);
    const size_t dot = name.find_last_of(L'.');
    return dot == std::wstring::npos || dot == 0 ? name : name.substr(0, dot);
}

std::wstring ExtensionOf(const std::wstring &path)
{
    std::wstring name = FileNameOf(path);
    const size_t dot = name.find_last_of(L'.');
    if (dot == std::wstring::npos) return {};
    std::wstring ext = name.substr(dot);
    for (wchar_t &c : ext) c = static_cast<wchar_t>(towlower(c));
    return ext;
}

std::wstring DirectoryOf(const std::wstring &path)
{
    const size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
}

bool FileExists(const std::wstring &path)
{
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool DirectoryExists(const std::wstring &path)
{
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool EnsureDirectory(const std::wstring &path)
{
    if (path.empty()) return false;
    if (DirectoryExists(path)) return true;
    const std::wstring parent = DirectoryOf(path);
    if (!parent.empty() && parent != path && !(parent.size() == 2 && parent[1] == L':')) EnsureDirectory(parent);
    return CreateDirectoryW(path.c_str(), nullptr) != 0 || DirectoryExists(path);
}

unsigned long long FileSize(const std::wstring &path)
{
    WIN32_FILE_ATTRIBUTE_DATA data = {};
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) return 0;
    return (static_cast<unsigned long long>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
}
} // namespace dm
