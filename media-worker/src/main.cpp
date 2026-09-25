// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - entry point. Apache-2.0.
//
//   dlss5-media.exe --mode image|video|desktop|probe --nr <nvngx_dlssnr.dll> --bridge <nvngx.dll>
//                   [--list <utf8 file of "input<TAB>output" lines> | --in <file> --out <file> ...]
//                   [--style 0..2] [--intensity 0..1] [--tone 0..2] [--structure 0..2] [--skin -1|0..0.99]
//                   [--automask 0|1] [--passes 1..3] [--mix 0..1] [--max-work-mp <megapixels, 0 = full>]
//                   [--refine 1..16] [--codec h264|hevc] [--quality standard|high|max] [--audio copy|aac|none]
//                   [--stabilize 0..1] [--motion-to-nr 0|1] [--scene-cut 0..1] [--jpeg-quality 1..100]
//                   [--monitor -1|n] [--fps-cap n] [--split 0|1] [--present dcomp|hwnd] [--overlay-check 1]
//                   [--gpu n] [--log <file>]
//
// Everything the installer needs to know arrives as one JSON object per line
// on stdout. "cancel" / "stop" on stdin, or closing stdin, ends the work.
#include "jobs.h"

#include <objbase.h>
#include <shellapi.h>
#include <dxgi1_6.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>

#define DLSS5_MEDIA_VERSION "1.1.0"

namespace dm
{
namespace
{
LONG WINAPI CrashFilter(EXCEPTION_POINTERS *info)
{
    const unsigned long code = info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0;
    void *address = info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionAddress : nullptr;
    HMODULE module = nullptr;
    wchar_t name[MAX_PATH] = L"?";
    if (address && GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            static_cast<LPCWSTR>(address), &module))
        GetModuleFileNameW(module, name, MAX_PATH);
    char buffer[512];
    snprintf(buffer, sizeof(buffer), "{\"event\":\"crash\",\"code\":\"0x%08lX\",\"module\":\"%s\",\"offset\":\"0x%llX\"}\n", code,
        JsonEscape(Utf8(FileNameOf(name))).c_str(),
        static_cast<unsigned long long>(reinterpret_cast<const char *>(address) - reinterpret_cast<const char *>(module)));
    fputs(buffer, stdout);
    fflush(stdout);
    Log("CRASH %s", buffer);
    LogClose();
    TerminateProcess(GetCurrentProcess(), 3);
    return EXCEPTION_EXECUTE_HANDLER;
}

float ParseFloat(const std::wstring &text, float fallback)
{
    wchar_t *end = nullptr;
    const double value = wcstod(text.c_str(), &end);
    return end != text.c_str() && std::isfinite(value) ? static_cast<float>(value) : fallback;
}

int ParseInt(const std::wstring &text, int fallback)
{
    wchar_t *end = nullptr;
    const long value = wcstol(text.c_str(), &end, 10);
    return end != text.c_str() ? static_cast<int>(value) : fallback;
}

bool ReadList(const std::wstring &path, std::vector<JobItem> &items)
{
    FILE *file = _wfopen(path.c_str(), L"rb");
    if (!file) return false;
    std::string content;
    char buffer[8192];
    size_t read;
    while ((read = fread(buffer, 1, sizeof(buffer), file)) > 0) content.append(buffer, read);
    fclose(file);
    if (content.size() >= 3 && static_cast<unsigned char>(content[0]) == 0xEF) content.erase(0, 3);
    std::stringstream lines(content);
    std::string line;
    while (std::getline(lines, line))
    {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const size_t tab = line.find('\t');
        if (tab == std::string::npos) continue;
        JobItem item{Wide(line.substr(0, tab)), Wide(line.substr(tab + 1))};
        if (!item.input.empty() && !item.output.empty()) items.push_back(item);
    }
    return true;
}
} // namespace

