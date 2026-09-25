// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - the neural rendering engine. Apache-2.0.
#include "engine.h"
#include "shaders.h"
#include "nvof-motion-provider.hpp"

#include <d3dcompiler.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

namespace dm
{
namespace
{
constexpr unsigned long long kGenericCustomCoreId = 0x0876232CULL;   // same id as the add-on
constexpr NVSDK_NGX_Feature kFeatureDlssNr = static_cast<NVSDK_NGX_Feature>(0x12);

using NgxCoreInitD3D12 = NVSDK_NGX_Result (NVSDK_CONV *)(unsigned long long, const wchar_t *, ID3D12Device *, NVSDK_NGX_Version);
using NgxSnippetInitD3D12Ext = NVSDK_NGX_Result (NVSDK_CONV *)(unsigned long long, const wchar_t *, ID3D12Device *, NVSDK_NGX_Version, const NVSDK_NGX_Parameter *);
using NgxGetCapabilityParameters = NVSDK_NGX_Result (NVSDK_CONV *)(NVSDK_NGX_Parameter **);
using NgxPopulateParameters = NVSDK_NGX_Result (NVSDK_CONV *)(NVSDK_NGX_Parameter *);
using NgxCreateFeature = NVSDK_NGX_Result (NVSDK_CONV *)(ID3D12GraphicsCommandList *, NVSDK_NGX_Feature, NVSDK_NGX_Parameter *, NVSDK_NGX_Handle **);
using NgxEvaluateFeature = NVSDK_NGX_Result (NVSDK_CONV *)(ID3D12GraphicsCommandList *, const NVSDK_NGX_Handle *, const NVSDK_NGX_Parameter *, PFN_NVSDK_NGX_ProgressCallback_C);
using NgxReleaseFeature = NVSDK_NGX_Result (NVSDK_CONV *)(NVSDK_NGX_Handle *);
using NgxBridgeInitD3D12Ext = NVSDK_NGX_Result (NVSDK_CONV *)(NgxSnippetInitD3D12Ext, unsigned long long, const wchar_t *, ID3D12Device *, NVSDK_NGX_Version, const NVSDK_NGX_Parameter *);
using NgxBridgeCreateFeature = NVSDK_NGX_Result (NVSDK_CONV *)(NgxCreateFeature, ID3D12GraphicsCommandList *, NVSDK_NGX_Feature, NVSDK_NGX_Parameter *, NVSDK_NGX_Handle **);
using NgxBridgeEvaluateFeature = NVSDK_NGX_Result (NVSDK_CONV *)(NgxEvaluateFeature, ID3D12GraphicsCommandList *, const NVSDK_NGX_Handle *, const NVSDK_NGX_Parameter *, PFN_NVSDK_NGX_ProgressCallback_C);
using NgxBridgeReleaseFeature = NVSDK_NGX_Result (NVSDK_CONV *)(NgxReleaseFeature, NVSDK_NGX_Handle *);
using NgxBridgePopulateParameters = NVSDK_NGX_Result (NVSDK_CONV *)(NgxPopulateParameters, NVSDK_NGX_Parameter *);

constexpr unsigned kWaitMs = 20000;

unsigned Groups(unsigned size) { return (size + 7) / 8; }

void NvofLog(const char *message) { Log("optical flow: %s", message); }

std::string DriverFromUmd(LARGE_INTEGER umd)
{
    // UMD 32.0.16.1714 -> "617.14": last digit of the third part + the fourth part.
    const unsigned part3 = HIWORD(umd.LowPart);
    const unsigned part4 = LOWORD(umd.LowPart);
    char digits[16];
    snprintf(digits, sizeof(digits), "%u%04u", part3 % 10, part4);
    std::string text(digits);
    if (text.size() == 5) return text.substr(0, 3) + "." + text.substr(3);
    return text;
}

bool ReadRegistryPath(HKEY root, const wchar_t *key, const wchar_t *name, std::wstring &out)
{
    wchar_t buffer[MAX_PATH * 2] = {};
    DWORD size = sizeof(buffer);
    DWORD type = 0;
    HKEY handle = nullptr;
    if (RegOpenKeyExW(root, key, 0, KEY_READ | KEY_WOW64_64KEY, &handle) != ERROR_SUCCESS) return false;
    const LONG result = RegQueryValueExW(handle, name, nullptr, &type, reinterpret_cast<BYTE *>(buffer), &size);
    RegCloseKey(handle);
    if (result != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ)) return false;
    buffer[(sizeof(buffer) / sizeof(wchar_t)) - 1] = 0;
    wchar_t expanded[MAX_PATH * 2] = {};
    if (type == REG_EXPAND_SZ && ExpandEnvironmentStringsW(buffer, expanded, MAX_PATH * 2)) out = expanded;
    else out = buffer;
    while (!out.empty() && (out.back() == L'\\' || out.back() == L'/')) out.pop_back();
    return !out.empty();
}
} // namespace

std::string NgxResultName(unsigned long result)
{
    switch (result)
    {
    case 0x1: return "Success";
    case 0xBAD00000: return "Fail";
    case 0xBAD00001: return "FeatureNotSupported";
    case 0xBAD00002: return "PlatformError";
    case 0xBAD00003: return "FeatureAlreadyExists";
    case 0xBAD00004: return "FeatureNotFound";
    case 0xBAD00005: return "InvalidParameter";
    case 0xBAD00006: return "ScratchBufferTooSmall";
    case 0xBAD00007: return "NotInitialized";
    case 0xBAD00008: return "UnsupportedInputFormat";
    case 0xBAD00009: return "RWFlagMissing";
    case 0xBAD0000A: return "MissingInput";
    case 0xBAD0000B: return "UnableToInitializeFeature";
    case 0xBAD0000C: return "OutOfDate";
    case 0xBAD0000D: return "OutOfGPUMemory";
    case 0xBAD0000E: return "UnsupportedFormat";
    case 0xBAD0000F: return "UnableToWriteToAppDataPath";
    case 0xBAD00010: return "UnsupportedParameter";
    case 0xBAD00011: return "Denied";
    case 0xBAD00012: return "NotImplemented";
    case 0x7fffffff: return "Exception";
    default: return Hex32(result);
    }
}

Engine::Engine() = default;

Engine::~Engine()
{
    if (device_) WaitIdle();
    if (nvof_) nvof_->Shutdown();
    // Features are released through the same module that created them. NGX
    // itself is never shut down or unloaded: that has been observed to wedge
    // after a successful feature-18 evaluation, and the process exits anyway.
    ReleaseFeatures();
    if (fenceEvent_) CloseHandle(fenceEvent_);
}

bool Engine::Initialize(const std::wstring &nrPath, const std::wstring &bridgePath, int adapterIndex)
{
    if (!CreateDevice(adapterIndex)) return false;
    if (!CreatePipelines()) return false;
    if (!InitializeNgx(nrPath, bridgePath)) return false;
    return true;
}

