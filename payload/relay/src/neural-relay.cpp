// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// neural-relay.exe — brute-force DLSS neural rendering for games the kit can't be injected into
// (32-bit games like Aliens vs. Predator 2010, DX9/OpenGL games, anything).
//
// How it works (same architecture as Lossless Scaling / Magpie):
//   1. Captures the target game's WINDOW with Windows Graphics Capture (GPU-side, per-window,
//      works even when the window is covered by our overlay).
//   2. Draws each captured frame into its own D3D11 swapchain on a topmost, click-through overlay
//      window that tracks the game window. Keyboard/mouse pass straight through to the game.
//   3. The normal 64-bit ReShade (dxgi.dll) + standalone-dlssnr.addon64 sit next to THIS exe, so
//      they hook the relay's swapchain and run neural rendering on the captured frames — the exact
//      D3D11 path proven on Black Ops III. Nothing inside the game process is touched.
//
// Usage:  neural-relay.exe --exe AvP_DX11.exe        (match the game by its process image name)
//         neural-relay.exe --title "Predator"         (or by window-title substring)
//         optional: --wait 120 (seconds to wait for the window)  --log relay.log
//                   --borderless (strip the game window's frame and pin it to the monitor)
//                   --alt-enter  (game starts in exclusive fullscreen: press Alt+Enter once for the user)
//                   --hdr auto|keep|fp16 (auto: switch the monitor to SDR while the game runs and restore it after;
//                                keep: leave HDR alone (8-bit, washed out on an HDR desktop); fp16: HDR-native experiment)
// Hotkey: Ctrl+Alt+M toggles "interactive" mode so you can open the ReShade menu (Home) inside the
//         relay to tune neural rendering; press it again to hand input back to the game.
//
// v2 changes: real cross-process click-through (WS_EX_LAYERED|WS_EX_TRANSPARENT, the way Magpie's
//   renderer window does it — WM_NCHITTEST/HTTRANSPARENT only works within one thread), per-monitor
//   DPI awareness (window rects were virtualized at >100% scaling), flip-model -> bitblt fallback,
//   overlay hides when the game loses focus, survives the game recreating its window (display-mode
//   switch), and keeps pumping messages while waiting.
//
// Build (Linux, clang + mingw-w64): see BUILD-RELAY.txt next to this file.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <inspectable.h>
#include <roapi.h>
#include <winstring.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dxgi1_4.h>
#include <dxgi1_6.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

#define RELAY_VERSION "2.8"

// --------------------------------------------------------------------------------------------
// WinRT ABI for Windows.Graphics.Capture — declared by hand because mingw's header is partial.
// These are plain COM vtables (declaration order == MSVC order), so there is no ABI risk.
// --------------------------------------------------------------------------------------------
struct SizeInt32 { INT32 Width; INT32 Height; };
enum DirectXPixelFormat : INT32 { DirectXPixelFormat_R16G16B16A16Float = 10, DirectXPixelFormat_B8G8R8A8UIntNormalized = 87 };
struct EventRegistrationToken_ { INT64 value; };

struct IDirect3DDevice_ : IInspectable { virtual HRESULT STDMETHODCALLTYPE Trim() = 0; };
struct IDirect3DSurface_ : IInspectable { virtual HRESULT STDMETHODCALLTYPE get_Description(void *desc) = 0; };
struct IGraphicsCaptureItem_ : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_DisplayName(HSTRING *value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_Size(SizeInt32 *value) = 0;
    virtual HRESULT STDMETHODCALLTYPE add_Closed(void *handler, EventRegistrationToken_ *token) = 0;
    virtual HRESULT STDMETHODCALLTYPE remove_Closed(EventRegistrationToken_ token) = 0;
};
struct IGraphicsCaptureSession_ : IInspectable { virtual HRESULT STDMETHODCALLTYPE StartCapture() = 0; };
struct IGraphicsCaptureSession2_ : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_IsCursorCaptureEnabled(boolean *v) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_IsCursorCaptureEnabled(boolean v) = 0;
};
struct IGraphicsCaptureSession3_ : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_IsBorderRequired(boolean *v) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_IsBorderRequired(boolean v) = 0;
};
struct IDirect3D11CaptureFrame_ : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Surface(IDirect3DSurface_ **value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_SystemRelativeTime(INT64 *value) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_ContentSize(SizeInt32 *value) = 0;
};
struct IDirect3D11CaptureFramePool_ : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE Recreate(IDirect3DDevice_ *device, DirectXPixelFormat fmt, INT32 buffers, SizeInt32 size) = 0;
    virtual HRESULT STDMETHODCALLTYPE TryGetNextFrame(IDirect3D11CaptureFrame_ **frame) = 0;
    virtual HRESULT STDMETHODCALLTYPE add_FrameArrived(void *handler, EventRegistrationToken_ *token) = 0;
    virtual HRESULT STDMETHODCALLTYPE remove_FrameArrived(EventRegistrationToken_ token) = 0;
    virtual HRESULT STDMETHODCALLTYPE CreateCaptureSession(IGraphicsCaptureItem_ *item, IGraphicsCaptureSession_ **session) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_DispatcherQueue(void **queue) = 0;
};
struct IDirect3D11CaptureFramePoolStatics2_ : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE CreateFreeThreaded(IDirect3DDevice_ *device, DirectXPixelFormat fmt, INT32 buffers, SizeInt32 size, IDirect3D11CaptureFramePool_ **pool) = 0;
};
struct IGraphicsCaptureItemInterop_ : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE CreateForWindow(HWND window, REFIID riid, void **result) = 0;
    virtual HRESULT STDMETHODCALLTYPE CreateForMonitor(HMONITOR monitor, REFIID riid, void **result) = 0;
};
struct IDirect3DDxgiInterfaceAccess_ : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetInterface(REFIID iid, void **p) = 0;
};
static const GUID IID_IGraphicsCaptureItem_      = {0x79C3F95B,0x31F7,0x4EC2,{0xA4,0x64,0x63,0x2E,0xF5,0xD3,0x07,0x60}};
static const GUID IID_IGraphicsCaptureItemInterop_= {0x3628E81B,0x3CAC,0x4C60,{0xB7,0xF4,0x23,0xCE,0x0E,0x0C,0x33,0x56}};
static const GUID IID_IDirect3D11CaptureFramePoolStatics2_ = {0x589B103F,0x6BBC,0x5DF5,{0xA9,0x91,0x02,0xE2,0x8B,0x3B,0x66,0xD5}};
static const GUID IID_IGraphicsCaptureSession2_  = {0x2C39AE40,0x7D2E,0x5044,{0x80,0x4E,0x8B,0x67,0x99,0xD4,0xCF,0x9E}};
static const GUID IID_IGraphicsCaptureSession3_  = {0xF2CDD966,0x22AE,0x5EA1,{0x95,0x96,0x3A,0x28,0x93,0x44,0xC3,0xBE}};
static const GUID IID_IDirect3DDxgiInterfaceAccess_ = {0xA9B3D012,0x3DF2,0x4EE3,{0xB8,0xD1,0x86,0x95,0xF4,0x57,0xD3,0xC1}};
typedef HRESULT (WINAPI *PFN_CreateDirect3D11DeviceFromDXGIDevice)(IDXGIDevice *, IInspectable **);

