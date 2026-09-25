// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - live desktop mode. Apache-2.0.
//
// DXGI Desktop Duplication copies one monitor on a D3D11 device on the same
// NVIDIA adapter; the picture crosses to our D3D12 engine through a shared
// texture and a shared fence, goes through NR (plus optical flow and the
// effect stabiliser), and is shown in a borderless, topmost, click-through
// window covering that monitor. The window is excluded from capture
// (WDA_EXCLUDEFROMCAPTURE), so the duplication never sees our own output and
// every click still lands on the real desktop underneath.
//
// Ctrl+Alt+N hides / shows the effect (the real desktop is always there
// underneath), Ctrl+Alt+End stops. The installer's Stop button closes our
// stdin, which stops us too.
//
// Windows hands over a new frame whenever the compositor presents one, which
// can happen without the picture (minus our capture-excluded overlay) having
// changed. So each frame is compared with the last one on the GPU first (a
// ~0.1 ms compute pass) and only a real change runs NR - a still desktop
// costs next to nothing. The first frame after (re)starting is always used.
#include "jobs.h"

#include <d3d11_4.h>
#include <d3dcompiler.h>
#include <dcomp.h>
#include <dxgi1_6.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cwchar>

namespace dm
{
namespace
{
constexpr int kHotkeyStop = 0x4D31;
constexpr int kHotkeyToggle = 0x4D32;
constexpr int kHotkeySplit = 0x4D33;
constexpr unsigned kCheckMarker = 96;   // self-test: magenta square drawn in the top-left corner
constexpr unsigned kCheckSample = 64;   // and the part of it read back from the capture
// Extra passes of an unchanged picture once the screen goes still. Measured
// 2026-09-25: re-evaluating a still frame moves NR's result by only 0.2-0.5
// levels on average, while the passes doubled the GPU time on a screen that
// changes a few times a second - so none by default.
constexpr int kSettlePasses = 0;

LRESULT CALLBACK OverlayProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    switch (message)
    {
    case WM_NCHITTEST: return HTTRANSPARENT;
    case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
    case WM_CLOSE: g_cancel = true; return 0;
    case WM_DISPLAYCHANGE: Log("display mode changed"); return 0;
    default: return DefWindowProcW(hwnd, message, wparam, lparam);
    }
}

float SdrWhiteScale(HMONITOR monitor, bool &found)
{
    found = false;
    MONITORINFOEXW info = {};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) return 1.0f;
    UINT32 pathCount = 0, modeCount = 0;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount) != ERROR_SUCCESS) return 1.0f;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
    if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(), &modeCount, modes.data(), nullptr) != ERROR_SUCCESS) return 1.0f;
    for (UINT32 i = 0; i < pathCount; ++i)
    {
        DISPLAYCONFIG_SOURCE_DEVICE_NAME source = {};
        source.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        source.header.size = sizeof(source);
        source.header.adapterId = paths[i].sourceInfo.adapterId;
        source.header.id = paths[i].sourceInfo.id;
        if (DisplayConfigGetDeviceInfo(&source.header) != ERROR_SUCCESS) continue;
        if (wcscmp(source.viewGdiDeviceName, info.szDevice) != 0) continue;
        DISPLAYCONFIG_SDR_WHITE_LEVEL white = {};
        white.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL;
        white.header.size = sizeof(white);
        white.header.adapterId = paths[i].targetInfo.adapterId;
        white.header.id = paths[i].targetInfo.id;
        if (DisplayConfigGetDeviceInfo(&white.header) != ERROR_SUCCESS || white.SDRWhiteLevel == 0) return 1.0f;
        found = true;
        return white.SDRWhiteLevel / 1000.0f;   // 1000 = 80 nits = scRGB 1.0
    }
    return 1.0f;
}

float HalfToFloat(unsigned short h)
{
    const unsigned sign = (h >> 15) & 1, exponent = (h >> 10) & 0x1F, mantissa = h & 0x3FF;
    float value;
    if (exponent == 0) value = std::ldexp(static_cast<float>(mantissa), -24);
    else if (exponent == 31) value = mantissa ? 0.0f : 65504.0f;
    else value = std::ldexp(static_cast<float>(mantissa | 0x400), static_cast<int>(exponent) - 25);
    return sign ? -value : value;
}

// scRGB (FP16, 1.0 = 80 nits) -> 8-bit sRGB with SDR white at 1.0, for a
// diagnostic snapshot of an HDR desktop.
void ScRgbToRgba8(const unsigned char *src, unsigned char *dst, size_t pixels, float sdrScale)
{
    auto half = HalfToFloat;
    auto encode = [](float x) -> unsigned char
    {
        x = std::clamp(x, 0.0f, 1.0f);
        const float y = x <= 0.0031308f ? x * 12.92f : 1.055f * std::pow(x, 1.0f / 2.4f) - 0.055f;
        return static_cast<unsigned char>(std::lround(y * 255.0f));
    };
    const unsigned short *in = reinterpret_cast<const unsigned short *>(src);
    for (size_t i = 0; i < pixels; ++i)
    {
        for (int c = 0; c < 3; ++c) dst[i * 4 + c] = encode(half(in[i * 4 + c]) / std::max(sdrScale, 0.01f));
        dst[i * 4 + 3] = 255;
    }
}

const char kCompareShader[] = R"(
Texture2D<float4> NewFrame : register(t0);
Texture2D<float4> OldFrame : register(t1);
RWByteAddressBuffer Count : register(u0);
cbuffer Params : register(b0) { uint width; uint height; float threshold; uint pad; };
groupshared uint changed;
[numthreads(16, 16, 1)]
void main(uint3 id : SV_DispatchThreadID, uint index : SV_GroupIndex)
{
    if (index == 0) changed = 0;
    GroupMemoryBarrierWithGroupSync();
    if (id.x < width && id.y < height)
    {
        float3 d = abs(NewFrame[id.xy].rgb - OldFrame[id.xy].rgb);
        if (max(d.r, max(d.g, d.b)) > threshold) InterlockedAdd(changed, 1u);
    }
    GroupMemoryBarrierWithGroupSync();
    if (index == 0 && changed != 0)
    {
        uint before;
        Count.InterlockedAdd(0, changed, before);
    }
}
)";