bool Engine::CreateDevice(int adapterIndex)
{
    HRESULT hr = CreateDXGIFactory2(0, IID_PPV_ARGS(&factory_));
    if (FAILED(hr)) { EmitError("DXGI factory could not be created (" + Hex32(hr) + ")", true); return false; }

    // The NVIDIA adapter with the most dedicated memory, unless one was named.
    ComPtr<IDXGIAdapter1> best;
    unsigned long long bestMemory = 0;
    for (UINT index = 0;; ++index)
    {
        ComPtr<IDXGIAdapter1> candidate;
        if (factory_->EnumAdapters1(index, &candidate) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_ADAPTER_DESC1 desc = {};
        candidate->GetDesc1(&desc);
        if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
        Log("adapter %u: %s vendor=0x%04X vram=%llu MB", index, Utf8(desc.Description).c_str(), desc.VendorId,
            static_cast<unsigned long long>(desc.DedicatedVideoMemory) >> 20);
        if (adapterIndex >= 0)
        {
            if (static_cast<int>(index) == adapterIndex) { best = candidate; break; }
            continue;
        }
        if (desc.VendorId != 0x10DE) continue;
        if (!best || desc.DedicatedVideoMemory > bestMemory) { best = candidate; bestMemory = desc.DedicatedVideoMemory; }
    }
    if (!best)
    {
        EmitError("No NVIDIA GPU was found. DLSS 5 neural rendering needs an NVIDIA RTX card.", true);
        return false;
    }
    adapter_ = best;
    DXGI_ADAPTER_DESC1 desc = {};
    adapter_->GetDesc1(&desc);
    info_.adapter = desc.Description;
    info_.vramBytes = desc.DedicatedVideoMemory;
    info_.luid = desc.AdapterLuid;
    info_.vendor = desc.VendorId;
    LARGE_INTEGER umd = {};
    if (SUCCEEDED(adapter_->CheckInterfaceSupport(__uuidof(IDXGIDevice), &umd))) info_.driver = DriverFromUmd(umd);

    hr = D3D12CreateDevice(adapter_.Get(), D3D_FEATURE_LEVEL_12_0, IID_PPV_ARGS(&device_));
    if (FAILED(hr)) { EmitError("Direct3D 12 device could not be created (" + Hex32(hr) + ")", true); return false; }

    D3D12_COMMAND_QUEUE_DESC queue = {};
    queue.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    hr = device_->CreateCommandQueue(&queue, IID_PPV_ARGS(&queue_));
    if (SUCCEEDED(hr))
    {
        queue.Type = D3D12_COMMAND_LIST_TYPE_COMPUTE;
        hr = device_->CreateCommandQueue(&queue, IID_PPV_ARGS(&computeQueue_));
    }
    if (SUCCEEDED(hr)) hr = device_->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence_));
    if (SUCCEEDED(hr)) hr = device_->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&computeFence_));
    for (int i = 0; i < 2 && SUCCEEDED(hr); ++i)
    {
        hr = device_->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocators_[i]));
        if (SUCCEEDED(hr)) hr = device_->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocators_[i].Get(), nullptr, IID_PPV_ARGS(&lists_[i]));
        if (SUCCEEDED(hr)) hr = lists_[i]->Close();
    }
    if (FAILED(hr)) { EmitError("Direct3D 12 queues could not be created (" + Hex32(hr) + ")", true); return false; }
    fenceEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);

    D3D12_QUERY_HEAP_DESC query = {};
    query.Type = D3D12_QUERY_HEAP_TYPE_TIMESTAMP;
    query.Count = 4;
    if (SUCCEEDED(device_->CreateQueryHeap(&query, IID_PPV_ARGS(&queries_))))
    {
        D3D12_HEAP_PROPERTIES heap = {D3D12_HEAP_TYPE_READBACK};
        D3D12_RESOURCE_DESC buffer = {};
        buffer.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
        buffer.Width = 4 * sizeof(UINT64);
        buffer.Height = 1; buffer.DepthOrArraySize = 1; buffer.MipLevels = 1;
        buffer.SampleDesc.Count = 1;
        buffer.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
        if (FAILED(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &buffer, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&queryReadback_))))
            queries_.Reset();
        UINT64 frequency = 0;
        if (SUCCEEDED(queue_->GetTimestampFrequency(&frequency)) && frequency) timestampFrequency_ = static_cast<double>(frequency);
    }

    Log("device: %s, %llu MB, driver %s", Utf8(info_.adapter).c_str(), info_.vramBytes >> 20, info_.driver.c_str());
    return true;
}

bool Engine::CreatePipelines()
{
    D3D12_DESCRIPTOR_RANGE ranges[2] = {};
    ranges[0].RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
    ranges[0].NumDescriptors = 6;
    ranges[1].RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_UAV;
    ranges[1].NumDescriptors = 3;
    ranges[1].OffsetInDescriptorsFromTableStart = 0;
    D3D12_ROOT_PARAMETER params[3] = {};
    params[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    params[0].DescriptorTable.NumDescriptorRanges = 1;
    params[0].DescriptorTable.pDescriptorRanges = &ranges[0];
    params[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    params[1].DescriptorTable.NumDescriptorRanges = 1;
    params[1].DescriptorTable.pDescriptorRanges = &ranges[1];
    params[2].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    params[2].Constants.Num32BitValues = 12;
    D3D12_STATIC_SAMPLER_DESC samplers[2] = {};
    for (int i = 0; i < 2; ++i)
    {
        samplers[i].Filter = i == 0 ? D3D12_FILTER_MIN_MAG_MIP_LINEAR : D3D12_FILTER_MIN_MAG_MIP_POINT;
        samplers[i].AddressU = samplers[i].AddressV = samplers[i].AddressW = D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
        samplers[i].MaxLOD = D3D12_FLOAT32_MAX;
        samplers[i].ShaderRegister = static_cast<UINT>(i);
        samplers[i].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
    }
    D3D12_ROOT_SIGNATURE_DESC desc = {};
    desc.NumParameters = 3;
    desc.pParameters = params;
    desc.NumStaticSamplers = 2;
    desc.pStaticSamplers = samplers;
    ComPtr<ID3DBlob> blob, errors;
    HRESULT hr = D3D12SerializeRootSignature(&desc, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &errors);
    if (SUCCEEDED(hr)) hr = device_->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(), IID_PPV_ARGS(&root_));
    if (FAILED(hr)) { EmitError("compute root signature failed (" + Hex32(hr) + ")", true); return false; }

    auto build = [&](const char *body, const char *name, ComPtr<ID3D12PipelineState> &pso) -> bool
    {
        std::string source = std::string(kShaderCommon) + body;
        ComPtr<ID3DBlob> code, messages;
        HRESULT result = D3DCompile(source.c_str(), source.size(), name, nullptr, nullptr, "CS", "cs_5_0",
            D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &messages);
        if (FAILED(result))
        {
            std::string text = messages ? std::string(static_cast<const char *>(messages->GetBufferPointer()), messages->GetBufferSize()) : "";
            EmitError(std::string("shader ") + name + " did not compile: " + text, true);
            return false;
        }
        D3D12_COMPUTE_PIPELINE_STATE_DESC state = {};
        state.pRootSignature = root_.Get();
        state.CS = {code->GetBufferPointer(), code->GetBufferSize()};
        result = device_->CreateComputePipelineState(&state, IID_PPV_ARGS(&pso));
        if (FAILED(result)) { EmitError(std::string("pipeline ") + name + " failed (" + Hex32(result) + ")", true); return false; }
        return true;
    };
    if (!build(kShaderIngest, "ingest", psoIngest_) || !build(kShaderDownscale, "downscale", psoDownscale_) ||
        !build(kShaderEffect, "effect", psoEffect_) || !build(kShaderComposite, "composite", psoComposite_))
        return false;

    D3D12_DESCRIPTOR_HEAP_DESC heap = {};
    heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    heap.NumDescriptors = kHeapSize;
    heap.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    hr = device_->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&heap_));
    if (FAILED(hr)) { EmitError("descriptor heap failed (" + Hex32(hr) + ")", true); return false; }
    heapStride_ = device_->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);
    return true;
}

