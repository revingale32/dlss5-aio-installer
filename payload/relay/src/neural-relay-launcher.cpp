// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// neural-relay-launcher.addon32 / .addon64 — tiny ReShade add-on that lives IN the game folder and
// auto-starts neural-relay.exe when the game starts, so a 32-bit game (Aliens vs. Predator 2010)
// gets DLSS neural rendering by just pressing Play in Steam. It does no rendering itself.
//
// Config (optional) — neural-relay-launcher.ini next to this add-on:
//   [NeuralRelay]
//   Path=C:\Users\you\Desktop\DLSS 5\relay\neural-relay.exe
//   Args=--borderless
//   FpsCap=auto          frame-rate cap for the GAME (auto = monitor refresh rate capped at 90, 0 = off, or a number)
// Without an ini it looks for <game folder>\neural-relay\neural-relay.exe.
//
// Why a frame cap lives here: the relay's neural passes share the GPU with the game. An old game left
// uncapped renders 300+ fps and starves the neural work (measured: NR 7 ms -> 45-60 ms). Capping the
// game at the monitor's refresh rate from inside its own Present gives the GPU back to the relay.
//
// Build (32-bit): clang++ --target=i686-w64-mingw32 -shared -O2 neural-relay-launcher.cpp -o neural-relay-launcher.addon32 ...
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <wchar.h>
#include <initializer_list>
#include <mmsystem.h>

extern "C" __declspec(dllexport) const char *NAME = "Neural Relay Launcher";
extern "C" __declspec(dllexport) const char *DESCRIPTION = "Starts neural-relay.exe (DLSS neural rendering overlay) when this game starts.";

static HMODULE g_self = nullptr;
static bool g_registered = false;

static void Log(const wchar_t *msg) {
    wchar_t path[MAX_PATH]; GetModuleFileNameW(g_self, path, MAX_PATH);
    wchar_t *s = wcsrchr(path, L'\\'); if (s) s[1] = 0; wcscat(path, L"neural-relay-launcher.log");
    HANDLE h = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    char buf[1200]; SYSTEMTIME t; GetLocalTime(&t);
    int n = wsprintfA(buf, "%02u:%02u:%02u ", t.wHour, t.wMinute, t.wSecond);
    n += WideCharToMultiByte(CP_UTF8, 0, msg, -1, buf + n, sizeof buf - n - 3, nullptr, nullptr) - 1;
    buf[n++] = '\r'; buf[n++] = '\n'; DWORD w; WriteFile(h, buf, n, &w, nullptr); CloseHandle(h);
}

static DWORD WINAPI LaunchThread(void *) {
    Sleep(2500);   // let the game get its window up first
    if (HANDLE m = OpenMutexW(SYNCHRONIZE, FALSE, L"Local\\NeuralRelayRunning")) { CloseHandle(m); Log(L"relay already running - not starting another"); return 0; }

    wchar_t gamedir[MAX_PATH]; GetModuleFileNameW(g_self, gamedir, MAX_PATH);
    if (wchar_t *s = wcsrchr(gamedir, L'\\')) s[1] = 0;
    wchar_t exe[MAX_PATH]; GetModuleFileNameW(nullptr, exe, MAX_PATH);
    const wchar_t *exename = wcsrchr(exe, L'\\'); exename = exename ? exename + 1 : exe;

    wchar_t ini[MAX_PATH]; wcscpy(ini, gamedir); wcscat(ini, L"neural-relay-launcher.ini");
    wchar_t relay[MAX_PATH] = {}, args[512] = {};
    GetPrivateProfileStringW(L"NeuralRelay", L"Path", L"", relay, MAX_PATH, ini);
    GetPrivateProfileStringW(L"NeuralRelay", L"Args", L"--borderless", args, 512, ini);
    if (!relay[0] || GetFileAttributesW(relay) == INVALID_FILE_ATTRIBUTES) { wcscpy(relay, gamedir); wcscat(relay, L"neural-relay\\neural-relay.exe"); }
    if (GetFileAttributesW(relay) == INVALID_FILE_ATTRIBUTES) { wchar_t m[600]; wsprintfW(m, L"neural-relay.exe not found (ini Path or %s) - nothing started", relay); Log(m); return 0; }
    wchar_t relaydir[MAX_PATH]; wcscpy(relaydir, relay); if (wchar_t *s = wcsrchr(relaydir, L'\\')) *s = 0;

    wchar_t cmd[2048];
    wsprintfW(cmd, L"\"%s\" --exe \"%s\" --wait 120 %s --log \"%s\\neural-relay.log\"", relay, exename, args, relaydir);
    STARTUPINFOW si = {}; si.cb = sizeof si; PROCESS_INFORMATION pi = {};
    if (CreateProcessW(relay, cmd, nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, relaydir, &si, &pi)) {
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        wchar_t m[2200]; wsprintfW(m, L"started: %s", cmd); Log(m);
    } else { wchar_t m[200]; wsprintfW(m, L"CreateProcess failed (%lu)", GetLastError()); Log(m); }
    return 0;
}