// Lists the monitors attached to the NVIDIA GPU without starting NGX, so the
// app can offer a choice before desktop mode starts.
bool RunMonitors(int adapterIndex)
{
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) { EmitError("DXGI is unavailable.", true); return false; }
    ComPtr<IDXGIAdapter1> best;
    SIZE_T bestMemory = 0;
    for (UINT index = 0;; ++index)
    {
        ComPtr<IDXGIAdapter1> candidate;
        if (factory->EnumAdapters1(index, &candidate) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_ADAPTER_DESC1 desc = {};
        candidate->GetDesc1(&desc);
        if (adapterIndex >= 0) { if (static_cast<int>(index) == adapterIndex) { best = candidate; break; } continue; }
        if (desc.VendorId != 0x10DE || (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) continue;
        if (!best || desc.DedicatedVideoMemory > bestMemory) { best = candidate; bestMemory = desc.DedicatedVideoMemory; }
    }
    if (!best) { EmitError("No NVIDIA GPU was found.", true); return false; }
    int count = 0;
    for (UINT index = 0;; ++index)
    {
        ComPtr<IDXGIOutput> output;
        if (best->EnumOutputs(index, &output) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_OUTPUT_DESC desc = {};
        output->GetDesc(&desc);
        MONITORINFO info = {};
        info.cbSize = sizeof(info);
        GetMonitorInfoW(desc.Monitor, &info);
        bool hdr = false;
        ComPtr<IDXGIOutput6> output6;
        DXGI_OUTPUT_DESC1 desc1 = {};
        if (SUCCEEDED(output.As(&output6)) && SUCCEEDED(output6->GetDesc1(&desc1))) hdr = desc1.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
        JsonLine("monitor").Int("index", index).WStr("name", desc.DeviceName)
            .Int("width", desc.DesktopCoordinates.right - desc.DesktopCoordinates.left)
            .Int("height", desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top)
            .Bool("primary", (info.dwFlags & MONITORINFOF_PRIMARY) != 0).Bool("hdr", hdr).Emit();
        ++count;
    }
    JsonLine("monitors").Int("count", count).Emit();
    return true;
}

bool RunProbe(Engine &engine, const Settings &settings)
{
    // A synthetic 256x256 picture: gradients, edges and a soft round shape.
    const unsigned size = 256;
    std::vector<unsigned char> pixels(size * size * 4), result(size * size * 4);
    for (unsigned y = 0; y < size; ++y)
        for (unsigned x = 0; x < size; ++x)
        {
            unsigned char *p = &pixels[(y * size + x) * 4];
            const float fx = x / 255.0f, fy = y / 255.0f;
            const float dx = fx - 0.5f, dy = fy - 0.55f;
            const float disc = std::max(0.0f, 1.0f - std::sqrt(dx * dx + dy * dy) * 3.2f);
            const bool check = ((x / 16) + (y / 16)) % 2 == 0;
            p[0] = static_cast<unsigned char>(std::min(255.0f, 40 + 150 * fx + 60 * disc + (check ? 10 : 0)));
            p[1] = static_cast<unsigned char>(std::min(255.0f, 60 + 120 * fy + 50 * disc));
            p[2] = static_cast<unsigned char>(std::min(255.0f, 90 + 80 * (1 - fx) + 40 * disc));
            p[3] = 255;
        }
    NrLook look = settings.look;
    if (!engine.Configure(size, size, SourceKind::Rgba8, OutputKind::Rgba8, 0, look, false)) return false;
    const double started = NowMs();
    FrameStats stats;
    FrameArgs args;
    args.readback = true;
    if (!engine.UploadSource(pixels.data(), static_cast<int>(size * 4)) || !engine.Process(args, &stats) ||
        !engine.ReadResult(result.data(), static_cast<int>(size * 4)))
    {
        JsonLine("probe").Bool("ok", false).Str("message", "the probe frame did not complete").Emit();
        return false;
    }
    double change = 0.0;
    size_t changedPixels = 0;
    for (size_t i = 0; i < pixels.size(); i += 4)
    {
        const int d = std::abs(int(result[i]) - int(pixels[i])) + std::abs(int(result[i + 1]) - int(pixels[i + 1])) + std::abs(int(result[i + 2]) - int(pixels[i + 2]));
        change += d;
        if (d > 3) ++changedPixels;
    }
    change /= (pixels.size() / 4) * 3.0 * 255.0;
    const bool black = std::all_of(result.begin(), result.end(), [](unsigned char v) { return v == 0; });
    const bool ok = !black && changedPixels > 0;
    JsonLine("probe").Bool("ok", ok).Num("ms", NowMs() - started).Num("nrMs", stats.nrMs).Num("change", change)
        .Num("changedFraction", static_cast<double>(changedPixels) / (size * size)).Bool("black", black).Emit();
    return ok;
}
} // namespace dm

int wmain(int argc, wchar_t **argv)
{
    using namespace dm;
    SetUnhandledExceptionFilter(CrashFilter);
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
    // Physical pixels everywhere: the overlay must cover the monitor 1:1 at any
    // display scaling, and DuplicateOutput1 wants a per-monitor-aware caller.
    {
        using SetContext = BOOL(WINAPI *)(DPI_AWARENESS_CONTEXT);
        if (auto set = reinterpret_cast<SetContext>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext")))
            set(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    setvbuf(stdout, nullptr, _IOFBF, 1 << 16);

    std::wstring mode, nrPath, bridgePath, logPath, listPath;
    std::vector<JobItem> items;
    std::wstring pendingInput;
    Settings settings;
    int gpu = -1;
    for (int i = 1; i < argc; ++i)
    {
        const std::wstring key = argv[i];
        const std::wstring value = i + 1 < argc ? argv[i + 1] : L"";
        auto take = [&]() { ++i; return value; };
        if (key == L"--mode") mode = take();
        else if (key == L"--nr") nrPath = take();
        else if (key == L"--bridge") bridgePath = take();
        else if (key == L"--log") logPath = take();
        else if (key == L"--list") listPath = take();
        else if (key == L"--in") pendingInput = take();
        else if (key == L"--out") { items.push_back({pendingInput, take()}); pendingInput.clear(); }
        else if (key == L"--style") settings.look.style = std::clamp(ParseInt(take(), 0), 0, 2);
        else if (key == L"--intensity") settings.look.intensity = std::clamp(ParseFloat(take(), 1.0f), 0.0f, 1.0f);
        else if (key == L"--tone") settings.look.tone = std::clamp(ParseFloat(take(), 1.0f), 0.0f, 2.0f);
        else if (key == L"--structure") settings.look.structure = std::clamp(ParseFloat(take(), 1.0f), 0.0f, 2.0f);
        else if (key == L"--skin") { const float s = ParseFloat(take(), -1.0f); settings.look.skin = s < 0.0f ? -1.0f : std::min(s, 0.99f); }
        else if (key == L"--automask") settings.look.autoMask = ParseInt(take(), 1) != 0;
        else if (key == L"--passes") settings.look.passes = std::clamp(ParseInt(take(), 1), 1, 3);
        else if (key == L"--mix") settings.mix = std::clamp(ParseFloat(take(), 1.0f), 0.0f, 1.0f);
        else if (key == L"--max-work-mp")
        {
            const float mp = ParseFloat(take(), 8.3f);
            settings.maxWorkPixels = mp <= 0.0f ? 0ull : static_cast<unsigned long long>(std::clamp(mp, 0.1f, 268.0f) * 1.0e6);
        }
        else if (key == L"--refine") settings.refine = std::clamp(ParseInt(take(), 1), 1, 16);
        else if (key == L"--codec") settings.codec = Utf8(take()) == "hevc" ? "hevc" : "h264";
        else if (key == L"--quality") { const std::string q = Utf8(take()); settings.quality = (q == "standard" || q == "max") ? q : "high"; }
        else if (key == L"--audio") { const std::string a = Utf8(take()); settings.audio = (a == "aac" || a == "none") ? a : "copy"; }
        else if (key == L"--stabilize") settings.stabilize = std::clamp(ParseFloat(take(), 0.6f), 0.0f, 1.0f);
        else if (key == L"--motion-to-nr") settings.motionToNr = ParseInt(take(), 0) != 0;
        else if (key == L"--scene-cut") settings.sceneCut = std::clamp(ParseFloat(take(), 0.24f), 0.02f, 1.0f);
        else if (key == L"--jpeg-quality") settings.jpegQuality = std::clamp(ParseInt(take(), 95), 1, 100);
        else if (key == L"--monitor") settings.monitor = ParseInt(take(), -1);
        else if (key == L"--fps-cap") settings.fpsCap = std::clamp(ParseInt(take(), 60), 0, 480);
        else if (key == L"--gpu") gpu = ParseInt(take(), -1);
        else if (key == L"--passthrough") settings.passthrough = ParseInt(take(), 0) != 0;
        else if (key == L"--duration") settings.durationSeconds = std::clamp(static_cast<double>(ParseFloat(take(), 0.0f)), 0.0, 86400.0);
        else if (key == L"--snapshot-dir") settings.snapshotDir = take();
        else if (key == L"--diff-dump") settings.diffDumpDir = take();
        else if (key == L"--split") settings.split = ParseInt(take(), 0) != 0;
        else if (key == L"--present") settings.present = Utf8(take()) == "hwnd" ? "hwnd" : "dcomp";
        else if (key == L"--overlay-check") settings.overlayCheck = std::clamp(ParseInt(take(), 0), 0, 2);
        else if (key == L"--version") { printf("{\"event\":\"version\",\"version\":\"%s\"}\n", DLSS5_MEDIA_VERSION); return 0; }
    }

    if (!logPath.empty()) { EnsureDirectory(DirectoryOf(logPath)); LogOpen(logPath); }
    JsonLine("hello").Str("version", DLSS5_MEDIA_VERSION).Str("mode", Utf8(mode)).Int("pid", GetCurrentProcessId()).Emit();
    if (!listPath.empty() && !ReadList(listPath, items)) { EmitError("The job list could not be read.", true); return 2; }
    if (mode == L"monitors")
    {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        const bool ok = RunMonitors(gpu);
        JsonLine("done").Bool("ok", ok).Bool("cancelled", false).Int("exitCode", ok ? 0 : 5).Emit();
        fflush(stdout);
        return ok ? 0 : 5;
    }
    if (mode != L"image" && mode != L"video" && mode != L"desktop" && mode != L"probe") { EmitError("Unknown mode.", true); return 2; }
    if ((mode == L"image" || mode == L"video") && items.empty()) { EmitError("Nothing to process.", true); return 2; }
    if (settings.passthrough && (mode == L"desktop" || mode == L"probe")) { EmitError("Passthrough is for pictures and videos only.", true); return 2; }
    if (!settings.passthrough && (nrPath.empty() || bridgePath.empty())) { EmitError("The runtime paths were not given.", true); return 2; }
    if (mode == L"desktop") SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) { EmitError("COM could not start.", true); return 2; }
    StartStdinWatcher();

    int exitCode = 0;
    if (settings.passthrough)
    {
        JsonLine("ready").Bool("passthrough", true).Emit();
        const bool ok = mode == L"image" ? RunImages(nullptr, items, settings) : RunVideos(nullptr, items, settings);
        exitCode = ok ? 0 : (g_cancel ? 1 : 6);
    }
    else
    {
        Engine engine;
        if (!engine.Initialize(nrPath, bridgePath, gpu))
        {
            exitCode = 5;
        }
        else
        {
            const EngineInfo &info = engine.Info();
            JsonLine("ready").WStr("gpu", info.adapter).Int("vramMB", static_cast<long long>(info.vramBytes >> 20)).Str("driver", info.driver)
                .Int("style", settings.look.style).Num("intensity", settings.look.intensity).Num("tone", settings.look.tone)
                .Num("structure", settings.look.structure).Num("skin", settings.look.skin).Bool("autoMask", settings.look.autoMask)
                .Int("passes", settings.look.passes).Num("mix", settings.mix).Num("maxWorkMP", settings.maxWorkPixels / 1.0e6)
                .Num("stabilize", settings.stabilize).Bool("motionToNr", settings.motionToNr).Emit();
            bool ok = false;
            if (mode == L"image") ok = RunImages(&engine, items, settings);
            else if (mode == L"video") ok = RunVideos(&engine, items, settings);
            else if (mode == L"desktop") ok = RunDesktop(engine, settings);
            else ok = RunProbe(engine, settings);
            exitCode = ok ? 0 : (g_cancel ? 1 : 6);
        }
    }
    JsonLine("done").Bool("ok", exitCode == 0).Bool("cancelled", g_cancel.load()).Int("exitCode", exitCode).Emit();
    LogClose();
    CoUninitialize();
    fflush(stdout);
    // NGX is never unloaded (see engine.cpp): leave without running DLL detach.
    TerminateProcess(GetCurrentProcess(), static_cast<UINT>(exitCode));
    return exitCode;
}