// --------------------------------------------------------------------------------------------
static FILE *g_log = nullptr;
static void Log(const char *fmt, ...) {
    char buf[1024]; va_list a; va_start(a, fmt); vsnprintf(buf, sizeof buf, fmt, a); va_end(a);
    SYSTEMTIME t; GetLocalTime(&t);
    if (g_log) { fprintf(g_log, "%02u:%02u:%02u.%03u %s\n", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, buf); fflush(g_log); }
    printf("%s\n", buf); fflush(stdout);
}
template <typename T> static void SafeRelease(T *&p) { if (p) { p->Release(); p = nullptr; } }

// Per-monitor DPI awareness: without it GetClientRect/ClientToScreen are virtualized at >100% scaling
// and the overlay lands at the wrong place/size.
static void EnableDpiAwareness() {
    typedef HANDLE DPI_CTX; typedef BOOL (WINAPI *PFN_SetCtx)(DPI_CTX); typedef BOOL (WINAPI *PFN_Aware)(void);
    HMODULE u = GetModuleHandleW(L"user32.dll");
    auto setctx = (PFN_SetCtx)GetProcAddress(u, "SetProcessDpiAwarenessContext");
    if (setctx && setctx((DPI_CTX)-4 /*PER_MONITOR_AWARE_V2*/)) { Log("dpi: per-monitor aware v2"); return; }
    auto aware = (PFN_Aware)GetProcAddress(u, "SetProcessDPIAware");
    if (aware && aware()) { Log("dpi: system aware"); return; }
    Log("dpi: could not set awareness (overlay may be mis-sized at >100%% scaling)");
}

// Windows HDR: with HDR on, an 8-bit BGRA capture of the desktop comes back tone-mapped and looks
// washed-out/white. Detect it from the output's advertised color space and switch the whole relay to
// FP16 scRGB (capture + swapchain), which is exact on an HDR desktop.
static bool OutputIsHdr(IDXGIAdapter *adapterIn, HWND target, float *maxNits) {
    HMONITOR mon = MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST);
    // A DXGI factory snapshots display state; make a fresh one so a just-toggled HDR state is visible.
    IDXGIFactory1 *f = nullptr; IDXGIAdapter *adapter = nullptr;
    if (SUCCEEDED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void **)&f))) { DXGI_ADAPTER_DESC ad; adapterIn->GetDesc(&ad);
        for (UINT i = 0; f->EnumAdapters(i, &adapter) == S_OK; ++i) { DXGI_ADAPTER_DESC d; adapter->GetDesc(&d); if (d.AdapterLuid.LowPart == ad.AdapterLuid.LowPart && d.AdapterLuid.HighPart == ad.AdapterLuid.HighPart) break; adapter->Release(); adapter = nullptr; } }
    if (!adapter) { adapter = adapterIn; adapter->AddRef(); }
    struct Rel { IDXGIFactory1 *f; IDXGIAdapter *a; ~Rel() { if (a) a->Release(); if (f) f->Release(); } } rel{f, adapter};
    for (UINT i = 0;; ++i) {
        IDXGIOutput *out = nullptr; if (adapter->EnumOutputs(i, &out) != S_OK || !out) break;
        IDXGIOutput6 *out6 = nullptr; bool hdr = false;
        if (SUCCEEDED(out->QueryInterface(__uuidof(IDXGIOutput6), (void **)&out6))) {
            DXGI_OUTPUT_DESC1 d = {}; if (SUCCEEDED(out6->GetDesc1(&d)) && d.Monitor == mon) {
                hdr = d.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020; if (maxNits) *maxNits = d.MaxLuminance;
                Log("display '%ls': color space %d (%s), %.0f-%.0f nits, bpc %u", d.DeviceName, (int)d.ColorSpace, hdr ? "HDR on" : "SDR", d.MinLuminance, d.MaxLuminance, d.BitsPerColor);
                out6->Release(); out->Release(); return hdr;
            }
            out6->Release();
        }
        out->Release();
    }
    return false;
}