// ---- game frame-rate cap (ReShade 'present' event, API 20 = event 74), paced on the game's render thread ----
static double g_capFps = 0; static LARGE_INTEGER g_qpf = {}; static LONGLONG g_nextDeadline = 0; static HANDLE g_timer = nullptr;
static bool g_capLogged = false;
static void ResolveCap(const wchar_t *ini) {
    wchar_t v[64] = {}; GetPrivateProfileStringW(L"NeuralRelay", L"FpsCap", L"auto", v, 64, ini);
    if (_wcsicmp(v, L"auto") == 0 || !v[0]) {
        // auto = the monitor's refresh rate, but never above 90: the relay's neural output tops out around
        // 80-90 fps per pass on a 5070 Ti at 1440p, and every game frame beyond what the relay can turn
        // into a neural frame is pure GPU contention. On a 480 Hz panel "refresh rate" would be no cap at all.
        DEVMODEW dm = {}; dm.dmSize = sizeof dm; g_capFps = 60;
        if (EnumDisplaySettingsW(nullptr, ENUM_CURRENT_SETTINGS, &dm) && dm.dmDisplayFrequency >= 30) g_capFps = (double)dm.dmDisplayFrequency;
        if (g_capFps > 90) g_capFps = 90;
    } else g_capFps = _wtof(v);
    if (g_capFps < 0) g_capFps = 0; if (g_capFps > 0 && g_capFps < 24) g_capFps = 24; if (g_capFps > 480) g_capFps = 480;
    QueryPerformanceFrequency(&g_qpf);
    g_timer = CreateWaitableTimerExW(nullptr, nullptr, 0x2 /*CREATE_WAITABLE_TIMER_HIGH_RESOLUTION*/, TIMER_ALL_ACCESS);
    if (!g_timer) g_timer = CreateWaitableTimerW(nullptr, TRUE, nullptr);
    timeBeginPeriod(1);
}
static void OnPresent(void *, void *, const void *, const void *, uint32_t, const void *) {
    if (g_capFps <= 0 || g_qpf.QuadPart == 0) return;
    if (!g_capLogged) { g_capLogged = true; wchar_t m[128]; wsprintfW(m, L"frame cap active: game limited to %d fps (FpsCap in neural-relay-launcher.ini)", (int)(g_capFps + 0.5)); Log(m); }
    const LONGLONG period = (LONGLONG)((double)g_qpf.QuadPart / g_capFps);
    LARGE_INTEGER now; QueryPerformanceCounter(&now);
    if (g_nextDeadline == 0) g_nextDeadline = now.QuadPart;
    const LONGLONG target = g_nextDeadline;
    if (now.QuadPart < target) {
        double ms = (double)(target - now.QuadPart) * 1000.0 / (double)g_qpf.QuadPart;
        if (ms > 1.5 && g_timer) {   // sleep all but the last millisecond on a high-resolution timer, then spin
            LARGE_INTEGER due; due.QuadPart = -(LONGLONG)((ms - 1.0) * 10000.0);
            if (SetWaitableTimer(g_timer, &due, 0, nullptr, nullptr, FALSE)) WaitForSingleObject(g_timer, (DWORD)ms + 2);
        }
        do { YieldProcessor(); QueryPerformanceCounter(&now); } while (now.QuadPart < target);
        g_nextDeadline = target + period;
    } else {
        g_nextDeadline = (now.QuadPart - target > period) ? now.QuadPart + period : target + period;   // late: keep cadence, never burst
    }
}

// The ReShade module is whichever loaded module exports ReShadeRegisterAddon (it may be named dxgi.dll,
// d3d11.dll, d3d9.dll, opengl32.dll ... and the real system DLL of the same name is loaded too).
static HMODULE FindReShade() {
    typedef BOOL (WINAPI *PFN_Enum)(HANDLE, HMODULE *, DWORD, DWORD *);
    auto enumMods = (PFN_Enum)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "K32EnumProcessModules");
    HMODULE mods[512]; DWORD needed = 0;
    if (!enumMods || !enumMods(GetCurrentProcess(), mods, sizeof mods, &needed)) return nullptr;
    for (DWORD i = 0; i < needed / sizeof(HMODULE) && i < 512; ++i)
        if (mods[i] != g_self && GetProcAddress(mods[i], "ReShadeRegisterAddon")) return mods[i];
    return nullptr;
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = hModule;
        // Register with whichever ReShade API version the host build speaks (6.8 = 20; fall back for older/newer).
        HMODULE rs = FindReShade();
        if (!rs) return FALSE;
        auto reg = reinterpret_cast<bool(*)(void *, uint32_t)>(GetProcAddress(rs, "ReShadeRegisterAddon"));
        for (uint32_t v : { 20u, 21u, 19u, 18u, 17u, 16u, 22u }) { if (reg(hModule, v)) { g_registered = true; break; } }
        if (!g_registered) return FALSE;
        Log(L"registered with ReShade; launching relay in 2.5 s");
        { wchar_t ini[MAX_PATH]; GetModuleFileNameW(hModule, ini, MAX_PATH); if (wchar_t *q = wcsrchr(ini, L'\\')) q[1] = 0; wcscat(ini, L"neural-relay-launcher.ini");
          ResolveCap(ini);
          if (g_capFps > 0) { if (auto regev = reinterpret_cast<void(*)(uint32_t, void *)>(GetProcAddress(rs, "ReShadeRegisterEvent"))) regev(74 /*addon_event::present, API 20*/, (void *)&OnPresent); } }
        HANDLE t = CreateThread(nullptr, 0, LaunchThread, nullptr, 0, nullptr); if (t) CloseHandle(t);
    } else if (reason == DLL_PROCESS_DETACH && g_registered) {
        if (HMODULE rs = FindReShade()) {
            if (auto unev = reinterpret_cast<void(*)(uint32_t, void *)>(GetProcAddress(rs, "ReShadeUnregisterEvent"))) unev(74, (void *)&OnPresent);
            if (auto un = reinterpret_cast<void(*)(void *)>(GetProcAddress(rs, "ReShadeUnregisterAddon"))) un(hModule);
        }
        if (g_timer) CloseHandle(g_timer);
    }
    return TRUE;
}