HMODULE Engine::LoadNgxCore()
{
    // NVIDIA's own loader order: the driver's registry keys first, then the
    // legacy global key. Our add-on's DriverStore scan (newest _nvngx.dll) is
    // the fallback. A copy next to our exe is deliberately never looked for.
    const struct { HKEY root; const wchar_t *key; const wchar_t *name; } keys[] = {
        {HKEY_LOCAL_MACHINE, L"System\\CurrentControlSet\\Services\\nvlddmkm\\Parameters\\NGXCore", L"NGXPath"},
        {HKEY_LOCAL_MACHINE, L"System\\CurrentControlSet\\Services\\nvlddmkm\\NGXCore", L"NGXPath"},
        {HKEY_LOCAL_MACHINE, L"SOFTWARE\\NVIDIA Corporation\\Global\\NGXCore", L"FullPath"},
    };
    for (const auto &entry : keys)
    {
        std::wstring dir;
        if (!ReadRegistryPath(entry.root, entry.key, entry.name, dir)) continue;
        const std::wstring candidate = dir + L"\\_nvngx.dll";
        if (!FileExists(candidate)) { Log("NGX core: registry %ls -> %ls has no _nvngx.dll", entry.key, dir.c_str()); continue; }
        HMODULE module = LoadLibraryExW(candidate.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
        Log("NGX core: %ls -> %p (error %lu)", candidate.c_str(), module, module ? 0 : GetLastError());
        if (module) return module;
    }
    wchar_t system[MAX_PATH] = {};
    if (!GetSystemDirectoryW(system, MAX_PATH)) return nullptr;
    const std::wstring pattern = std::wstring(system) + L"\\DriverStore\\FileRepository\\nv*.inf_amd64_*";
    WIN32_FIND_DATAW found = {};
    HANDLE search = FindFirstFileW(pattern.c_str(), &found);
    if (search == INVALID_HANDLE_VALUE) return nullptr;
    std::wstring best;
    FILETIME bestTime = {};
    do
    {
        if (!(found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        const std::wstring candidate = std::wstring(system) + L"\\DriverStore\\FileRepository\\" + found.cFileName + L"\\_nvngx.dll";
        WIN32_FILE_ATTRIBUTE_DATA attributes = {};
        if (!GetFileAttributesExW(candidate.c_str(), GetFileExInfoStandard, &attributes)) continue;
        if (best.empty() || CompareFileTime(&attributes.ftLastWriteTime, &bestTime) > 0) { best = candidate; bestTime = attributes.ftLastWriteTime; }
    } while (FindNextFileW(search, &found));
    FindClose(search);
    if (best.empty()) return nullptr;
    HMODULE module = LoadLibraryExW(best.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    Log("NGX core (DriverStore scan): %ls -> %p (error %lu)", best.c_str(), module, module ? 0 : GetLastError());
    return module;
}

bool Engine::InitializeNgx(const std::wstring &nrPath, const std::wstring &bridgePath)
{
    auto fail = [](const std::string &message) { EmitError(message, true); return false; };
    if (!FileExists(nrPath)) return fail("nvngx_dlssnr.dll was not found at " + Utf8(nrPath));
    if (!FileExists(bridgePath)) return fail("The caller bridge nvngx.dll was not found at " + Utf8(bridgePath));

    nrModule_ = LoadLibraryExW(nrPath.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!nrModule_) return fail("nvngx_dlssnr.dll could not be loaded (Windows error " + std::to_string(GetLastError()) + ")");
    auto nrInit = reinterpret_cast<NgxSnippetInitD3D12Ext>(GetProcAddress(nrModule_, "NVSDK_NGX_D3D12_Init_Ext"));
    nrCreate_ = reinterpret_cast<void *>(GetProcAddress(nrModule_, "NVSDK_NGX_D3D12_CreateFeature"));
    nrEvaluate_ = reinterpret_cast<void *>(GetProcAddress(nrModule_, "NVSDK_NGX_D3D12_EvaluateFeature"));
    nrRelease_ = reinterpret_cast<void *>(GetProcAddress(nrModule_, "NVSDK_NGX_D3D12_ReleaseFeature"));
    nrPopulate_ = reinterpret_cast<void *>(GetProcAddress(nrModule_, "NVSDK_NGX_D3D12_PopulateParameters_Impl"));
    bridgeModule_ = LoadLibraryExW(bridgePath.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!bridgeModule_) return fail("The caller bridge could not be loaded (Windows error " + std::to_string(GetLastError()) + ")");
    auto bridgeInit = reinterpret_cast<NgxBridgeInitD3D12Ext>(GetProcAddress(bridgeModule_, "NVNGXBridge_D3D12_InitExt"));
    bridgeCreate_ = reinterpret_cast<void *>(GetProcAddress(bridgeModule_, "NVNGXBridge_D3D12_CreateFeature"));
    bridgeEvaluate_ = reinterpret_cast<void *>(GetProcAddress(bridgeModule_, "NVNGXBridge_D3D12_EvaluateFeature"));
    bridgeRelease_ = reinterpret_cast<void *>(GetProcAddress(bridgeModule_, "NVNGXBridge_D3D12_ReleaseFeature"));
    bridgePopulate_ = reinterpret_cast<void *>(GetProcAddress(bridgeModule_, "NVNGXBridge_D3D12_PopulateParameters"));
    if (!nrInit || !nrCreate_ || !nrEvaluate_ || !nrRelease_ || !nrPopulate_)
        return fail("nvngx_dlssnr.dll does not export the neural rendering entry points - it is not a DLSS 5 NR runtime.");
    if (!bridgeInit || !bridgeCreate_ || !bridgeEvaluate_ || !bridgeRelease_ || !bridgePopulate_)
        return fail("The caller bridge nvngx.dll is missing exports - reinstall the AIO Installer.");

    coreModule_ = LoadNgxCore();
    auto coreInit = coreModule_ ? reinterpret_cast<NgxCoreInitD3D12>(GetProcAddress(coreModule_, "NVSDK_NGX_D3D12_Init")) : nullptr;
    auto getCapabilities = coreModule_ ? reinterpret_cast<NgxGetCapabilityParameters>(GetProcAddress(coreModule_, "NVSDK_NGX_D3D12_GetCapabilityParameters")) : nullptr;
    if (!coreInit || !getCapabilities) return fail("The NVIDIA driver's NGX core (_nvngx.dll) was not found. Update or repair the NVIDIA driver.");

    wchar_t local[MAX_PATH] = {};
    std::wstring dataPath;
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH)) dataPath = std::wstring(local) + L"\\DLSS5-AIO\\ngx";
    else { wchar_t temp[MAX_PATH] = {}; GetTempPathW(MAX_PATH, temp); dataPath = std::wstring(temp) + L"DLSS5-AIO-ngx"; }
    EnsureDirectory(dataPath);

    NVSDK_NGX_Result result = coreInit(kGenericCustomCoreId, dataPath.c_str(), device_.Get(), NVSDK_NGX_Version_API);
    Log("driver-core Init = %s (%s)", Hex32(result).c_str(), NgxResultName(result).c_str());
    JsonLine("ngx").Str("stage", "core-init").Str("result", Hex32(result)).Str("name", NgxResultName(result)).Emit();
    if (NVSDK_NGX_FAILED(result)) return fail("The NVIDIA driver refused to start NGX (" + NgxResultName(result) + ").");

    // Init_Ext is called through the bridge so the snippet sees a caller whose
    // module name contains "nvngx.dll" - the same contract as in games.
    result = bridgeInit(nrInit, kGenericCustomCoreId, nrPath.c_str(), device_.Get(), NVSDK_NGX_Version_API, nullptr);
    Log("NR snippet Init_Ext = %s (%s)", Hex32(result).c_str(), NgxResultName(result).c_str());
    JsonLine("ngx").Str("stage", "nr-init").Str("result", Hex32(result)).Str("name", NgxResultName(result)).Emit();
    if (NVSDK_NGX_FAILED(result))
        return fail("The neural rendering runtime refused to start (" + NgxResultName(result) + "). "
            "0xBAD00002 usually means a modified or damaged nvngx_dlssnr.dll, or a GPU it has no kernels for.");

    result = getCapabilities(&params_);
    if (NVSDK_NGX_FAILED(result) || !params_) return fail("NGX parameters could not be allocated (" + NgxResultName(result) + ").");
    result = reinterpret_cast<NgxBridgePopulateParameters>(bridgePopulate_)(reinterpret_cast<NgxPopulateParameters>(nrPopulate_), params_);
    Log("NR PopulateParameters = %s", Hex32(result).c_str());
    if (NVSDK_NGX_FAILED(result)) return fail("The neural rendering runtime could not describe its parameters (" + NgxResultName(result) + ").");
    params_->Get("DLSSNRComputeScalingRatioCallback", &scalingCallback_);
    ngxReady_ = true;
    return true;
}

bool Engine::CreateTex(unsigned w, unsigned h, DXGI_FORMAT format, bool uav, Tex &out, const wchar_t *name)
{
    out = Tex();
    D3D12_HEAP_PROPERTIES heap = {D3D12_HEAP_TYPE_DEFAULT};
    D3D12_RESOURCE_DESC desc = {};
    desc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    desc.Width = w;
    desc.Height = h;
    desc.DepthOrArraySize = 1;
    desc.MipLevels = 1;
    desc.Format = format;
    desc.SampleDesc.Count = 1;
    desc.Flags = uav ? D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS : D3D12_RESOURCE_FLAG_NONE;
    const HRESULT hr = device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc, D3D12_RESOURCE_STATE_COMMON, nullptr, IID_PPV_ARGS(&out.res));
    if (FAILED(hr))
    {
        EmitError("GPU memory for a " + std::to_string(w) + "x" + std::to_string(h) + " texture could not be allocated (" + Hex32(hr) + ")", false);
        return false;
    }
    if (name) out.res->SetName(name);
    out.format = format;
    out.width = w;
    out.height = h;
    out.state = D3D12_RESOURCE_STATE_COMMON;
    return true;
}

bool Engine::FillTex(Tex &tex, const void *pixel, unsigned bytesPerPixel)
{
    D3D12_RESOURCE_DESC desc = tex.res->GetDesc();
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint = {};
    UINT64 total = 0;
    device_->GetCopyableFootprints(&desc, 0, 1, 0, &footprint, nullptr, nullptr, &total);
    ComPtr<ID3D12Resource> staging;
    D3D12_HEAP_PROPERTIES heap = {D3D12_HEAP_TYPE_UPLOAD};
    D3D12_RESOURCE_DESC buffer = {};
    buffer.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    buffer.Width = total;
    buffer.Height = 1; buffer.DepthOrArraySize = 1; buffer.MipLevels = 1;
    buffer.SampleDesc.Count = 1;
    buffer.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    if (FAILED(device_->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &buffer, D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&staging))))
        return false;
    unsigned char *mapped = nullptr;
    if (FAILED(staging->Map(0, nullptr, reinterpret_cast<void **>(&mapped)))) return false;
    for (UINT y = 0; y < footprint.Footprint.Height; ++y)
    {
        unsigned char *row = mapped + footprint.Offset + static_cast<size_t>(y) * footprint.Footprint.RowPitch;
        for (UINT x = 0; x < footprint.Footprint.Width; ++x) memcpy(row + static_cast<size_t>(x) * bytesPerPixel, pixel, bytesPerPixel);
    }
    staging->Unmap(0, nullptr);
    if (!BeginList(1)) return false;
    ID3D12GraphicsCommandList *list = lists_[1].Get();
    Barrier(list, tex, D3D12_RESOURCE_STATE_COPY_DEST);
    D3D12_TEXTURE_COPY_LOCATION dst = {tex.res.Get(), D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
    dst.SubresourceIndex = 0;
    D3D12_TEXTURE_COPY_LOCATION src = {staging.Get(), D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT};
    src.PlacedFootprint = footprint;
    list->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    Barrier(list, tex, D3D12_RESOURCE_STATE_COMMON);
    return SubmitList(1, true);
}