// Windows HDR off/on for one monitor (what Win+Alt+B does), via the DisplayConfig advanced-color API.
// SDR games captured through an HDR desktop come back tone-mapped (washed out), and the neural
// add-on's HDR path on scRGB input looks wrong; the proven path is plain 8-bit sRGB, so we switch the
// monitor to SDR for the session and put it back when the game closes.
struct HdrTarget { LUID adapter; UINT32 id; bool valid = false; };
static HdrTarget FindHdrTarget(HWND target) {
    HdrTarget t; MONITORINFOEXW mi = {}; mi.cbSize = sizeof mi;
    if (!GetMonitorInfoW(MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST), &mi)) return t;
    UINT32 np = 0, nm = 0; if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &np, &nm) != ERROR_SUCCESS) return t;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(np); std::vector<DISPLAYCONFIG_MODE_INFO> modes(nm);
    if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &np, paths.data(), &nm, modes.data(), nullptr) != ERROR_SUCCESS) return t;
    for (UINT32 i = 0; i < np; ++i) {
        DISPLAYCONFIG_SOURCE_DEVICE_NAME sn = {}; sn.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME; sn.header.size = sizeof sn;
        sn.header.adapterId = paths[i].sourceInfo.adapterId; sn.header.id = paths[i].sourceInfo.id;
        if (DisplayConfigGetDeviceInfo(&sn.header) != ERROR_SUCCESS) continue;
        if (_wcsicmp(sn.viewGdiDeviceName, mi.szDevice) == 0) { t.adapter = paths[i].targetInfo.adapterId; t.id = paths[i].targetInfo.id; t.valid = true; return t; }
    }
    return t;
}
static int GetHdrState(const HdrTarget &t) {   // -1 unknown, 0 off, 1 on
    if (!t.valid) return -1;
    DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO ci = {}; ci.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO; ci.header.size = sizeof ci;
    ci.header.adapterId = t.adapter; ci.header.id = t.id;
    if (DisplayConfigGetDeviceInfo(&ci.header) != ERROR_SUCCESS) return -1;
    if (!ci.advancedColorSupported) return 0;
    return ci.advancedColorEnabled ? 1 : 0;
}
static bool SetHdrState(const HdrTarget &t, bool on) {
    if (!t.valid) return false;
    DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE st = {}; st.header.type = DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE; st.header.size = sizeof st;
    st.header.adapterId = t.adapter; st.header.id = t.id; st.enableAdvancedColor = on ? 1 : 0;
    LONG r = DisplayConfigSetDeviceInfo(&st.header);
    Log("hdr: Windows HDR %s for this monitor -> %s (%ld)", on ? "ON" : "OFF", r == ERROR_SUCCESS ? "ok" : "failed", r);
    return r == ERROR_SUCCESS;
}

// --------------------------------------------------------------------------------------------
// Target window lookup
// --------------------------------------------------------------------------------------------
struct FindCtx { std::wstring exe, title; HWND found = nullptr; };
static DWORD WindowPid(HWND hwnd) { DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid); return pid; }
static std::wstring ProcessImageName(HWND hwnd) {
    DWORD pid = WindowPid(hwnd); if (!pid) return L"";
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid); if (!h) return L"";
    wchar_t path[MAX_PATH] = {}; DWORD n = MAX_PATH; std::wstring r;
    if (QueryFullProcessImageNameW(h, 0, path, &n)) { const wchar_t *s = wcsrchr(path, L'\\'); r = s ? s + 1 : path; }
    CloseHandle(h); return r;
}
static BOOL CALLBACK EnumProc(HWND hwnd, LPARAM lp) {
    auto *c = reinterpret_cast<FindCtx *>(lp);
    if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
    if (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE;
    RECT rc; GetClientRect(hwnd, &rc); if (rc.right < 200 || rc.bottom < 150) return TRUE;
    if (!c->exe.empty()) { if (_wcsicmp(ProcessImageName(hwnd).c_str(), c->exe.c_str()) != 0) return TRUE; }
    if (!c->title.empty()) { wchar_t t[512] = {}; GetWindowTextW(hwnd, t, 512); std::wstring tl = t, nl = c->title;
        for (auto &ch : tl) ch = towlower(ch); for (auto &ch : nl) ch = towlower(ch);
        if (tl.find(nl) == std::wstring::npos) return TRUE; }
    if (c->exe.empty() && c->title.empty()) return TRUE;
    c->found = hwnd; return FALSE;
}
static HWND FindTarget(const std::wstring &exe, const std::wstring &title) {
    FindCtx c; c.exe = exe; c.title = title; EnumWindows(EnumProc, reinterpret_cast<LPARAM>(&c)); return c.found;
}
// --borderless: strip the game's title bar/frame and pin the client area to the monitor (what the
// "Borderless Gaming" tool does). Keeps the game's own client size so it does not re-create its
// swapchain; a client that matches the desktop becomes a perfect borderless fullscreen.
static void MakeBorderless(HWND target) {
    LONG st = GetWindowLongW(target, GWL_STYLE);
    if (!(st & (WS_CAPTION | WS_THICKFRAME))) { Log("borderless: game window already has no frame"); return; }
    RECT crc; GetClientRect(target, &crc); int cw = crc.right, ch = crc.bottom;
    if (cw < 200 || ch < 150) { Log("borderless: game window is %dx%d right now (mid mode-switch); leaving it alone", cw, ch); return; }
    HMONITOR mon = MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST); MONITORINFO mi = {}; mi.cbSize = sizeof mi; GetMonitorInfoW(mon, &mi);
    int mw = mi.rcMonitor.right - mi.rcMonitor.left, mh = mi.rcMonitor.bottom - mi.rcMonitor.top;
    st &= ~(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER | WS_DLGFRAME);
    st |= WS_POPUP; SetWindowLongW(target, GWL_STYLE, st);
    LONG ex = GetWindowLongW(target, GWL_EXSTYLE);
    ex &= ~(WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_WINDOWEDGE); SetWindowLongW(target, GWL_EXSTYLE, ex);
    // A client within 64 px of the monitor (title bar / frame ate a few rows) snaps to the full monitor,
    // so the game re-sizes its swapchain to exactly the screen and the picture stays 1:1.
    if (abs(cw - mw) <= 64 && abs(ch - mh) <= 64) { cw = mw; ch = mh; }
    int x = mi.rcMonitor.left + (cw >= mw ? 0 : (mw - cw) / 2), y = mi.rcMonitor.top + (ch >= mh ? 0 : (mh - ch) / 2);
    SetWindowPos(target, nullptr, x, y, cw, ch, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    Log("borderless: frame stripped, client %dx%d placed at %d,%d on a %dx%d monitor", cw, ch, x, y, mw, mh);
}
// --alt-enter: the game came up in exclusive fullscreen (no frame, covers the monitor). Nothing can be
// overlaid on that, so press Alt+Enter for the user exactly once (DXGI's built-in toggle) and wait for
// the window to become a normal window; --borderless then strips the frame again.
static bool LooksExclusiveFullscreen(HWND target) {
    LONG st = GetWindowLongW(target, GWL_STYLE); if ((st & WS_CAPTION) == WS_CAPTION) return false;
    RECT wr; GetWindowRect(target, &wr);
    HMONITOR mon = MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST); MONITORINFO mi = {}; mi.cbSize = sizeof mi; GetMonitorInfoW(mon, &mi);
    return wr.left <= mi.rcMonitor.left && wr.top <= mi.rcMonitor.top && wr.right >= mi.rcMonitor.right && wr.bottom >= mi.rcMonitor.bottom;
}
static bool PressAltEnter(HWND target) {
    SetForegroundWindow(target); Sleep(150);
    if (GetForegroundWindow() != target) { Log("alt-enter: game is not the foreground window; not sending"); return false; }
    INPUT in[4] = {};
    in[0].type = INPUT_KEYBOARD; in[0].ki.wVk = VK_MENU;
    in[1].type = INPUT_KEYBOARD; in[1].ki.wVk = VK_RETURN;
    in[2].type = INPUT_KEYBOARD; in[2].ki.wVk = VK_RETURN; in[2].ki.dwFlags = KEYEVENTF_KEYUP;
    in[3].type = INPUT_KEYBOARD; in[3].ki.wVk = VK_MENU;   in[3].ki.dwFlags = KEYEVENTF_KEYUP;
    UINT sent = SendInput(4, in, sizeof(INPUT));
    Log("alt-enter: sent (%u/4 events) to leave exclusive fullscreen", sent);
    for (int i = 0; i < 40; ++i) { Sleep(100); if ((GetWindowLongW(target, GWL_STYLE) & WS_CAPTION) == WS_CAPTION) { Log("alt-enter: game is windowed now"); Sleep(700); return true; } }
    Log("alt-enter: game did not switch to a framed window within 4 s (may already be borderless)");
    return false;
}
// Wait until the game window has held a real size for ~1 s: during a display-mode switch it can be
// 0x0 or oversized for a moment, and acting on that (we once shrank AvP's window to 0x0) breaks things.
static bool WaitForSettledWindow(HWND target, RECT &out, int maxMs);
static bool TargetClientRectOnScreen(HWND target, RECT &out) {
    RECT rc; if (!GetClientRect(target, &rc)) return false;
    POINT tl{rc.left, rc.top}, br{rc.right, rc.bottom};
    ClientToScreen(target, &tl); ClientToScreen(target, &br);
    out = {tl.x, tl.y, br.x, br.y};
    return (out.right - out.left) > 0 && (out.bottom - out.top) > 0;
}