struct Capture
{
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11Device5> device5;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11DeviceContext4> context4;
    ComPtr<IDXGIOutput1> output1;
    ComPtr<IDXGIOutput5> output5;
    ComPtr<IDXGIOutputDuplication> duplication;
    ComPtr<ID3D11Texture2D> shared11;
    ComPtr<ID3D12Resource> shared12;
    ComPtr<ID3D11Fence> fence11;
    ComPtr<ID3D12Fence> fence12;
    UINT64 fenceValue = 0;
    DXGI_FORMAT format = DXGI_FORMAT_B8G8R8A8_UNORM;
    // change detection
    ComPtr<ID3D11ComputeShader> compare;
    ComPtr<ID3D11Buffer> count, countStaging, params;
    ComPtr<ID3D11UnorderedAccessView> countView;
    ComPtr<ID3D11ShaderResourceView> previousView;
    unsigned width = 0, height = 0;
};

bool CreateCompare(Capture &capture, unsigned width, unsigned height)
{
    ComPtr<ID3DBlob> code, errors;
    HRESULT hr = D3DCompile(kCompareShader, sizeof(kCompareShader) - 1, "compare", nullptr, nullptr, "main", "cs_5_0",
        D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &errors);
    if (FAILED(hr))
    {
        Log("change detection shader: %s %s", Hex32(hr).c_str(), errors ? static_cast<const char *>(errors->GetBufferPointer()) : "");
        return false;
    }
    if (FAILED(hr = capture.device->CreateComputeShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &capture.compare)))
    { Log("change detection: CreateComputeShader %s", Hex32(hr).c_str()); return false; }
    D3D11_BUFFER_DESC desc = {};
    desc.ByteWidth = 16;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
    desc.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
    if (FAILED(hr = capture.device->CreateBuffer(&desc, nullptr, &capture.count))) { Log("change detection: buffer %s", Hex32(hr).c_str()); return false; }
    D3D11_UNORDERED_ACCESS_VIEW_DESC view = {};
    view.Format = DXGI_FORMAT_R32_TYPELESS;
    view.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
    view.Buffer.NumElements = 4;
    view.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
    if (FAILED(hr = capture.device->CreateUnorderedAccessView(capture.count.Get(), &view, &capture.countView))) { Log("change detection: view %s", Hex32(hr).c_str()); return false; }
    D3D11_BUFFER_DESC staging = {};
    staging.ByteWidth = 16;
    staging.Usage = D3D11_USAGE_STAGING;
    staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(hr = capture.device->CreateBuffer(&staging, nullptr, &capture.countStaging))) { Log("change detection: staging %s", Hex32(hr).c_str()); return false; }
    struct { UINT width, height; float threshold; UINT pad; } values = {width, height, 1.0e-4f, 0};
    D3D11_BUFFER_DESC constants = {};
    constants.ByteWidth = 16;
    constants.Usage = D3D11_USAGE_IMMUTABLE;
    constants.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    D3D11_SUBRESOURCE_DATA data = {&values, 0, 0};
    if (FAILED(hr = capture.device->CreateBuffer(&constants, &data, &capture.params))) { Log("change detection: constants %s", Hex32(hr).c_str()); return false; }
    if (FAILED(hr = capture.device->CreateShaderResourceView(capture.shared11.Get(), nullptr, &capture.previousView))) { Log("change detection: previous view %s", Hex32(hr).c_str()); return false; }
    capture.width = width;
    capture.height = height;
    return true;
}