void Engine::Barrier(ID3D12GraphicsCommandList *list, Tex &tex, D3D12_RESOURCE_STATES to)
{
    if (!tex.res || tex.state == to) return;
    Barrier(list, tex.res.Get(), tex.state, to);
    tex.state = to;
}

void Engine::Barrier(ID3D12GraphicsCommandList *list, ID3D12Resource *res, D3D12_RESOURCE_STATES from, D3D12_RESOURCE_STATES to)
{
    if (!res || from == to) return;
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = res;
    barrier.Transition.StateBefore = from;
    barrier.Transition.StateAfter = to;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    list->ResourceBarrier(1, &barrier);
}

UINT64 Engine::Signal()
{
    const UINT64 value = ++fenceValue_;
    queue_->Signal(fence_.Get(), value);
    return value;
}

void Engine::WaitFence(UINT64 value)
{
    if (fence_->GetCompletedValue() >= value) return;
    fence_->SetEventOnCompletion(value, fenceEvent_);
    if (WaitForSingleObject(fenceEvent_, kWaitMs) != WAIT_OBJECT_0)
    {
        const HRESULT removed = device_->GetDeviceRemovedReason();
        EmitError("The GPU did not finish a frame within 20 s (device state " + Hex32(removed) + ").", true);
        Log("fence wait timed out at %llu (completed %llu)", value, fence_->GetCompletedValue());
        ExitProcess(4);
    }
}

void Engine::WaitIdle()
{
    if (!queue_ || !fence_) return;
    WaitFence(Signal());
}

bool Engine::BeginList(int which)
{
    WaitFence(listFence_[which]);
    HRESULT hr = allocators_[which]->Reset();
    if (SUCCEEDED(hr)) hr = lists_[which]->Reset(allocators_[which].Get(), nullptr);
    if (FAILED(hr)) { EmitError("command list reset failed (" + Hex32(hr) + ")", true); return false; }
    listOpen_[which] = true;
    return true;
}

bool Engine::SubmitList(int which, bool waitCpu)
{
    listOpen_[which] = false;
    HRESULT hr = lists_[which]->Close();
    if (FAILED(hr)) { EmitError("command list close failed (" + Hex32(hr) + ")", true); return false; }
    ID3D12CommandList *lists[] = {lists_[which].Get()};
    queue_->ExecuteCommandLists(1, lists);
    listFence_[which] = Signal();
    if (waitCpu) WaitFence(listFence_[which]);
    return true;
}

void Engine::BindCompute(ID3D12GraphicsCommandList *list)
{
    ID3D12DescriptorHeap *heaps[] = {heap_.Get()};
    list->SetDescriptorHeaps(1, heaps);
    list->SetComputeRootSignature(root_.Get());
}

void Engine::Dispatch(ID3D12GraphicsCommandList *list, ID3D12PipelineState *pso,
    std::initializer_list<View> srvs, std::initializer_list<View> uavs,
    const void *constants, unsigned constantCount, unsigned groupsX, unsigned groupsY)
{
    if (heapCursor_ + 9 > kHeapSize) heapCursor_ = 0;   // one frame in flight: a wrap is safe
    const unsigned base = heapCursor_;
    heapCursor_ += 9;
    D3D12_CPU_DESCRIPTOR_HANDLE cpu = heap_->GetCPUDescriptorHandleForHeapStart();
    D3D12_GPU_DESCRIPTOR_HANDLE gpu = heap_->GetGPUDescriptorHandleForHeapStart();
    auto cpuAt = [&](unsigned index) { D3D12_CPU_DESCRIPTOR_HANDLE h = cpu; h.ptr += static_cast<SIZE_T>(index) * heapStride_; return h; };
    auto gpuAt = [&](unsigned index) { D3D12_GPU_DESCRIPTOR_HANDLE h = gpu; h.ptr += static_cast<UINT64>(index) * heapStride_; return h; };
    unsigned slot = 0;
    for (const View &view : srvs)
    {
        D3D12_SHADER_RESOURCE_VIEW_DESC desc = {};
        desc.Format = view.format != DXGI_FORMAT_UNKNOWN ? view.format :
            (view.res ? view.res->GetDesc().Format : DXGI_FORMAT_R8G8B8A8_UNORM);
        desc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
        desc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        desc.Texture2D.MipLevels = 1;
        device_->CreateShaderResourceView(view.res, &desc, cpuAt(base + slot));
        ++slot;
    }
    for (; slot < 6; ++slot)
    {
        D3D12_SHADER_RESOURCE_VIEW_DESC desc = {};
        desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        desc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
        desc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        desc.Texture2D.MipLevels = 1;
        device_->CreateShaderResourceView(nullptr, &desc, cpuAt(base + slot));
    }
    unsigned uslot = 0;
    for (const View &view : uavs)
    {
        D3D12_UNORDERED_ACCESS_VIEW_DESC desc = {};
        desc.Format = view.format != DXGI_FORMAT_UNKNOWN ? view.format :
            (view.res ? view.res->GetDesc().Format : DXGI_FORMAT_R8G8B8A8_UNORM);
        desc.ViewDimension = D3D12_UAV_DIMENSION_TEXTURE2D;
        device_->CreateUnorderedAccessView(view.res, nullptr, &desc, cpuAt(base + 6 + uslot));
        ++uslot;
    }
    for (; uslot < 3; ++uslot)
    {
        D3D12_UNORDERED_ACCESS_VIEW_DESC desc = {};
        desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        desc.ViewDimension = D3D12_UAV_DIMENSION_TEXTURE2D;
        device_->CreateUnorderedAccessView(nullptr, nullptr, &desc, cpuAt(base + 6 + uslot));
    }
    list->SetPipelineState(pso);
    list->SetComputeRootDescriptorTable(0, gpuAt(base));
    list->SetComputeRootDescriptorTable(1, gpuAt(base + 6));
    unsigned values[12] = {};
    memcpy(values, constants, std::min(constantCount, 12u) * sizeof(unsigned));
    list->SetComputeRoot32BitConstants(2, 12, values, 0);
    list->Dispatch(groupsX, groupsY, 1);
}