static bool WaitForSettledWindow(HWND target, RECT &out, int maxMs) {
    int stable = 0; RECT last = {};
    for (int t = 0; t < maxMs && IsWindow(target); t += 100) {
        RECT r; bool ok = TargetClientRectOnScreen(target, r) && (r.right - r.left) >= 200 && (r.bottom - r.top) >= 150 && !IsIconic(target);
        if (ok && r.left == last.left && r.top == last.top && r.right == last.right && r.bottom == last.bottom) { if (++stable >= 8) { out = r; return true; } }
        else stable = 0;
        last = ok ? r : RECT{}; Sleep(100);
    }
    return false;
}

// --------------------------------------------------------------------------------------------
// Overlay window
// --------------------------------------------------------------------------------------------
static bool g_interactive = false;   // false = click-through, never activates (game keeps input)
static const DWORD kPassiveEx = WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT;
static LRESULT CALLBACK OverlayProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    switch (m) {
    case WM_MOUSEACTIVATE: return g_interactive ? MA_ACTIVATE : MA_NOACTIVATE;
    case WM_ERASEBKGND: return 1;
    case WM_CLOSE: PostQuitMessage(0); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(h, m, w, l);
}
static void ApplyInteractive(HWND overlay, HWND target) {
    LONG ex = GetWindowLongW(overlay, GWL_EXSTYLE);
    if (g_interactive) {
        ex &= ~(WS_EX_NOACTIVATE | WS_EX_TRANSPARENT); SetWindowLongW(overlay, GWL_EXSTYLE, ex);
        SetWindowPos(overlay, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED);
        SetForegroundWindow(overlay); SetFocus(overlay);
        Log("interactive: ON (press Home for the ReShade menu; Ctrl+Alt+M gives input back to the game)");
    } else {
        ex |= WS_EX_NOACTIVATE | WS_EX_TRANSPARENT; SetWindowLongW(overlay, GWL_EXSTYLE, ex);
        SetWindowPos(overlay, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        if (target && IsWindow(target)) SetForegroundWindow(target);
        Log("interactive: OFF (input goes to the game)");
    }
}
static void PumpFor(DWORD ms) {
    MSG m; ULONGLONG t0 = GetTickCount64();
    while (GetTickCount64() - t0 < ms) { while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) { if (m.message == WM_QUIT) { PostQuitMessage(0); return; } TranslateMessage(&m); DispatchMessageW(&m); } Sleep(10); }
}
// Home = the relay's ReShade menu, no Ctrl+Alt+M needed: we own Home as a global hotkey while the game runs.
// Opening: take input, then press Home *into ourselves* so ReShade opens its overlay. Closing: press Home
// into ourselves (ReShade closes), then hand input back to the game.
// ReShade samples key state once per presented frame, so the press has to straddle a Present: send
// key-down here, the main loop presents a couple of frames, then HomeFinish() sends key-up.
static ULONGLONG g_homeUpAt = 0; static bool g_homeCloseAfter = false;
static void SendKey(WORD vk, bool up) { INPUT in = {}; in.type = INPUT_KEYBOARD; in.ki.wVk = vk; in.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0; SendInput(1, &in, sizeof in); }
static void HomeToggle(HWND overlay, HWND target) {
    if (g_homeUpAt) return;
    UnregisterHotKey(overlay, 2);
    if (!g_interactive) { g_interactive = true; ApplyInteractive(overlay, target); PumpFor(150); g_homeCloseAfter = false; }
    else g_homeCloseAfter = true;
    SendKey(VK_HOME, false); g_homeUpAt = GetTickCount64() + 120;
    Log("home: %s the relay's ReShade menu", g_homeCloseAfter ? "closing" : "opening");
}
static void HomeFinish(HWND overlay, HWND target) {
    if (!g_homeUpAt || GetTickCount64() < g_homeUpAt) return;
    SendKey(VK_HOME, true); g_homeUpAt = 0; PumpFor(60);
    if (g_homeCloseAfter) { g_interactive = false; ApplyInteractive(overlay, target); }
    RegisterHotKey(overlay, 2, MOD_NOREPEAT, VK_HOME);
}
// Pump the overlay's messages; returns false when asked to quit.
static bool Pump(HWND overlay, HWND target) {
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        if (msg.message == WM_QUIT) return false;
        if (msg.message == WM_HOTKEY && msg.wParam == 1) { g_interactive = !g_interactive; ApplyInteractive(overlay, target); continue; }
        if (msg.message == WM_HOTKEY && msg.wParam == 2) { HomeToggle(overlay, target); continue; }
        TranslateMessage(&msg); DispatchMessageW(&msg);
    }
    return true;
}