// Pixels that differ between the new desktop frame and the last one we kept
// (in shared11), or -1 when the comparison could not run.
long long ChangedPixels(Capture &capture, ID3D11Texture2D *frame)
{
    if (!capture.compare) return -1;
    ComPtr<ID3D11ShaderResourceView> frameView;
    const HRESULT hr = capture.device->CreateShaderResourceView(frame, nullptr, &frameView);
    if (FAILED(hr))
    {
        static bool logged = false;
        if (!logged) { logged = true; Log("change detection: the desktop frame cannot be read by a shader (%s)", Hex32(hr).c_str()); }
        return -1;
    }
    ID3D11DeviceContext *context = capture.context.Get();
    const UINT zeros[4] = {0, 0, 0, 0};
    context->ClearUnorderedAccessViewUint(capture.countView.Get(), zeros);
    ID3D11ShaderResourceView *views[2] = {frameView.Get(), capture.previousView.Get()};
    ID3D11UnorderedAccessView *uav = capture.countView.Get();
    ID3D11Buffer *constants = capture.params.Get();
    context->CSSetShader(capture.compare.Get(), nullptr, 0);
    context->CSSetShaderResources(0, 2, views);
    context->CSSetUnorderedAccessViews(0, 1, &uav, nullptr);
    context->CSSetConstantBuffers(0, 1, &constants);
    context->Dispatch((capture.width + 15) / 16, (capture.height + 15) / 16, 1);
    ID3D11ShaderResourceView *noViews[2] = {nullptr, nullptr};
    ID3D11UnorderedAccessView *noUav = nullptr;
    context->CSSetShaderResources(0, 2, noViews);
    context->CSSetUnorderedAccessViews(0, 1, &noUav, nullptr);
    context->CSSetShader(nullptr, nullptr, 0);
    context->CopyResource(capture.countStaging.Get(), capture.count.Get());
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    if (FAILED(context->Map(capture.countStaging.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return -1;
    const long long changed = *static_cast<const UINT *>(mapped.pData);
    context->Unmap(capture.countStaging.Get(), 0);
    return changed;
}

// Average colour of the top-left size x size pixels of a captured frame, as
// linear-ish floats: 0..1 for an 8-bit desktop, scRGB for an HDR one.
bool SampleCorner(Capture &capture, ID3D11Texture2D *frame, unsigned size, float rgb[3])
{
    D3D11_TEXTURE2D_DESC frameDesc = {};
    frame->GetDesc(&frameDesc);
    size = std::min({size, frameDesc.Width, frameDesc.Height});
    D3D11_TEXTURE2D_DESC stagingDesc = {};
    stagingDesc.Width = size;
    stagingDesc.Height = size;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = frameDesc.Format;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    if (FAILED(capture.device->CreateTexture2D(&stagingDesc, nullptr, &staging))) return false;
    const D3D11_BOX box = {0, 0, 0, size, size, 1};
    capture.context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, frame, 0, &box);
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    if (FAILED(capture.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return false;
    double sum[3] = {};
    for (unsigned y = 0; y < size; ++y)
    {
        const unsigned char *row = static_cast<const unsigned char *>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch;
        for (unsigned x = 0; x < size; ++x)
        {
            if (frameDesc.Format == DXGI_FORMAT_R16G16B16A16_FLOAT)
            {
                const unsigned short *p = reinterpret_cast<const unsigned short *>(row) + x * 4;
                for (int c = 0; c < 3; ++c) sum[c] += HalfToFloat(p[c]);
            }
            else   // B8G8R8A8
            {
                const unsigned char *p = row + x * 4;
                sum[0] += p[2] / 255.0; sum[1] += p[1] / 255.0; sum[2] += p[0] / 255.0;
            }
        }
    }
    capture.context->Unmap(staging.Get(), 0);
    for (int c = 0; c < 3; ++c) rgb[c] = static_cast<float>(sum[c] / (static_cast<double>(size) * size));
    return true;
}

// Diagnostics (--diff-dump): what exactly differs between the frame we kept and
// a new one the change detection flagged. Saves both frames and an 8x8-cell
// mask of the changed pixels, and reports how big the differences are.
bool DumpFramePair(Capture &capture, ID3D11Texture2D *older, ID3D11Texture2D *newer, const std::wstring &dir, int index, long long gpuCount)
{
    D3D11_TEXTURE2D_DESC desc = {};
    newer->GetDesc(&desc);
    if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) return false;
    const unsigned width = desc.Width, height = desc.Height;
    D3D11_TEXTURE2D_DESC stagingDesc = {};
    stagingDesc.Width = width;
    stagingDesc.Height = height;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = desc.Format;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> a, b;
    if (FAILED(capture.device->CreateTexture2D(&stagingDesc, nullptr, &a)) || FAILED(capture.device->CreateTexture2D(&stagingDesc, nullptr, &b)))
        return false;
    capture.context->CopyResource(a.Get(), older);
    capture.context->CopyResource(b.Get(), newer);
    D3D11_MAPPED_SUBRESOURCE ma = {}, mb = {};
    if (FAILED(capture.context->Map(a.Get(), 0, D3D11_MAP_READ, 0, &ma))) return false;
    if (FAILED(capture.context->Map(b.Get(), 0, D3D11_MAP_READ, 0, &mb))) { capture.context->Unmap(a.Get(), 0); return false; }
    const size_t pixels = static_cast<size_t>(width) * height;
    std::vector<unsigned char> ra(pixels * 4), rb(pixels * 4);
    const unsigned mw = (width + 7) / 8, mh = (height + 7) / 8;
    std::vector<unsigned char> mask(static_cast<size_t>(mw) * mh * 4, 0);
    for (size_t i = 0; i < static_cast<size_t>(mw) * mh; ++i) mask[i * 4 + 3] = 255;
    long long count = 0, level1 = 0, level2to3 = 0, level4to15 = 0, level16up = 0;
    unsigned left = width, top = height, right = 0, bottom = 0;
    int maxDiff = 0;
    for (unsigned y = 0; y < height; ++y)
    {
        const unsigned char *pa = static_cast<const unsigned char *>(ma.pData) + static_cast<size_t>(y) * ma.RowPitch;
        const unsigned char *pb = static_cast<const unsigned char *>(mb.pData) + static_cast<size_t>(y) * mb.RowPitch;
        for (unsigned x = 0; x < width; ++x)
        {
            const size_t o = (static_cast<size_t>(y) * width + x) * 4;
            for (int c = 0; c < 3; ++c) { ra[o + c] = pa[x * 4 + 2 - c]; rb[o + c] = pb[x * 4 + 2 - c]; }
            ra[o + 3] = rb[o + 3] = 255;
            int d = 0;
            for (int c = 0; c < 3; ++c) d = std::max(d, std::abs(int(pa[x * 4 + c]) - int(pb[x * 4 + c])));
            if (d == 0) continue;
            ++count;
            maxDiff = std::max(maxDiff, d);
            if (d == 1) ++level1; else if (d < 4) ++level2to3; else if (d < 16) ++level4to15; else ++level16up;
            left = std::min(left, x); top = std::min(top, y); right = std::max(right, x); bottom = std::max(bottom, y);
            unsigned char *m = &mask[(static_cast<size_t>(y / 8) * mw + x / 8) * 4];
            m[0] = 255; m[1] = static_cast<unsigned char>(std::min(255, d * 16)); m[2] = 0;
        }
    }
    capture.context->Unmap(a.Get(), 0);
    capture.context->Unmap(b.Get(), 0);
    EnsureDirectory(dir);
    std::string error;
    const std::wstring stem = dir + L"\\pair-" + std::to_wstring(index);
    SaveRgba(stem + L"-kept.png", ra.data(), width, height, false, 95, error);
    SaveRgba(stem + L"-new.png", rb.data(), width, height, false, 95, error);
    SaveRgba(stem + L"-mask.png", mask.data(), mw, mh, false, 95, error);
    JsonLine("diff-dump").Int("index", index).Int("gpuCount", gpuCount).Int("cpuCount", count).Int("maxDiff", maxDiff)
        .Int("level1", level1).Int("level2to3", level2to3).Int("level4to15", level4to15).Int("level16up", level16up)
        .Int("left", count ? left : 0).Int("top", count ? top : 0).Int("right", count ? right : 0).Int("bottom", count ? bottom : 0)
        .Str("message", error).Emit();
    return true;
}

// Whether the monitor called deviceName is in HDR right now (fresh factory,
// so it reflects a mode change). False when it cannot be found.
bool MonitorIsHdr(const wchar_t *deviceName, bool &found)
{
    found = false;
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;
    for (UINT a = 0;; ++a)
    {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(a, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        for (UINT o = 0;; ++o)
        {
            ComPtr<IDXGIOutput> output;
            if (adapter->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;
            ComPtr<IDXGIOutput6> output6;
            DXGI_OUTPUT_DESC1 desc = {};
            if (FAILED(output.As(&output6)) || FAILED(output6->GetDesc1(&desc))) continue;
            if (wcscmp(desc.DeviceName, deviceName) != 0) continue;
            found = true;
            return desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
        }
    }
    return false;
}

bool StartDuplication(Capture &capture, bool hdr)
{
    capture.duplication.Reset();
    HRESULT hr = E_FAIL;
    if (capture.output5)
    {
        const DXGI_FORMAT formats[] = {hdr ? DXGI_FORMAT_R16G16B16A16_FLOAT : DXGI_FORMAT_B8G8R8A8_UNORM};
        hr = capture.output5->DuplicateOutput1(capture.device.Get(), 0, 1, formats, &capture.duplication);
    }
    if (FAILED(hr) && !hdr && capture.output1) hr = capture.output1->DuplicateOutput(capture.device.Get(), &capture.duplication);
    if (FAILED(hr)) { Log("DuplicateOutput failed: %s", Hex32(hr).c_str()); return false; }
    return true;
}
} // namespace

bool RunDesktop(Engine &engine, const Settings &settings)
{
    // ---- which monitor
    IDXGIAdapter1 *adapter = engine.Adapter();
    ComPtr<IDXGIOutput> output;
    std::vector<ComPtr<IDXGIOutput>> outputs;
    for (UINT index = 0;; ++index)
    {
        ComPtr<IDXGIOutput> candidate;
        if (adapter->EnumOutputs(index, &candidate) == DXGI_ERROR_NOT_FOUND) break;
        outputs.push_back(candidate);
    }
    if (outputs.empty()) { EmitError("No monitor is connected to the NVIDIA GPU, so there is no desktop to capture on it.", true); return false; }
    for (size_t i = 0; i < outputs.size(); ++i)
    {
        DXGI_OUTPUT_DESC desc = {};
        outputs[i]->GetDesc(&desc);
        MONITORINFO info = {};
        info.cbSize = sizeof(info);
        GetMonitorInfoW(desc.Monitor, &info);
        const bool primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
        JsonLine("monitor").Int("index", static_cast<long long>(i)).WStr("name", desc.DeviceName)
            .Int("width", desc.DesktopCoordinates.right - desc.DesktopCoordinates.left)
            .Int("height", desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top).Bool("primary", primary).Emit();
        if (settings.monitor >= 0 ? static_cast<int>(i) == settings.monitor : (primary && !output)) output = outputs[i];
    }
    if (!output) output = outputs[0];
    DXGI_OUTPUT_DESC desc = {};
    output->GetDesc(&desc);
    const RECT area = desc.DesktopCoordinates;
    const unsigned width = static_cast<unsigned>(area.right - area.left);
    const unsigned height = static_cast<unsigned>(area.bottom - area.top);

    bool hdr = false;
    ComPtr<IDXGIOutput6> output6;
    if (SUCCEEDED(output.As(&output6)))
    {
        DXGI_OUTPUT_DESC1 desc1 = {};
        if (SUCCEEDED(output6->GetDesc1(&desc1))) hdr = desc1.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
    }
    bool whiteFound = false;
    float sdrScale = hdr ? SdrWhiteScale(desc.Monitor, whiteFound) : 1.0f;
    if (hdr && !whiteFound) EmitWarning("The SDR white level of this HDR monitor could not be read - assuming 80 nits.");

    // ---- capture device on the same adapter
    Capture capture;
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    HRESULT hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels, 2, D3D11_SDK_VERSION, &capture.device, nullptr, &capture.context);
    if (FAILED(hr) || FAILED(capture.device.As(&capture.device5)) || FAILED(capture.context.As(&capture.context4)))
    { EmitError("The capture device could not be created (" + Hex32(hr) + ").", true); return false; }
    output.As(&capture.output1);
    output.As(&capture.output5);
    capture.format = hdr ? DXGI_FORMAT_R16G16B16A16_FLOAT : DXGI_FORMAT_B8G8R8A8_UNORM;
    if (!StartDuplication(capture, hdr))
    { EmitError("Windows refused to duplicate this monitor. Another capture tool, a protected (DRM) video or the secure desktop can cause this.", true); return false; }

    D3D11_TEXTURE2D_DESC shared = {};
    shared.Width = width;
    shared.Height = height;
    shared.MipLevels = 1;
    shared.ArraySize = 1;
    shared.Format = capture.format;
    shared.SampleDesc.Count = 1;
    shared.Usage = D3D11_USAGE_DEFAULT;
    shared.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    shared.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    HANDLE handle = nullptr;
    ComPtr<IDXGIResource1> sharedResource;
    if (FAILED(hr = capture.device->CreateTexture2D(&shared, nullptr, &capture.shared11)) ||
        FAILED(hr = capture.shared11.As(&sharedResource)) ||
        FAILED(hr = sharedResource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &handle)) ||
        FAILED(hr = engine.Device()->OpenSharedHandle(handle, IID_PPV_ARGS(&capture.shared12))))
    { if (handle) CloseHandle(handle); EmitError("The capture could not be shared with the renderer (" + Hex32(hr) + ").", true); return false; }
    CloseHandle(handle);
    handle = nullptr;
    if (FAILED(hr = capture.device5->CreateFence(0, D3D11_FENCE_FLAG_SHARED, IID_PPV_ARGS(&capture.fence11))) ||
        FAILED(hr = capture.fence11->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr, &handle)) ||
        FAILED(hr = engine.Device()->OpenSharedHandle(handle, IID_PPV_ARGS(&capture.fence12))))
    { if (handle) CloseHandle(handle); EmitError("The capture fence could not be shared (" + Hex32(hr) + ").", true); return false; }
    CloseHandle(handle);
    const bool changeDetection = CreateCompare(capture, width, height);
    if (!changeDetection) Log("change detection unavailable - every desktop frame will be rendered");

    // ---- the engine at this size
    bool wantMotion = settings.stabilize > 0.0f || settings.motionToNr;   // live: the anti-shimmer can be turned on later
    unsigned long long workPixels = settings.maxWorkPixels;              // live: the working size can change too
    if (!engine.Configure(width, height, hdr ? SourceKind::ScRgb16 : SourceKind::Bgra8, hdr ? OutputKind::ScRgb16 : OutputKind::Rgba8,
            workPixels, settings.look, wantMotion))
    { EmitError("Neural rendering could not be set up for this monitor.", true); return false; }

    // ---- the overlay window and its swap chain
    // Two ways to put our picture on screen. "dcomp" (default): a window with no
    // redirection surface, layered + transparent for click-through from the
    // start, showing a composition swap chain through DirectComposition - the
    // way overlays are meant to be built. "hwnd": a flip-model swap chain on the
    // window, made layered afterwards (CreateSwapChainForHwnd refuses a layered
    // window) - kept for comparison and as a fallback.
    const bool useDComp = settings.present != "hwnd";
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = OverlayProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"DLSS5AIO.DesktopOverlay";
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassExW(&wc);
    DWORD exStyle = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    if (useDComp) exStyle |= WS_EX_NOREDIRECTIONBITMAP | WS_EX_LAYERED | WS_EX_TRANSPARENT;
    HWND window = CreateWindowExW(exStyle, wc.lpszClassName, L"DLSS 5 Desktop",
        WS_POPUP, area.left, area.top, static_cast<int>(width), static_cast<int>(height), nullptr, nullptr, wc.hInstance, nullptr);
    if (!window) { EmitError("The overlay window could not be created.", true); return false; }
    if (useDComp) SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA);
    // The first self-test needs the capture to see the overlay; everything else must not.
    if (settings.overlayCheck != 1 && !SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE))
    {
        DestroyWindow(window);
        EmitError("This Windows version cannot hide a window from screen capture (needs Windows 10 2004 or newer), so desktop mode would capture itself.", true);
        return false;
    }
    DXGI_SWAP_CHAIN_DESC1 chainDesc = {};
    chainDesc.Width = width;
    chainDesc.Height = height;
    chainDesc.Format = hdr ? DXGI_FORMAT_R16G16B16A16_FLOAT : DXGI_FORMAT_R8G8B8A8_UNORM;
    chainDesc.SampleDesc.Count = 1;
    chainDesc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    chainDesc.BufferCount = 2;
    chainDesc.Scaling = useDComp ? DXGI_SCALING_STRETCH : DXGI_SCALING_NONE;
    chainDesc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    chainDesc.AlphaMode = useDComp ? DXGI_ALPHA_MODE_IGNORE : DXGI_ALPHA_MODE_UNSPECIFIED;
    ComPtr<IDXGISwapChain1> chain1;
    ComPtr<IDXGISwapChain3> chain;
    ComPtr<IDCompositionDesktopDevice> dcomp;
    ComPtr<IDCompositionTarget> dcompTarget;
    ComPtr<IDCompositionVisual2> dcompVisual;
    if (useDComp)
    {
        if (FAILED(hr = engine.Factory()->CreateSwapChainForComposition(engine.Queue(), &chainDesc, nullptr, &chain1)) ||
            FAILED(hr = chain1.As(&chain)) ||
            FAILED(hr = DCompositionCreateDevice2(nullptr, IID_PPV_ARGS(&dcomp))) ||
            FAILED(hr = dcomp->CreateTargetForHwnd(window, TRUE, &dcompTarget)) ||
            FAILED(hr = dcomp->CreateVisual(&dcompVisual)) ||
            FAILED(hr = dcompVisual->SetContent(chain1.Get())) ||
            FAILED(hr = dcompTarget->SetRoot(dcompVisual.Get())) ||
            FAILED(hr = dcomp->Commit()))
        { DestroyWindow(window); EmitError("The overlay could not be set up (DirectComposition " + Hex32(hr) + ").", true); return false; }
    }
    else
    {
        if (FAILED(hr = engine.Factory()->CreateSwapChainForHwnd(engine.Queue(), window, &chainDesc, nullptr, nullptr, &chain1)) ||
            FAILED(hr = chain1.As(&chain)))
        { DestroyWindow(window); EmitError("The overlay swap chain could not be created (" + Hex32(hr) + ").", true); return false; }
        engine.Factory()->MakeWindowAssociation(window, DXGI_MWA_NO_ALT_ENTER | DXGI_MWA_NO_WINDOW_CHANGES);
    }
    if (hdr) chain->SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709);
    ComPtr<ID3D12Resource> buffers[2];
    for (UINT i = 0; i < 2; ++i) chain->GetBuffer(i, IID_PPV_ARGS(&buffers[i]));
    if (!useDComp)
    {
        // Click-through only after the swap chain exists: a layered window is
        // refused by CreateSwapChainForHwnd.
        SetWindowLongPtrW(window, GWL_EXSTYLE, GetWindowLongPtrW(window, GWL_EXSTYLE) | WS_EX_LAYERED | WS_EX_TRANSPARENT);
        SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA);
    }
    Log("overlay: %s, %ux%u at %ld,%ld, %s", useDComp ? "DirectComposition" : "flip swap chain on the window", width, height,
        area.left, area.top, settings.overlayCheck == 1 ? "visible to capture (self-test)" : "excluded from capture");

    const bool stopKey = RegisterHotKey(nullptr, kHotkeyStop, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_END) != 0;
    const bool toggleKey = RegisterHotKey(nullptr, kHotkeyToggle, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'N') != 0;
    const bool splitKey = RegisterHotKey(nullptr, kHotkeySplit, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 'S') != 0;
    bool split = settings.split;
    JsonLine("desktop-ready").WStr("monitor", desc.DeviceName).Int("width", width).Int("height", height)
        .Int("workWidth", engine.WorkWidth()).Int("workHeight", engine.WorkHeight()).Bool("hdr", hdr).Num("sdrScale", sdrScale)
        .Bool("motion", engine.MotionReady()).Bool("stopHotkey", stopKey).Bool("toggleHotkey", toggleKey)
        .Bool("splitHotkey", splitKey).Bool("split", split).Str("present", useDComp ? "dcomp" : "hwnd").Int("fpsCap", settings.fpsCap).Emit();

    // ---- the loop
    double interval = settings.fpsCap > 0 ? 1000.0 / std::clamp(settings.fpsCap, 1, 480) : 0.0;   // live: "fps=" in a look command
    bool visible = true, shown = false, dirty = false, reset = true, ok = true, snapshotDone = settings.snapshotDir.empty();
    bool fresh = true, captured = false, formatLogged = false;
    const double startedAt = NowMs();
    double lastProcess = 0.0, lastStats = NowMs(), lastTopmost = 0.0, lastAttempt = 0.0, capturedAt = 0.0, firstFrameAt = 0.0;
    double lastLook = 0.0;   // when the capture last handed us a frame
    // CREATE_WAITABLE_TIMER_HIGH_RESOLUTION (Windows 10 1803+), else an ordinary timer.
    HANDLE pacer = CreateWaitableTimerExW(nullptr, nullptr, 0x00000002, TIMER_ALL_ACCESS);
    if (!pacer) pacer = CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS);
    double lastWhiteCheck = NowMs();
    double nrSum = 0.0, gpuSum = 0.0, latencySum = 0.0;
    int framesSince = 0, updatesSince = 0, ignoredSince = 0, settleLeft = 0, latencyCount = 0, comparedSince = 0;
    long long changedSum = 0, changedMax = 0;
    unsigned long long frames = 0, presents = 0;
    HRESULT lastPresent = S_OK;
    // Live settings: the app can change the look, strength and split while we run.
    NrLook look = settings.look;
    float mix = settings.mix, stabilize = settings.stabilize;
    bool snapshotRequested = false;   // "snapshot" command: one more before/after pair
    int snapshotCount = 0;
    int diffDumps = 0;   // --diff-dump: frame pairs saved so far
    double checkAt = 0.0;   // self-test: when to read the screen back
    int checkFrames = 0;    // self-test: frames the capture handed over while we waited
    int checkSamples = 0, checkSeen = 0;   // self-test 2: frames looked at, and how many showed the corner
    float checkRgb[3] = {};
    const char *checkMode = settings.overlayCheck == 2 ? "excluded" : "visible";
    while (!g_cancel)
    {
        MSG message;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
        {
            if (message.message == WM_HOTKEY && message.wParam == kHotkeyStop) { Log("stop hotkey"); g_cancel = true; }
            else if (message.message == WM_HOTKEY && message.wParam == kHotkeyToggle)
            {
                visible = !visible;
                ShowWindow(window, visible && shown ? SW_SHOWNOACTIVATE : SW_HIDE);
                reset = true;
                JsonLine("desktop-toggle").Bool("visible", visible).Emit();
            }
            else if (message.message == WM_HOTKEY && message.wParam == kHotkeySplit)
            {
                split = !split;
                if (captured) dirty = true;   // show the change straight away
                JsonLine("desktop-split").Bool("split", split).Emit();
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        if (g_cancel) break;
        std::string command;
        while (PopCommand(command))
        {
            if (command == "snapshot")
            {
                snapshotRequested = true;
                if (captured) dirty = true;
            }
            else if (command.rfind("split ", 0) == 0)
            {
                split = command.substr(6) != "0";
                if (captured) dirty = true;
                JsonLine("desktop-split").Bool("split", split).Emit();
            }
            else if (command.rfind("look", 0) == 0)
            {
                // "look style=2 passes=3 intensity=1 tone=1 structure=1 skin=-1 automask=1 mix=1 stabilize=0.6 work=8.3 fps=60"
                // (any subset; work is megapixels, 0 = full size; fps 0 = uncapped)
                NrLook next = look;
                float nextMix = mix, nextStabilize = stabilize;
                unsigned long long nextWork = workPixels;
                double nextInterval = interval;
                size_t at = 4;
                while (at < command.size())
                {
                    while (at < command.size() && command[at] == ' ') ++at;
                    const size_t end = std::min(command.find(' ', at), command.size());
                    const std::string pair = command.substr(at, end - at);
                    at = end;
                    const size_t eq = pair.find('=');
                    if (eq == std::string::npos) continue;
                    const std::string key = pair.substr(0, eq);
                    const float value = static_cast<float>(std::atof(pair.c_str() + eq + 1));
                    if (key == "style") next.style = std::clamp(static_cast<int>(value), 0, 2);
                    else if (key == "passes") next.passes = std::clamp(static_cast<int>(value), 1, 3);
                    else if (key == "intensity") next.intensity = std::clamp(value, 0.0f, 1.0f);
                    else if (key == "tone") next.tone = std::clamp(value, 0.0f, 2.0f);
                    else if (key == "structure") next.structure = std::clamp(value, 0.0f, 2.0f);
                    else if (key == "skin") next.skin = value < 0.0f ? -1.0f : std::min(value, 0.99f);
                    else if (key == "automask") next.autoMask = value != 0.0f;
                    else if (key == "mix") nextMix = std::clamp(value, 0.0f, 1.0f);
                    else if (key == "stabilize") nextStabilize = std::clamp(value, 0.0f, 1.0f);
                    else if (key == "work") nextWork = value <= 0.0f ? 0ull : static_cast<unsigned long long>(std::clamp(value, 0.1f, 268.0f) * 1.0e6);
                    else if (key == "fps") nextInterval = value > 0.0f ? 1000.0 / std::clamp(static_cast<double>(value), 1.0, 480.0) : 0.0;
                }
                const bool nextMotion = nextStabilize > 0.0f || settings.motionToNr;
                const bool featureChange = !next.SameFeature(look) || next.passes != look.passes || nextWork != workPixels ||
                    (nextMotion && !wantMotion);
                if (!featureChange || engine.Configure(width, height, hdr ? SourceKind::ScRgb16 : SourceKind::Bgra8,
                        hdr ? OutputKind::ScRgb16 : OutputKind::Rgba8, nextWork, next, nextMotion))
                {
                    look = next;
                    mix = nextMix;
                    stabilize = nextStabilize;
                    workPixels = nextWork;
                    wantMotion = nextMotion;
                    interval = nextInterval;
                    if (featureChange) reset = true;
                    if (captured) dirty = true;
                    JsonLine("desktop-look").Int("style", look.style).Int("passes", look.passes).Num("intensity", look.intensity)
                        .Num("tone", look.tone).Num("structure", look.structure).Num("mix", mix).Num("stabilize", stabilize)
                        .Int("workWidth", engine.WorkWidth()).Int("workHeight", engine.WorkHeight())
                        .Int("fpsCap", interval > 0.0 ? std::lround(1000.0 / interval) : 0).Bool("motion", engine.MotionReady()).Emit();
                }
                else EmitError("The new look could not be applied - stop and start desktop mode.", false);
            }
        }
        if (settings.durationSeconds > 0.0 && NowMs() - startedAt > settings.durationSeconds * 1000.0)
        {
            Log("desktop mode: requested duration reached");
            break;
        }
        if (settings.overlayCheck && frames > 0 && NowMs() - checkAt > 4000.0)
        {
            // No new frame at all: for the "excluded" test that is a pass - nothing
            // of the overlay reached the capture.
            JsonLine("overlay-check").Str("mode", checkMode).Bool("seen", checkSeen > 0).Bool("pass", settings.overlayCheck == 2 && checkSeen == 0)
                .Bool("visible", false).Str("present", useDComp ? "dcomp" : "hwnd").Str("presentResult", Hex32(lastPresent))
                .Int("framesWhileWaiting", checkFrames).Int("samples", checkSamples).Int("samplesSeen", checkSeen)
                .Str("message", checkSamples ? "" : "no new frame came from the capture after the overlay appeared").Emit();
            break;
        }

        // Pace the capture to the frame cap. A high-refresh monitor can hand over
        // hundreds of frames a second (measured ~300/s on a 2560x1440 desktop with
        // nothing changing), and each one looked at costs a GPU comparison. Not
        // looking loses nothing: the next frame taken is always the whole, latest
        // desktop, with every change since the last one in it.
        if (captured && interval > 0.0 && !settings.overlayCheck && capture.duplication)
        {
            const double wait = interval - (NowMs() - lastLook);
            if (wait > 0.5)
            {
                LARGE_INTEGER due;
                due.QuadPart = -static_cast<LONGLONG>(wait * 10000.0);
                if (pacer && SetWaitableTimer(pacer, &due, 0, nullptr, nullptr, FALSE))
                    MsgWaitForMultipleObjects(1, &pacer, FALSE, static_cast<DWORD>(wait) + 5, QS_ALLINPUT);
                else Sleep(1);
                continue;
            }
        }
        if (!capture.duplication)
        {
            const double now = NowMs();
            if (now - lastAttempt < 250.0) { Sleep(20); continue; }
            lastAttempt = now;
            bool monitorFound = false;
            const bool hdrNow = MonitorIsHdr(desc.DeviceName, monitorFound);
            if (monitorFound && hdrNow != hdr)
            {
                EmitError(hdrNow ? "HDR was switched on - start desktop mode again." : "HDR was switched off - start desktop mode again.", false);
                ok = false;
                break;
            }
            if (!StartDuplication(capture, hdr)) continue;
            Log("duplication restarted");
            reset = true;
            fresh = true;
        }
        DXGI_OUTDUPL_FRAME_INFO info = {};
        ComPtr<IDXGIResource> desktop;
        hr = capture.duplication->AcquireNextFrame(visible ? 4 : 50, &info, &desktop);
        if (SUCCEEDED(hr)) lastLook = NowMs();
        if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL)
        {
            Log("duplication lost (%s)", Hex32(hr).c_str());
            capture.duplication.Reset();
            continue;
        }
        if (SUCCEEDED(hr) && settings.overlayCheck && frames > 0)
        {
            // Self-test 1: the overlay is on screen and NOT excluded from capture,
            // so a frame taken now must show its magenta corner. Self-test 2: the
            // overlay IS excluded, so the corner must not be magenta - if it is,
            // desktop mode would keep re-rendering its own output.
            bool done = false;
            if (NowMs() < checkAt) ++checkFrames;
            else
            {
                ComPtr<ID3D11Texture2D> texture;
                float rgb[3] = {};
                if (desktop && SUCCEEDED(desktop.As(&texture)) && SampleCorner(capture, texture.Get(), kCheckSample, rgb))
                {
                    const float s = hdr ? std::max(sdrScale, 0.1f) : 1.0f;
                    const bool magenta = rgb[0] > 0.5f * s && rgb[1] < 0.25f * s && rgb[2] > 0.5f * s;
                    for (int c = 0; c < 3; ++c) checkRgb[c] = rgb[c] / s;
                    ++checkSamples;
                    if (magenta) ++checkSeen;
                    // Test 1 needs one look. Test 2 keeps presenting and looks at every
                    // frame for two seconds, since a leak may come and go.
                    if (settings.overlayCheck == 1 || checkSamples >= 120 || NowMs() - checkAt > 2000.0)
                    {
                        const bool seen = checkSeen > 0;
                        JsonLine("overlay-check").Str("mode", checkMode).Bool("seen", seen)
                            .Bool("pass", settings.overlayCheck == 2 ? !seen : seen).Bool("visible", seen)
                            .Str("present", useDComp ? "dcomp" : "hwnd").Str("presentResult", Hex32(lastPresent))
                            .Int("framesWhileWaiting", checkFrames).Int("samples", checkSamples).Int("samplesSeen", checkSeen)
                            .Int("presents", static_cast<long long>(presents))
                            .Num("r", checkRgb[0]).Num("g", checkRgb[1]).Num("b", checkRgb[2]).Emit();
                        done = true;
                    }
                }
            }
            capture.duplication->ReleaseFrame();
            if (done) break;
            if (settings.overlayCheck == 1) continue;
            hr = DXGI_ERROR_WAIT_TIMEOUT;   // test 2: the frame was only looked at - go on presenting
        }
        if (SUCCEEDED(hr))
        {
            // LastPresentTime is 0 when only the mouse moved; the first frame
            // after (re)starting is taken whatever it says, since a still
            // desktop would otherwise never produce one.
            if (info.LastPresentTime.QuadPart != 0 || fresh)
            {
                ComPtr<ID3D11Texture2D> texture;
                if (desktop && SUCCEEDED(desktop.As(&texture)))
                {
                    D3D11_TEXTURE2D_DESC textureDesc = {};
                    texture->GetDesc(&textureDesc);
                    if (textureDesc.Width != width || textureDesc.Height != height)
                    {
                        capture.duplication->ReleaseFrame();
                        EmitError("The monitor's resolution changed - start desktop mode again.", false);
                        ok = false;
                        break;
                    }
                    if (textureDesc.Format == capture.format)
                    {
                        // Our own overlay's presents show up as frames with an unchanged picture.
                        const long long changedPixels = fresh || !changeDetection ? -1 : ChangedPixels(capture, texture.Get());
                        if (changedPixels >= 0)
                        {
                            ++comparedSince;
                            changedSum += changedPixels;
                            changedMax = std::max(changedMax, changedPixels);
                        }
                        if (changedPixels != 0)
                        {
                            if (!settings.diffDumpDir.empty() && changedPixels > 0 && diffDumps < 3 && NowMs() - startedAt > 3000.0)
                                DumpFramePair(capture, capture.shared11.Get(), texture.Get(), settings.diffDumpDir, ++diffDumps, changedPixels);
                            capture.context->CopyResource(capture.shared11.Get(), texture.Get());
                            dirty = true;
                            captured = true;
                            fresh = false;
                            capturedAt = NowMs();
                            ++updatesSince;
                        }
                        else ++ignoredSince;
                    }
                    else if (!formatLogged)
                    {
                        formatLogged = true;
                        Log("desktop frame format %u differs from the expected %u - frames skipped", static_cast<unsigned>(textureDesc.Format),
                            static_cast<unsigned>(capture.format));
                    }
                }
            }
            capture.duplication->ReleaseFrame();
        }
        else if (hr != DXGI_ERROR_WAIT_TIMEOUT)
        {
            EmitError("Desktop capture failed (" + Hex32(hr) + ").", false);
            ok = false;
            break;
        }

        const double now = NowMs();
        // Windows' "SDR content brightness" can change while we run.
        if (hdr && now - lastWhiteCheck > 500.0)
        {
            lastWhiteCheck = now;
            bool found = false;
            const float white = SdrWhiteScale(desc.Monitor, found);
            if (found && std::fabs(white - sdrScale) > 0.01f)
            {
                Log("SDR white level changed: %.2f -> %.2f", sdrScale, white);
                sdrScale = white;
                if (captured) { dirty = true; reset = true; }
            }
        }
        // The diagnostic snapshot is taken three seconds after the first
        // frame, re-processing the latest picture if nothing has changed.
        const bool snapshotDue = captured && frames > 0 && !settings.snapshotDir.empty() &&
            ((!snapshotDone && now - firstFrameAt >= 3000.0) || snapshotRequested);
        // Settle passes wait until the picture has been still for 50 ms: while
        // it keeps changing, the changes themselves drive the rendering.
        const bool still = captured && now - capturedAt > 50.0;
        if (captured && (dirty || (settleLeft > 0 && still) || snapshotDue) && visible && now - lastProcess >= interval
            && !(settings.overlayCheck == 1 && frames > 0))
        {
            const bool fromCapture = dirty;
            if (dirty) settleLeft = kSettlePasses;
            else if (settleLeft > 0) --settleLeft;
            capture.context4->Signal(capture.fence11.Get(), ++capture.fenceValue);
            capture.context->Flush();
            engine.Queue()->Wait(capture.fence12.Get(), capture.fenceValue);
            FrameArgs args;
            args.reset = reset;
            args.mix = mix;
            args.stabilize = stabilize;
            args.useMotion = wantMotion;
            args.motionToNr = settings.motionToNr;
            args.sdrScale = sdrScale;
            args.externalSource = capture.shared12.Get();
            args.presentTarget = buffers[chain->GetCurrentBackBufferIndex()].Get();
            args.splitX = split ? width / 2 : 0;
            args.marker = settings.overlayCheck ? kCheckMarker : 0;
            FrameStats stats;
            // Diagnostics: keep one before/after pair on disk.
            const bool snapshot = snapshotDue;
            args.readback = snapshot;
            if (!engine.Process(args, &stats)) { ok = false; break; }
            if (snapshot)
            {
                snapshotDone = true;
                snapshotRequested = false;
                ++snapshotCount;
                const std::wstring suffix = snapshotCount == 1 ? L"" : L"-" + std::to_wstring(snapshotCount);
                const size_t pixels = static_cast<size_t>(width) * height;
                std::vector<unsigned char> raw(pixels * (hdr ? 8 : 4)), after(pixels * 4), before(pixels * 4);
                std::string error;
                if (engine.ReadResult(raw.data(), static_cast<int>(width * (hdr ? 8 : 4))))
                {
                    if (hdr) ScRgbToRgba8(raw.data(), after.data(), pixels, sdrScale); else after.swap(raw);
                    FrameArgs plain = args;
                    plain.mix = 0.0f;
                    plain.presentTarget = nullptr;
                    plain.readback = true;
                    plain.reset = false;
                    FrameStats ignored;
                    capture.context4->Signal(capture.fence11.Get(), ++capture.fenceValue);
                    capture.context->Flush();
                    engine.Queue()->Wait(capture.fence12.Get(), capture.fenceValue);
                    std::vector<unsigned char> raw2(pixels * (hdr ? 8 : 4));
                    if (engine.Process(plain, &ignored) && engine.ReadResult(raw2.data(), static_cast<int>(width * (hdr ? 8 : 4))))
                    {
                        if (hdr) ScRgbToRgba8(raw2.data(), before.data(), pixels, sdrScale); else before.swap(raw2);
                        EnsureDirectory(settings.snapshotDir);
                        const bool savedAfter = SaveRgba(settings.snapshotDir + L"\\desktop-dlss5" + suffix + L".png", after.data(), width, height, false, 95, error);
                        const bool savedBefore = SaveRgba(settings.snapshotDir + L"\\desktop-original" + suffix + L".png", before.data(), width, height, false, 95, error);
                        JsonLine("snapshot").Bool("ok", savedAfter && savedBefore).WStr("dir", settings.snapshotDir).Str("message", error).Emit();
                    }
                }
            }
            hr = chain->Present(1, 0);
            if (FAILED(hr)) { EmitError("The overlay could not present (" + Hex32(hr) + ").", false); ok = false; break; }
            // DXGI_STATUS_OCCLUDED and friends are "success" codes: log what Present says.
            if (presents < 3 || hr != lastPresent) Log("present %llu: %s", presents + 1, Hex32(hr).c_str());
            lastPresent = hr;
            ++presents;
            if (!shown)
            {
                shown = true;
                ShowWindow(window, SW_SHOWNOACTIVATE);
                SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
                if (settings.overlayCheck) checkAt = NowMs() + 400.0;
            }
            reset = false;
            dirty = settings.overlayCheck == 2;   // test 2 keeps presenting, like a changing desktop would
            lastProcess = now;
            if (frames == 0) firstFrameAt = now;
            ++frames;
            ++framesSince;
            nrSum += stats.nrMs;
            gpuSum += stats.gpuMs;
            if (fromCapture) { latencySum += NowMs() - capturedAt; ++latencyCount; }
        }
        if (now - lastTopmost > 1000.0 && shown && visible)
        {
            lastTopmost = now;
            SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        if (now - lastStats >= 1000.0)
        {
            const double seconds = (now - lastStats) / 1000.0;
            JsonLine("desktop-stats").Num("fps", framesSince / seconds).Num("updates", updatesSince / seconds)
                .Num("ignored", ignoredSince / seconds).Num("sdrScale", sdrScale)
                .Int("changedAvg", comparedSince ? changedSum / comparedSince : -1).Int("changedMax", changedMax)
                .Num("nrMs", framesSince ? nrSum / framesSince : 0.0)
                .Num("gpuMs", framesSince ? gpuSum / framesSince : 0.0).Num("latencyMs", latencyCount ? latencySum / latencyCount : 0.0)
                .Int("frames", static_cast<long long>(frames)).Bool("visible", visible).Emit();
            lastStats = now;
            framesSince = 0;
            updatesSince = 0;
            ignoredSince = 0;
            comparedSince = 0;
            changedSum = changedMax = 0;
            nrSum = gpuSum = latencySum = 0.0;
            latencyCount = 0;
        }
    }

    ShowWindow(window, SW_HIDE);
    if (pacer) CloseHandle(pacer);
    if (stopKey) UnregisterHotKey(nullptr, kHotkeyStop);
    if (toggleKey) UnregisterHotKey(nullptr, kHotkeyToggle);
    if (splitKey) UnregisterHotKey(nullptr, kHotkeySplit);
    engine.WaitIdle();
    capture.duplication.Reset();
    if (dcompVisual) dcompVisual->SetContent(nullptr);
    if (dcomp) dcomp->Commit();
    dcompVisual.Reset();
    dcompTarget.Reset();
    dcomp.Reset();
    chain.Reset();
    for (auto &buffer : buffers) buffer.Reset();
    chain1.Reset();
    DestroyWindow(window);
    JsonLine("desktop-stopped").Int("frames", static_cast<long long>(frames)).Bool("ok", ok).Emit();
    return ok;
}
} // namespace dm