bool Engine::MotionReady() const { return nvof_ && nvof_->IsReady(); }

bool Engine::Configure(unsigned width, unsigned height, SourceKind source, OutputKind output,
    unsigned long long maxWorkPixels, const NrLook &look, bool wantMotion)
{
    if (!ngxReady_) return false;
    if (width < 64 || height < 64) { EmitError("The picture is smaller than 64x64 pixels - too small for neural rendering.", false); return false; }
    if (width > 16384 || height > 16384) { EmitError("The picture is larger than 16384 pixels on a side.", false); return false; }

    unsigned ww = width, wh = height;
    if (maxWorkPixels && static_cast<unsigned long long>(width) * height > maxWorkPixels)
    {
        const double scale = std::sqrt(static_cast<double>(maxWorkPixels) / (static_cast<double>(width) * height));
        ww = std::max(64u, static_cast<unsigned>(std::floor(width * scale)) & ~1u);
        wh = std::max(64u, static_cast<unsigned>(std::floor(height * scale)) & ~1u);
    }

    const bool sizeChanged = width != width_ || height != height_ || ww != workWidth_ || wh != workHeight_ ||
        source != sourceKind_ || output != outputKind_ || !output_;
    const int passes = std::clamp(look.passes, 1, 3);
    const bool featureChanged = sizeChanged || !look.SameFeature(featureLook_) || passes != requestedPasses_ ||
        featureWidth_ != ww || featureHeight_ != wh || featureCount_ == 0;
    look_ = look;
    look_.passes = passes;

    if (sizeChanged)
    {
        WaitIdle();
        if (nvof_) nvof_->Shutdown();
        width_ = width; height_ = height; workWidth_ = ww; workHeight_ = wh;
        sourceKind_ = source; outputKind_ = output;
        const DXGI_FORMAT sourceFormat = source == SourceKind::ScRgb16 ? DXGI_FORMAT_R16G16B16A16_FLOAT :
            source == SourceKind::Bgra8 ? DXGI_FORMAT_B8G8R8A8_UNORM : DXGI_FORMAT_R8G8B8A8_UNORM;
        const DXGI_FORMAT outputFormat = output == OutputKind::ScRgb16 ? DXGI_FORMAT_R16G16B16A16_FLOAT : DXGI_FORMAT_R8G8B8A8_UNORM;
        const bool fullIsWork = ww == width && wh == height;
        bool ok = CreateTex(width, height, sourceFormat, false, source_, L"dm.source") &&
            CreateTex(width, height, DXGI_FORMAT_R8G8B8A8_UNORM, true, full_, L"dm.full") &&
            (fullIsWork || CreateTex(ww, wh, DXGI_FORMAT_R8G8B8A8_UNORM, true, work_, L"dm.work")) &&
            CreateTex(ww, wh, DXGI_FORMAT_R16G16B16A16_FLOAT, true, effect_[0], L"dm.effect0") &&
            CreateTex(ww, wh, DXGI_FORMAT_R16G16B16A16_FLOAT, true, effect_[1], L"dm.effect1") &&
            CreateTex(ww, wh, DXGI_FORMAT_R8G8B8A8_UNORM, true, prevWork_, L"dm.previous") &&
            CreateTex(ww, wh, DXGI_FORMAT_R16G16_FLOAT, false, zeroMotion_, L"dm.zero-motion") &&
            CreateTex(ww, wh, DXGI_FORMAT_R32_FLOAT, false, flatDepth_, L"dm.flat-depth") &&
            CreateTex(width, height, outputFormat, true, output_, L"dm.output");
        for (int i = 0; ok && i < 3; ++i) ok = CreateTex(ww, wh, DXGI_FORMAT_R8G8B8A8_UNORM, true, nrOut_[i], L"dm.nr-out");
        if (!ok) return false;
        if (fullIsWork) work_ = Tex();
        const unsigned zero = 0;
        const float farDepth = 1.0f;   // flat far-plane depth, the add-on's own fallback guide
        if (!FillTex(zeroMotion_, &zero, 4) || !FillTex(flatDepth_, &farDepth, 4)) { EmitError("guide textures could not be initialised", false); return false; }

        // Upload and readback staging, laid out the way the copy engine wants.
        D3D12_RESOURCE_DESC desc = source_.res->GetDesc();
        UINT64 total = 0;
        device_->GetCopyableFootprints(&desc, 0, 1, 0, &uploadFootprint_, nullptr, nullptr, &total);
        D3D12_HEAP_PROPERTIES upload = {D3D12_HEAP_TYPE_UPLOAD};
        D3D12_RESOURCE_DESC buffer = {};
        buffer.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
        buffer.Width = total;
        buffer.Height = 1; buffer.DepthOrArraySize = 1; buffer.MipLevels = 1;
        buffer.SampleDesc.Count = 1;
        buffer.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
        upload_.Reset();
        if (FAILED(device_->CreateCommittedResource(&upload, D3D12_HEAP_FLAG_NONE, &buffer, D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&upload_))))
        { EmitError("upload memory could not be allocated", false); return false; }
        desc = output_.res->GetDesc();
        device_->GetCopyableFootprints(&desc, 0, 1, 0, &readbackFootprint_, nullptr, nullptr, &total);
        D3D12_HEAP_PROPERTIES readback = {D3D12_HEAP_TYPE_READBACK};
        buffer.Width = total;
        readback_.Reset();
        if (FAILED(device_->CreateCommittedResource(&readback, D3D12_HEAP_FLAG_NONE, &buffer, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&readback_))))
        { EmitError("readback memory could not be allocated", false); return false; }
        historyValid_ = false;
        Log("configured %ux%u (work %ux%u), source %d, output %d", width, height, ww, wh, static_cast<int>(source), static_cast<int>(output));
    }

    wantMotion_ = wantMotion;
    if (wantMotion && (!nvof_ || !nvof_->IsReady()))
    {
        if (!nvof_) nvof_ = std::make_unique<NvofMotionProvider>();
        // Flow at no more than ~720 lines: finer flow is slower and noisier on
        // video, and the vectors are rescaled to the working size anyway.
        unsigned fw = ww, fh = wh;
        if (fh > 720) { fw = std::max(64u, static_cast<unsigned>(std::lround(ww * 720.0 / wh))); fh = 720; }
        if (!nvof_->Initialize(device_.Get(), computeQueue_.Get(), fence_.Get(), ww, wh, fw, fh, DXGI_FORMAT_R8G8B8A8_UNORM, NvofLog))
        {
            EmitWarning(std::string("NVIDIA Optical Flow is unavailable (") + nvof_->Status() + ") - continuing without motion; the stabiliser is off.");
            nvof_.reset();
        }
    }

    if (featureChanged)
    {
        WaitIdle();
        ReleaseFeatures();
        featureLook_ = look_;
        featureWidth_ = ww;
        featureHeight_ = wh;
        requestedPasses_ = passes;
        if (!CreateFeatures()) return false;
    }
    return true;
}