// --------------------------------------------------------------------------------------------
// Capture session for one window
// --------------------------------------------------------------------------------------------
struct Capture {
    IGraphicsCaptureItem_ *item = nullptr; IDirect3D11CaptureFramePool_ *pool = nullptr; IGraphicsCaptureSession_ *session = nullptr;
    void Release() { SafeRelease(session); SafeRelease(pool); SafeRelease(item); }
};
static bool StartCapture(Capture &c, HWND target, IDirect3DDevice_ *winrtDev, IGraphicsCaptureItemInterop_ *interop,
                         IDirect3D11CaptureFramePoolStatics2_ *poolStatics, int W, int H, DirectXPixelFormat fmt) {
    c.Release();
    HRESULT hr = interop->CreateForWindow(target, IID_IGraphicsCaptureItem_, (void **)&c.item);
    if (FAILED(hr)) { Log("CreateForWindow failed 0x%08X", hr); return false; }
    SizeInt32 sz{W, H};
    hr = poolStatics->CreateFreeThreaded(winrtDev, fmt, 2, sz, &c.pool);
    if (FAILED(hr)) { Log("CreateFreeThreaded failed 0x%08X", hr); return false; }
    hr = c.pool->CreateCaptureSession(c.item, &c.session);
    if (FAILED(hr)) { Log("CreateCaptureSession failed 0x%08X", hr); return false; }
    { IGraphicsCaptureSession2_ *s2 = nullptr; if (SUCCEEDED(c.session->QueryInterface(IID_IGraphicsCaptureSession2_, (void **)&s2))) { s2->put_IsCursorCaptureEnabled(FALSE); s2->Release(); }
      IGraphicsCaptureSession3_ *s3 = nullptr; if (SUCCEEDED(c.session->QueryInterface(IID_IGraphicsCaptureSession3_, (void **)&s3))) { HRESULT b = s3->put_IsBorderRequired(FALSE); Log("capture border-off: %s", SUCCEEDED(b) ? "ok" : "not permitted (harmless)"); s3->Release(); } }
    hr = c.session->StartCapture();
    if (FAILED(hr)) { Log("StartCapture failed 0x%08X", hr); return false; }
    return true;
}