void Engine::SetCreateParams()
{
    const unsigned w = workWidth_, h = workHeight_;
    params_->Reset();
    reinterpret_cast<NgxBridgePopulateParameters>(bridgePopulate_)(reinterpret_cast<NgxPopulateParameters>(nrPopulate_), params_);
    params_->Set("CreationNodeMask", 1u);
    params_->Set("VisibilityNodeMask", 1u);
    params_->Set("Width", w); params_->Set("Height", h);
    params_->Set("OutWidth", w); params_->Set("OutHeight", h);
    params_->Set("ResourceWidth", w); params_->Set("ResourceHeight", h);
    params_->Set("ResourceOutWidth", w); params_->Set("ResourceOutHeight", h);
    params_->Set("PerfQualityValue", static_cast<int>(NVSDK_NGX_PerfQuality_Value_UltraQuality));
    params_->Set("DLSS.Feature.Create.Flags", static_cast<int>(NVSDK_NGX_DLSS_Feature_Flags_MVLowRes | NVSDK_NGX_DLSS_Feature_Flags_AutoExposure));
    params_->Set("DLSS.Enable.Output.Subrects", 0);
    params_->Set("DLSS.Denoise.Mode", 1);
    params_->Set("DLSS.Roughness.Mode", 0u);
    params_->Set("DLSS.Use.HW.Depth", 1u);
    params_->Set("DLSSNR.Enabled", 1u);
    params_->Set("DLSSNR.InputWidth", w); params_->Set("DLSSNR.InputHeight", h);
    params_->Set("DLSSNR.Width", w); params_->Set("DLSSNR.Height", h);
    params_->Set("DLSSNR.OutputWidth", w); params_->Set("DLSSNR.OutputHeight", h);
    params_->Set("Output.Width", w); params_->Set("Output.Height", h);
    params_->Set("DLSSNR.Upscaling", 1u);
    params_->Set("DLSSNR.ScalingRatio", 1.0f); params_->Set("DLSSNR.Scale", 1.0f);
    params_->Set("DLSSNR.Hint.Render.Preset", 1);
    params_->Set("DLSSNR.Style", static_cast<unsigned>(std::clamp(look_.style, 0, 2)));
    params_->Set("DLSSNR.Intensity", std::clamp(look_.intensity, 0.0f, 1.0f));
    params_->Set("DLSSNR.LocalToneStrength", std::clamp(look_.tone, 0.0f, 2.0f));
    params_->Set("DLSSNR.LocalStructureStrength", std::clamp(look_.structure, 0.0f, 2.0f));
    params_->Set("DLSSNR.SkinStructureStrength", look_.skin < 0.0f ? -1.0f : std::min(look_.skin, 0.99f));
    params_->Set("DLSSNR.UseAutoMask", look_.autoMask ? 1u : 0u);
    params_->Set("DLSSNR.UICorrection", 0u);
    scalingRatio_ = 1.0f;
    if (scalingCallback_)
    {
        reinterpret_cast<NgxPopulateParameters>(scalingCallback_)(params_);
        float resolved = 1.0f;
        if (NVSDK_NGX_SUCCEED(params_->Get("DLSSNR.ScalingRatio", &resolved)) && resolved > 0.0f) scalingRatio_ = resolved;
        params_->Set("DLSSNR.Scale", scalingRatio_);
    }
}

void Engine::SetEvalParams(ID3D12Resource *color, ID3D12Resource *output, ID3D12Resource *motion, bool reset)
{
    const unsigned w = workWidth_, h = workHeight_;
    ID3D12Resource *depth = flatDepth_.res.Get();
    for (const char *name : {"Color", "DLSSNR.Color"}) params_->Set(name, color);
    for (const char *name : {"Output", "DLSSNR.Output"}) params_->Set(name, output);
    for (const char *name : {"Depth", "DLSSNR.Depth"}) params_->Set(name, depth);
    params_->Set("MotionVectors", motion); params_->Set("DLSSNR.MVec", motion);
    params_->Set("Reset", reset ? 1 : 0); params_->Set("DLSSNR.Reset", reset ? 1 : 0);
    params_->Set("Jitter.Offset.X", 0.0f); params_->Set("Jitter.Offset.Y", 0.0f);
    params_->Set("MV.Scale.X", 1.0f); params_->Set("MV.Scale.Y", 1.0f);
    params_->Set("DLSSNR.JitterOffsetX", 0.0f); params_->Set("DLSSNR.JitterOffsetY", 0.0f);
    params_->Set("DLSSNR.MVecScaleX", 1.0f); params_->Set("DLSSNR.MVecScaleY", 1.0f);
    params_->Set("DLSS.Pre.Exposure", 1.0f); params_->Set("DLSS.Exposure.Scale", 1.0f);
    params_->Set("DLSS.Render.Subrect.Dimensions.Width", w); params_->Set("DLSS.Render.Subrect.Dimensions.Height", h);
    params_->Set("DLSS.Input.Color.Subrect.Base.X", 0u); params_->Set("DLSS.Input.Color.Subrect.Base.Y", 0u);
    params_->Set("DLSS.Input.Depth.Subrect.Base.X", 0u); params_->Set("DLSS.Input.Depth.Subrect.Base.Y", 0u);
    params_->Set("DLSS.Input.MV.Subrect.Base.X", 0u); params_->Set("DLSS.Input.MV.Subrect.Base.Y", 0u);
    params_->Set("DLSS.Output.Subrect.Base.X", 0u); params_->Set("DLSS.Output.Subrect.Base.Y", 0u);
    params_->Set("DLSSNR.ColorSubrectBaseX", 0); params_->Set("DLSSNR.ColorSubrectBaseY", 0);
    params_->Set("DLSSNR.ColorSubrectWidth", static_cast<int>(w)); params_->Set("DLSSNR.ColorSubrectHeight", static_cast<int>(h));
    params_->Set("DLSSNR.MVecSubrectBaseX", 0); params_->Set("DLSSNR.MVecSubrectBaseY", 0);
    params_->Set("DLSSNR.MVecSubrectWidth", static_cast<int>(w)); params_->Set("DLSSNR.MVecSubrectHeight", static_cast<int>(h));
    params_->Set("DLSSNR.DepthSubrectBaseX", 0); params_->Set("DLSSNR.DepthSubrectBaseY", 0);
    params_->Set("DLSSNR.DepthSubrectWidth", static_cast<int>(w)); params_->Set("DLSSNR.DepthSubrectHeight", static_cast<int>(h));
    params_->Set("DLSSNR.OutputSubrectBaseX", 0); params_->Set("DLSSNR.OutputSubrectBaseY", 0);
    params_->Set("DLSSNR.OutputSubrectWidth", static_cast<int>(w)); params_->Set("DLSSNR.OutputSubrectHeight", static_cast<int>(h));
    params_->Set("DLSSNR.ControlMask", static_cast<ID3D12Resource *>(nullptr));
    params_->Set("DLSSNR.DepthInverted", 0u);
    params_->Set("DLSSNR.InputWidth", w); params_->Set("DLSSNR.InputHeight", h);
    params_->Set("DLSSNR.Width", w); params_->Set("DLSSNR.Height", h);
    params_->Set("DLSSNR.OutputWidth", w); params_->Set("DLSSNR.OutputHeight", h);
    params_->Set("DLSSNR.Upscaling", 1u);
    params_->Set("DLSSNR.ScalingRatio", scalingRatio_); params_->Set("DLSSNR.Scale", scalingRatio_);
    params_->Set("DLSSNR.Hint.Render.Preset", 1);
    params_->Set("DLSSNR.Style", static_cast<unsigned>(std::clamp(look_.style, 0, 2)));
    params_->Set("DLSSNR.Intensity", std::clamp(look_.intensity, 0.0f, 1.0f));
    params_->Set("DLSSNR.LocalToneStrength", std::clamp(look_.tone, 0.0f, 2.0f));
    params_->Set("DLSSNR.LocalStructureStrength", std::clamp(look_.structure, 0.0f, 2.0f));
    params_->Set("DLSSNR.SkinStructureStrength", look_.skin < 0.0f ? -1.0f : std::min(look_.skin, 0.99f));
    params_->Set("DLSSNR.Enabled", 1u);
    params_->Set("DLSSNR.UseAutoMask", look_.autoMask ? 1u : 0u);
    params_->Set("DLSSNR.UICorrection", 0u);
}

NVSDK_NGX_Result Engine::SafeCreate(NVSDK_NGX_Handle **handle, unsigned long *exception)
{
    *exception = 0;
    auto create = reinterpret_cast<NgxBridgeCreateFeature>(bridgeCreate_);
    auto target = reinterpret_cast<NgxCreateFeature>(nrCreate_);
    ID3D12GraphicsCommandList *list = lists_[1].Get();
    NVSDK_NGX_Parameter *params = params_;
    __try { return create(target, list, kFeatureDlssNr, params, handle); }
    __except (EXCEPTION_EXECUTE_HANDLER) { *exception = GetExceptionCode(); return static_cast<NVSDK_NGX_Result>(0x7fffffff); }
}

NVSDK_NGX_Result Engine::SafeEvaluate(NVSDK_NGX_Handle *handle, unsigned long *exception)
{
    *exception = 0;
    auto evaluate = reinterpret_cast<NgxBridgeEvaluateFeature>(bridgeEvaluate_);
    auto target = reinterpret_cast<NgxEvaluateFeature>(nrEvaluate_);
    ID3D12GraphicsCommandList *list = lists_[1].Get();
    NVSDK_NGX_Parameter *params = params_;
    __try { return evaluate(target, list, handle, params, nullptr); }
    __except (EXCEPTION_EXECUTE_HANDLER) { *exception = GetExceptionCode(); return static_cast<NVSDK_NGX_Result>(0x7fffffff); }
}

bool Engine::CreateFeatures()
{
    for (int pass = 0; pass < look_.passes; ++pass)
    {
        SetCreateParams();
        if (!BeginList(1)) return false;
        unsigned long exception = 0;
        const double started = NowMs();
        const NVSDK_NGX_Result result = SafeCreate(&features_[pass], &exception);
        if (exception)
        {
            lists_[1]->Close();
            listOpen_[1] = false;
            EmitError("The neural rendering runtime crashed while creating its feature (exception " + Hex32(exception) + ").", true);
            return false;
        }
        if (!SubmitList(1, true)) return false;
        Log("CreateFeature(18) pass %d at %ux%u = %s (%s) in %.0f ms, handle %p", pass + 1, workWidth_, workHeight_,
            Hex32(result).c_str(), NgxResultName(result).c_str(), NowMs() - started, features_[pass]);
        if (NVSDK_NGX_FAILED(result) || !features_[pass])
        {
            features_[pass] = nullptr;
            if (pass == 0)
            {
                EmitError("The neural rendering feature could not be created at " + std::to_string(workWidth_) + "x" +
                    std::to_string(workHeight_) + " (" + NgxResultName(result) + ").", false);
                return false;
            }
            EmitWarning("Only " + std::to_string(pass) + " neural pass(es) could be created (" + NgxResultName(result) + "); continuing with those.");
            break;
        }
        featureCount_ = pass + 1;
    }
    JsonLine("feature").Int("width", workWidth_).Int("height", workHeight_).Int("passes", featureCount_)
        .Num("scalingRatio", scalingRatio_).Emit();
    return true;
}

void Engine::ReleaseFeatures()
{
    auto release = reinterpret_cast<NgxBridgeReleaseFeature>(bridgeRelease_);
    auto target = reinterpret_cast<NgxReleaseFeature>(nrRelease_);
    for (NVSDK_NGX_Handle *&feature : features_)
    {
        if (feature && release && target) release(target, feature);
        feature = nullptr;
    }
    featureCount_ = 0;
}

bool Engine::UploadSource(const unsigned char *pixels, int pitch)
{
    if (!upload_ || !pixels) return false;
    unsigned char *mapped = nullptr;
    if (FAILED(upload_->Map(0, nullptr, reinterpret_cast<void **>(&mapped)))) return false;
    const unsigned bytesPerPixel = sourceKind_ == SourceKind::ScRgb16 ? 8 : 4;
    const size_t rowBytes = static_cast<size_t>(width_) * bytesPerPixel;
    for (unsigned y = 0; y < height_; ++y)
        memcpy(mapped + uploadFootprint_.Offset + static_cast<size_t>(y) * uploadFootprint_.Footprint.RowPitch,
            pixels + static_cast<ptrdiff_t>(y) * pitch, rowBytes);
    upload_->Unmap(0, nullptr);
    return true;
}