// --------------------------------------------------------------------------------------------
int wmain_impl(int argc, wchar_t **argv) {
    std::wstring exe, title; int wait_s = 120; std::wstring logpath = L"neural-relay.log"; bool borderless = false, altenter = false; int hdrMode = -1; // -1 auto, 0 off, 1 on
    for (int i = 1; i < argc; ++i) {
        std::wstring a = argv[i];
        if (a == L"--exe" && i + 1 < argc) exe = argv[++i];
        else if (a == L"--title" && i + 1 < argc) title = argv[++i];
        else if (a == L"--wait" && i + 1 < argc) wait_s = _wtoi(argv[++i]);
        else if (a == L"--log" && i + 1 < argc) logpath = argv[++i];
        else if (a == L"--borderless") borderless = true;
        else if (a == L"--alt-enter") altenter = true;
        else if (a == L"--hdr" && i + 1 < argc) { std::wstring v = argv[++i]; hdrMode = (v == L"fp16" || v == L"on") ? 1 : (v == L"keep" || v == L"off") ? 0 : -1; }
    }
    g_log = _wfopen(logpath.c_str(), L"w");
    Log("neural-relay v" RELAY_VERSION " starting (exe='%ls' title='%ls')", exe.c_str(), title.c_str());
    if (exe.empty() && title.empty()) { Log("usage: neural-relay.exe --exe Game.exe | --title \"substring\""); return 2; }
    // Single instance per session (the in-game launcher add-on and the .bat may both try to start us).
    HANDLE single = CreateMutexW(nullptr, TRUE, L"Local\\NeuralRelayRunning");
    if (single && GetLastError() == ERROR_ALREADY_EXISTS) { Log("another neural-relay is already running - exiting"); return 0; }
    EnableDpiAwareness();

    // Load DXGI from our own folder first so the add-on ReShade (dxgi.dll beside this exe) hooks us.
    { HMODULE dx = LoadLibraryW(L"dxgi.dll"); wchar_t p[MAX_PATH] = {}; if (dx) GetModuleFileNameW(dx, p, MAX_PATH); Log("dxgi.dll loaded from: %ls", p); }
    HRESULT hr = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(hr) && hr != S_FALSE && hr != RPC_E_CHANGED_MODE) { Log("RoInitialize failed 0x%08X", hr); return 1; }

    // 1. wait for the game window
    HWND target = nullptr;
    for (int i = 0; i < wait_s * 2 && !target; ++i) { target = FindTarget(exe, title); if (!target) { if (i % 20 == 19) Log("waiting for the game window... (%d s)", (i + 1) / 2); Sleep(500); } }
    if (!target) { Log("game window not found after %d s", wait_s); return 1; }
    { wchar_t t[256] = {}; GetWindowTextW(target, t, 256); Log("target window %p '%ls' (%ls, pid %lu)", target, t, ProcessImageName(target).c_str(), WindowPid(target)); }
    RECT trc;
    if (!WaitForSettledWindow(target, trc, 20000)) { Log("game window never settled to a usable size (still %s)", IsWindow(target) ? "changing" : "gone"); return 1; }
    Log("game window settled at %dx%d", trc.right - trc.left, trc.bottom - trc.top);
    if (altenter && LooksExclusiveFullscreen(target)) { PressAltEnter(target); WaitForSettledWindow(target, trc, 8000); }
    if (borderless) { MakeBorderless(target); WaitForSettledWindow(target, trc, 5000); }
    if (!TargetClientRectOnScreen(target, trc) || (trc.right - trc.left) < 200) { Log("target has no usable client area after setup"); return 1; }
    int W = trc.right - trc.left, H = trc.bottom - trc.top;
    { MONITORINFOEXW mi = {}; mi.cbSize = sizeof mi; GetMonitorInfoW(MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST), &mi);
      DEVMODEW dm = {}; dm.dmSize = sizeof dm; if (EnumDisplaySettingsW(mi.szDevice, ENUM_CURRENT_SETTINGS, &dm)) Log("monitor %ls: %lux%lu @ %lu Hz", mi.szDevice, dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency); }
    { LONG st = GetWindowLongW(target, GWL_STYLE);
      Log("target client area %dx%d at %d,%d (style 0x%08lX %s)", W, H, trc.left, trc.top, st, (st & WS_CAPTION) == WS_CAPTION ? "windowed" : "borderless/fullscreen");
      if ((st & WS_CAPTION) != WS_CAPTION) Log("note: if the picture never changes, the game may be in EXCLUSIVE fullscreen - press Alt+Enter in the game or use -windowed"); }

    // 2. overlay window (topmost, layered+transparent = click-through for other processes, never activates)
    WNDCLASSW wc = {}; wc.lpfnWndProc = OverlayProc; wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"NeuralRelayOverlay"; wc.hCursor = LoadCursorW(nullptr, (LPCWSTR)IDC_ARROW); RegisterClassW(&wc);
    HWND overlay = CreateWindowExW(kPassiveEx, wc.lpszClassName, L"Neural Relay", WS_POPUP,
        trc.left, trc.top, W, H, nullptr, nullptr, wc.hInstance, nullptr);
    if (!overlay) { Log("overlay window creation failed (%lu)", GetLastError()); return 1; }
    SetLayeredWindowAttributes(overlay, 0, 255, LWA_ALPHA);   // fully opaque layered window (needed for WS_EX_TRANSPARENT pass-through)
    ShowWindow(overlay, SW_SHOWNOACTIVATE);
    if (!RegisterHotKey(overlay, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'M')) Log("Ctrl+Alt+M hotkey unavailable (another app owns it)");
    if (!RegisterHotKey(overlay, 2, MOD_NOREPEAT, VK_HOME)) Log("Home hotkey unavailable (another app owns it); use Ctrl+Alt+M then Home");

    // 3. D3D11 device + swapchain on the overlay (ReShade's dxgi.dll next to us hooks this)
    ID3D11Device *dev = nullptr; ID3D11DeviceContext *ctx = nullptr; D3D_FEATURE_LEVEL fl;
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
        D3D11_SDK_VERSION, &dev, &fl, &ctx);
    if (FAILED(hr)) { Log("D3D11CreateDevice failed 0x%08X", hr); return 1; }
    IDXGIDevice *dxgiDev = nullptr; dev->QueryInterface(__uuidof(IDXGIDevice), (void **)&dxgiDev);
    IDXGIAdapter *adapter = nullptr; dxgiDev->GetAdapter(&adapter);
    { DXGI_ADAPTER_DESC ad = {}; if (SUCCEEDED(adapter->GetDesc(&ad))) Log("adapter: %ls", ad.Description); }
    IDXGIFactory2 *factory = nullptr; adapter->GetParent(__uuidof(IDXGIFactory2), (void **)&factory);
    struct HdrRestore { HdrTarget t; bool on = false; ~HdrRestore() { if (on) SetHdrState(t, true); } } hdrRestore;   // restores HDR on any exit path
    float maxNits = 0; bool desktopHdr = OutputIsHdr(adapter, target, &maxNits); bool hdr = false; HdrTarget hdrT;
    if (hdrMode == 1) hdr = desktopHdr;
    else if (hdrMode == 0) Log("hdr: --hdr keep: leaving Windows HDR alone, 8-bit path");
    else if (desktopHdr) {
        hdrT = FindHdrTarget(target);
        if (GetHdrState(hdrT) == 1 && SetHdrState(hdrT, false)) {
            hdrRestore.t = hdrT; hdrRestore.on = true; Sleep(2500);   // mode switch; the desktop flickers once
            int st = -1; for (int i = 0; i < 10 && (st = GetHdrState(hdrT)) == 1; ++i) Sleep(300);
            Log("hdr: monitor is %s for this session (advanced color state=%d); HDR will be restored when the game closes", st == 0 ? "SDR" : "still reporting HDR", st);
        } else Log("hdr: could not switch this monitor to SDR (press Win+Alt+B yourself); using 8-bit path anyway");
    }
    DirectXPixelFormat capFmt = hdr ? DirectXPixelFormat_R16G16B16A16Float : DirectXPixelFormat_B8G8R8A8UIntNormalized;
    const DXGI_FORMAT swapFmt = hdr ? DXGI_FORMAT_R16G16B16A16_FLOAT : DXGI_FORMAT_B8G8R8A8_UNORM;
    Log("hdr: %s -> capture/present in %s", hdr ? "HDR desktop" : "SDR desktop", hdr ? "FP16 scRGB" : "8-bit BGRA");
    DXGI_SWAP_CHAIN_DESC1 sd = {}; sd.Width = W; sd.Height = H; sd.Format = swapFmt;
    sd.SampleDesc.Count = 1; sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; sd.BufferCount = 3;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD; sd.Scaling = DXGI_SCALING_STRETCH; sd.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    IDXGISwapChain1 *swap = nullptr;
    hr = factory->CreateSwapChainForHwnd(dev, overlay, &sd, nullptr, nullptr, &swap);
    const char *swapKind = "flip-discard";
    if (FAILED(hr)) {
        Log("flip-model swapchain failed 0x%08X; falling back to bitblt", hr);
        sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD; sd.BufferCount = 1; sd.Scaling = DXGI_SCALING_STRETCH; swapKind = "bitblt";
        if (hdr) { hdr = false; capFmt = DirectXPixelFormat_B8G8R8A8UIntNormalized; sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM; Log("hdr: bitblt fallback cannot do FP16; back to 8-bit (picture may look washed out with HDR on)"); }
        hr = factory->CreateSwapChainForHwnd(dev, overlay, &sd, nullptr, nullptr, &swap);
        if (FAILED(hr)) { Log("CreateSwapChainForHwnd failed 0x%08X", hr); return 1; }
    }
    factory->MakeWindowAssociation(overlay, DXGI_MWA_NO_ALT_ENTER | DXGI_MWA_NO_WINDOW_CHANGES);
    if (hdr) {
        IDXGISwapChain3 *swap3 = nullptr;
        if (SUCCEEDED(swap->QueryInterface(__uuidof(IDXGISwapChain3), (void **)&swap3))) {
            UINT support = 0; swap3->CheckColorSpaceSupport(DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709, &support);
            HRESULT ch = (support & DXGI_SWAP_CHAIN_COLOR_SPACE_SUPPORT_FLAG_PRESENT) ? swap3->SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709) : E_FAIL;
            Log("hdr: scRGB color space on the overlay swapchain: 0x%08X", ch); swap3->Release();
        }
    }
    Log("swapchain %dx%d %s %s created", W, H, hdr ? "RGBA16F" : "BGRA8", swapKind);

    // 4. Windows Graphics Capture of the game window
    HMODULE d3d11mod = GetModuleHandleW(L"d3d11.dll");
    auto pCreateWinRTDevice = (PFN_CreateDirect3D11DeviceFromDXGIDevice)GetProcAddress(d3d11mod, "CreateDirect3D11DeviceFromDXGIDevice");
    if (!pCreateWinRTDevice) { Log("CreateDirect3D11DeviceFromDXGIDevice export missing"); return 1; }
    IInspectable *winrtDevInsp = nullptr; hr = pCreateWinRTDevice(dxgiDev, &winrtDevInsp);
    if (FAILED(hr)) { Log("CreateDirect3D11DeviceFromDXGIDevice failed 0x%08X", hr); return 1; }
    IDirect3DDevice_ *winrtDev = reinterpret_cast<IDirect3DDevice_ *>(winrtDevInsp);

    HSTRING hsItem = nullptr, hsPool = nullptr;
    WindowsCreateString(L"Windows.Graphics.Capture.GraphicsCaptureItem", 44, &hsItem);
    WindowsCreateString(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool", 51, &hsPool);
    IGraphicsCaptureItemInterop_ *interop = nullptr;
    hr = RoGetActivationFactory(hsItem, IID_IGraphicsCaptureItemInterop_, (void **)&interop);
    if (FAILED(hr)) { Log("GraphicsCaptureItem factory failed 0x%08X (Windows 10 1903+ required)", hr); return 1; }
    IDirect3D11CaptureFramePoolStatics2_ *poolStatics = nullptr;
    hr = RoGetActivationFactory(hsPool, IID_IDirect3D11CaptureFramePoolStatics2_, (void **)&poolStatics);
    if (FAILED(hr)) { Log("FramePool statics failed 0x%08X", hr); return 1; }
    Capture cap;
    if (!StartCapture(cap, target, winrtDev, interop, poolStatics, W, H, capFmt)) return 1;
    Log("capture started; relaying frames. Home = DLSS menu on the relay (Ctrl+Alt+M = interactive mode without the menu).");

    // 5. loop: pump messages, relay frames, track the game window
    ID3D11Texture2D *back = nullptr; swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void **)&back);
    unsigned captured = 0, presented = 0, dropped = 0, tick = 0, presentErrs = 0, snaps = 0; bool running = true, shown = true;
    int pendW = W, pendH = H; ULONGLONG pendSince = 0, lastSnap = 0;
    ULONGLONG lastLog = GetTickCount64();
    while (running) {
        if (!Pump(overlay, target)) break;
        HomeFinish(overlay, target);
        if (!IsWindow(target)) {
            // Games recreate their window when switching display mode: look for a replacement before giving up.
            Log("game window went away; looking for a new one for up to 15 s");
            cap.Release(); ShowWindow(overlay, SW_HIDE); shown = false; HWND nt = nullptr;
            for (int i = 0; i < 30 && !nt && running; ++i) { running = Pump(overlay, nullptr); nt = FindTarget(exe, title); if (!nt) Sleep(500); }
            if (!nt) { Log("game exited; shutting down"); break; }
            target = nt;
            { wchar_t t[256] = {}; GetWindowTextW(target, t, 256); Log("new target window %p '%ls'", target, t); }
            RECT r; if (!WaitForSettledWindow(target, r, 20000)) { Log("new target never settled; giving up"); break; }
            if (altenter && LooksExclusiveFullscreen(target)) { PressAltEnter(target); WaitForSettledWindow(target, r, 8000); }
            if (borderless) { MakeBorderless(target); WaitForSettledWindow(target, r, 5000); }
            if (!TargetClientRectOnScreen(target, r) || (r.right - r.left) < 200) { Log("new target has no usable client area"); break; }
            W = r.right - r.left; H = r.bottom - r.top; SafeRelease(back);
            hr = swap->ResizeBuffers(0, W, H, DXGI_FORMAT_UNKNOWN, 0); swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void **)&back);
            SetWindowPos(overlay, HWND_TOPMOST, r.left, r.top, W, H, SWP_NOACTIVATE | SWP_NOCOPYBITS);
            if (!StartCapture(cap, target, winrtDev, interop, poolStatics, W, H, capFmt)) break;
            Log("re-attached at %dx%d (resize 0x%08X)", W, H, hr);
            ShowWindow(overlay, SW_SHOWNOACTIVATE); shown = true;
        }
        if (++tick % 20 == 0) {   // follow the game window; stay on top; hide when minimized or not focused
            RECT r; HWND fg = GetForegroundWindow();
            bool gameFocused = g_interactive || fg == target || fg == overlay || (fg && WindowPid(fg) == WindowPid(target));
            if (borderless && !IsIconic(target) && GetTickCount64() - lastSnap > 3000 && snaps < 12) {
                LONG st = GetWindowLongW(target, GWL_STYLE); RECT cr; GetClientRect(target, &cr);
                HMONITOR mon = MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST); MONITORINFO mi = {}; mi.cbSize = sizeof mi; GetMonitorInfoW(mon, &mi);
                int mw = mi.rcMonitor.right - mi.rcMonitor.left, mh = mi.rcMonitor.bottom - mi.rcMonitor.top;
                bool framed = (st & WS_CAPTION) == WS_CAPTION;
                bool offSize = (cr.right != mw || cr.bottom != mh) && abs(cr.right - mw) <= 64 && abs(cr.bottom - mh) <= 64;
                if (framed || offSize) {
                    Log("game window %s (%dx%d client); re-applying borderless (%d/12)", framed ? "got its frame back" : "drifted off the monitor size", cr.right, cr.bottom, snaps + 1);
                    Sleep(500); MakeBorderless(target); lastSnap = GetTickCount64(); ++snaps;
                    if (snaps == 12) Log("game keeps resizing its window; leaving it alone from now on");
                }
            }
            if (IsIconic(target) || !TargetClientRectOnScreen(target, r) || !gameFocused) {
                if (shown) { ShowWindow(overlay, SW_HIDE); shown = false; }
            } else {
                int nw = r.right - r.left, nh = r.bottom - r.top;
                if (!shown) { ShowWindow(overlay, SW_SHOWNOACTIVATE); shown = true; }
                SetWindowPos(overlay, HWND_TOPMOST, r.left, r.top, nw, nh, SWP_NOACTIVATE | SWP_NOCOPYBITS);
                // Debounce: games bounce through several sizes during a mode switch; every swapchain resize
                // makes the neural add-on tear down and rebuild, so wait until the size holds for 600 ms.
                if (nw != W || nh != H) {
                    if (nw != pendW || nh != pendH) { pendW = nw; pendH = nh; pendSince = GetTickCount64(); }
                    else if (GetTickCount64() - pendSince >= 600) {
                        W = nw; H = nh; SafeRelease(back);
                        hr = swap->ResizeBuffers(0, W, H, DXGI_FORMAT_UNKNOWN, 0);
                        swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void **)&back);
                        SizeInt32 sz{W, H}; if (cap.pool) cap.pool->Recreate(winrtDev, capFmt, 2, sz);
                        Log("resized to %dx%d (0x%08X)", W, H, hr);
                    }
                } else { pendW = W; pendH = H; }
            }
        }
        // Drain everything WGC has queued and show only the newest frame: an older frame is pure latency.
        IDirect3D11CaptureFrame_ *frame = nullptr;
        for (;;) { IDirect3D11CaptureFrame_ *nf = nullptr; if (!cap.pool || FAILED(cap.pool->TryGetNextFrame(&nf)) || !nf) break; if (frame) { frame->Release(); ++dropped; } frame = nf; ++captured; }
        if (frame) {
            IDirect3DSurface_ *surf = nullptr; frame->get_Surface(&surf);
            IDirect3DDxgiInterfaceAccess_ *access = nullptr; ID3D11Texture2D *tex = nullptr;
            if (surf && SUCCEEDED(surf->QueryInterface(IID_IDirect3DDxgiInterfaceAccess_, (void **)&access)))
                access->GetInterface(__uuidof(ID3D11Texture2D), (void **)&tex);
            SizeInt32 cs{}; frame->get_ContentSize(&cs);
            if (tex && back && shown) {
                D3D11_TEXTURE2D_DESC td; tex->GetDesc(&td);
                UINT cw = (UINT)std::min<int>(std::min<int>(cs.Width, (int)td.Width), W);
                UINT ch = (UINT)std::min<int>(std::min<int>(cs.Height, (int)td.Height), H);
                D3D11_BOX box{0, 0, 0, cw, ch, 1};
                ctx->CopySubresourceRegion(back, 0, 0, 0, 0, tex, 0, &box);
                // Sync interval 0: never block on vblank. When the neural pass runs longer than a refresh,
                // a vsynced Present would quantize us to half rate; DWM still shows the newest frame.
                HRESULT ph = swap->Present(0, 0);
                if (SUCCEEDED(ph)) ++presented; else if (++presentErrs <= 5) Log("Present failed 0x%08X", ph);
            }
            SafeRelease(tex); SafeRelease(access); SafeRelease(surf); SafeRelease(frame);
        } else {
            Sleep(1);
        }
        if (GetTickCount64() - lastLog > 10000) {
            Log("last 10 s: captured %u, presented %u, skipped-as-stale %u (%ux%u, overlay %s%s)", captured, presented, dropped, W, H, shown ? "shown" : "hidden", g_interactive ? ", interactive" : "");
            captured = presented = dropped = 0; lastLog = GetTickCount64();
        }
    }
    Log("shutting down");
    SafeRelease(back); cap.Release(); SafeRelease(poolStatics); SafeRelease(interop);
    WindowsDeleteString(hsItem); WindowsDeleteString(hsPool);
    if (winrtDevInsp) winrtDevInsp->Release();
    SafeRelease(swap); SafeRelease(factory); SafeRelease(adapter); SafeRelease(dxgiDev); SafeRelease(ctx); SafeRelease(dev);
    if (hdrRestore.on) { SetHdrState(hdrRestore.t, true); hdrRestore.on = false; }
    if (g_log) { fclose(g_log); g_log = nullptr; }
    return 0;
}

int main() {
    int argc = 0; wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    int r = wmain_impl(argc, argv); LocalFree(argv); return r;
}