bool Engine::Process(const FrameArgs &args, FrameStats *stats)
{
    const double started = NowMs();
    if (!ngxReady_ || !features_[0] || !output_) return false;
    const bool fullIsWork = !work_;
    Tex &workIn = fullIsWork ? full_ : work_;
    const bool hdr = outputKind_ == OutputKind::ScRgb16;
    heapCursor_ = 0;
    ++frameSerial_;

    // ---- list 0: source -> full picture -> working picture
    if (!BeginList(0)) return false;
    ID3D12GraphicsCommandList *list = lists_[0].Get();
    BindCompute(list);
    ID3D12Resource *source = args.externalSource ? args.externalSource : source_.res.Get();
    if (!args.externalSource)
    {
        Barrier(list, source_, D3D12_RESOURCE_STATE_COPY_DEST);
        D3D12_TEXTURE_COPY_LOCATION dst = {source_.res.Get(), D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
        dst.SubresourceIndex = 0;
        D3D12_TEXTURE_COPY_LOCATION src = {upload_.Get(), D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT};
        src.PlacedFootprint = uploadFootprint_;
        list->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
        Barrier(list, source_, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    }
    else Barrier(list, source, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    Barrier(list, full_, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    {
        struct { unsigned w, h, mode; float sdrScale, knee; } c = {width_, height_,
            sourceKind_ == SourceKind::ScRgb16 ? 2u : (sourceKind_ == SourceKind::Bgra8 ? 1u : 0u),
            std::max(args.sdrScale, 0.1f), 0.8f};
        Dispatch(list, psoIngest_.Get(), {{source}}, {{full_.res.Get()}}, &c, 5, Groups(width_), Groups(height_));
    }
    if (args.externalSource) Barrier(list, source, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_COMMON);
    if (!fullIsWork)
    {
        Barrier(list, full_, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        Barrier(list, work_, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        const unsigned taps = std::clamp(static_cast<unsigned>(std::ceil(std::max(double(width_) / workWidth_, double(height_) / workHeight_))), 1u, 8u);
        struct { unsigned dw, dh, sw, sh, taps; } c = {workWidth_, workHeight_, width_, height_, taps};
        Dispatch(list, psoDownscale_.Get(), {{full_.res.Get()}}, {{work_.res.Get()}}, &c, 5, Groups(workWidth_), Groups(workHeight_));
    }
    // The optical-flow preparation reads the working picture on the compute
    // queue, so it goes back to COMMON at the queue hand-off.
    Barrier(list, workIn, D3D12_RESOURCE_STATE_COMMON);
    if (!fullIsWork) Barrier(list, full_, D3D12_RESOURCE_STATE_COMMON);
    if (!SubmitList(0, false)) return false;

    // ---- optical flow (compute queue + NVOFA), current -> previous
    NvofMotionProvider::Submission flow;
    bool haveFlow = false;
    if (args.useMotion && nvof_ && nvof_->IsReady())
    {
        computeQueue_->Wait(fence_.Get(), listFence_[0]);
        if (nvof_->Submit(workIn.res.Get(), D3D12_RESOURCE_STATE_COMMON, frameSerial_, args.reset, flow) && flow.valid)
        {
            queue_->Wait(nvof_->CompletionFence(), flow.completion_value);
            haveFlow = true;
        }
    }

    // ---- list 1: flow conversion, NR passes, effect, composite, output
    if (!BeginList(1)) return false;
    list = lists_[1].Get();
    if (queries_) list->EndQuery(queries_.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 0);
    ID3D12Resource *motion = zeroMotion_.res.Get();
    ID3D12Resource *rejection = nullptr;
    if (haveFlow)
    {
        if (nvof_->RecordConversion(list, flow, 1.5f, 0.6f))
        {
            motion = flow.motion;
            rejection = flow.history_mask;
        }
        else haveFlow = false;
    }
    Barrier(list, workIn, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    Barrier(list, zeroMotion_, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    Barrier(list, flatDepth_, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    if (queries_) list->EndQuery(queries_.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 1);
    ID3D12Resource *nrMotion = (args.motionToNr && haveFlow) ? motion : zeroMotion_.res.Get();
    ID3D12Resource *color = workIn.res.Get();
    int lastPass = -1;
    for (int pass = 0; pass < featureCount_; ++pass)
    {
        Barrier(list, nrOut_[pass], D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
        SetEvalParams(color, nrOut_[pass].res.Get(), nrMotion, args.reset);
        unsigned long exception = 0;
        const NVSDK_NGX_Result result = SafeEvaluate(features_[pass], &exception);
        if (exception)
        {
            list->Close();
            listOpen_[1] = false;
            EmitError("The neural rendering runtime crashed while evaluating (exception " + Hex32(exception) + ").", true);
            ExitProcess(3);
        }
        if (NVSDK_NGX_FAILED(result))
        {
            Log("EvaluateFeature pass %d = %s (%s)", pass + 1, Hex32(result).c_str(), NgxResultName(result).c_str());
            if (pass == 0)
            {
                list->Close();
                listOpen_[1] = false;
                EmitError("Neural rendering failed on this frame (" + NgxResultName(result) + ").", false);
                return false;
            }
            break;
        }
        Barrier(list, nrOut_[pass], D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        color = nrOut_[pass].res.Get();
        lastPass = pass;
    }
    if (queries_) list->EndQuery(queries_.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 2);

    // NGX binds its own heaps and root signatures: ours go back on.
    BindCompute(list);
    Tex &effect = effect_[effectIndex_];
    Tex &history = effect_[effectIndex_ ^ 1];
    Barrier(list, effect, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    Barrier(list, history, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    Barrier(list, prevWork_, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    const bool stabilise = args.stabilize > 0.0f && haveFlow && historyValid_ && !args.reset;
    {
        struct { unsigned w, h, hasHistory, useRejection; float stabilize, margin, deadZone; } c = {
            workWidth_, workHeight_, stabilise ? 1u : 0u, rejection ? 1u : 0u, args.stabilize, 0.02f, 0.5f};
        DXGI_FORMAT rejectionFormat = rejection ? rejection->GetDesc().Format : DXGI_FORMAT_R16_FLOAT;
        Dispatch(list, psoEffect_.Get(),
            {{workIn.res.Get()}, {nrOut_[lastPass].res.Get()}, {prevWork_.res.Get()}, {history.res.Get()},
             {motion, motion->GetDesc().Format}, {rejection, rejectionFormat}},
            {{effect.res.Get()}}, &c, 7, Groups(workWidth_), Groups(workHeight_));
    }
    Barrier(list, effect, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    // Remember this frame's working picture for the next frame's reprojection check.
    Barrier(list, prevWork_, D3D12_RESOURCE_STATE_COPY_DEST);
    Barrier(list, workIn, D3D12_RESOURCE_STATE_COPY_SOURCE);
    list->CopyResource(prevWork_.res.Get(), workIn.res.Get());
    Barrier(list, prevWork_, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    Barrier(list, full_, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    Barrier(list, output_, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    if (hdr)
    {
        if (args.externalSource) Barrier(list, args.externalSource, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
        else Barrier(list, source_, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    }
    {
        const unsigned mode = hdr ? 2u : (outputKind_ == OutputKind::Bgra8 ? 1u : 0u);
        struct { unsigned w, h, mode, fullRes; float mix, sdrScale, hdrLimit; unsigned splitX, marker; } c = {
            width_, height_, mode, fullIsWork ? 1u : 0u, args.mix, std::max(args.sdrScale, 0.1f), 0.25f,
            std::min(args.splitX, width_), std::min(args.marker, std::min(width_, height_))};
        ID3D12Resource *original = hdr ? (args.externalSource ? args.externalSource : source_.res.Get()) : nullptr;
        Dispatch(list, psoComposite_.Get(), {{full_.res.Get()}, {effect.res.Get()}, {original}},
            {{output_.res.Get()}}, &c, 9, Groups(width_), Groups(height_));
    }
    if (hdr && args.externalSource) Barrier(list, args.externalSource, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_COMMON);
    Barrier(list, workIn, D3D12_RESOURCE_STATE_COMMON);
    Barrier(list, full_, D3D12_RESOURCE_STATE_COMMON);

    if (args.presentTarget)
    {
        Barrier(list, output_, D3D12_RESOURCE_STATE_COPY_SOURCE);
        Barrier(list, args.presentTarget, D3D12_RESOURCE_STATE_PRESENT, D3D12_RESOURCE_STATE_COPY_DEST);
        list->CopyResource(args.presentTarget, output_.res.Get());
        Barrier(list, args.presentTarget, D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_PRESENT);
    }
    if (args.readback)
    {
        Barrier(list, output_, D3D12_RESOURCE_STATE_COPY_SOURCE);
        D3D12_TEXTURE_COPY_LOCATION dst = {readback_.Get(), D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT};
        dst.PlacedFootprint = readbackFootprint_;
        D3D12_TEXTURE_COPY_LOCATION src = {output_.res.Get(), D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
        src.SubresourceIndex = 0;
        list->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    }
    if (queries_)
    {
        list->EndQuery(queries_.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 3);
        list->ResolveQueryData(queries_.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 0, 4, queryReadback_.Get(), 0);
    }
    if (!SubmitList(1, true)) return false;
    if (haveFlow) nvof_->MarkNeuralUse(flow, listFence_[1]);

    // This frame's effect is the next frame's history whatever happened here;
    // whether it gets used depends on the next frame having flow back to this one.
    historyValid_ = true;
    effectIndex_ ^= 1;

    if (stats)
    {
        stats->cpuMs = NowMs() - started;
        stats->motionUsed = haveFlow;
        if (queries_ && timestampFrequency_ > 0.0)
        {
            UINT64 *stamps = nullptr;
            D3D12_RANGE range = {0, 4 * sizeof(UINT64)};
            if (SUCCEEDED(queryReadback_->Map(0, &range, reinterpret_cast<void **>(&stamps))))
            {
                stats->nrMs = static_cast<double>(stamps[2] - stamps[1]) * 1000.0 / timestampFrequency_;
                stats->gpuMs = static_cast<double>(stamps[3] - stamps[0]) * 1000.0 / timestampFrequency_;
                D3D12_RANGE none = {0, 0};
                queryReadback_->Unmap(0, &none);
            }
        }
    }
    return true;
}

bool Engine::ReadResult(unsigned char *dst, int pitch)
{
    if (!readback_ || !dst) return false;
    unsigned char *mapped = nullptr;
    D3D12_RANGE range = {0, static_cast<SIZE_T>(readbackFootprint_.Offset + static_cast<UINT64>(readbackFootprint_.Footprint.RowPitch) * height_)};
    if (FAILED(readback_->Map(0, &range, reinterpret_cast<void **>(&mapped)))) return false;
    const unsigned bytesPerPixel = outputKind_ == OutputKind::ScRgb16 ? 8 : 4;
    const size_t rowBytes = static_cast<size_t>(width_) * bytesPerPixel;
    for (unsigned y = 0; y < height_; ++y)
        memcpy(dst + static_cast<ptrdiff_t>(y) * pitch,
            mapped + readbackFootprint_.Offset + static_cast<size_t>(y) * readbackFootprint_.Footprint.RowPitch, rowBytes);
    D3D12_RANGE none = {0, 0};
    readback_->Unmap(0, &none);
    return true;
}
} // namespace dm
