// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - the neural rendering engine. Apache-2.0.
//
// One D3D12 device on the NVIDIA adapter, NVIDIA's DLSS 5 neural rendering
// runtime reached exactly the way the standalone add-on reaches it (the
// snippet's own exports, called through our nvngx.dll bridge so the snippet's
// caller check passes), and a small compute pipeline around it:
//
//   source -> ingest (RGBA8 display-referred picture; HDR becomes an SDR proxy)
//          -> optional downscale to the working size
//          -> NR pass 1..3 (one NGX feature per pass)
//          -> effect = NR out - NR in   (optionally stabilised over time with
//             optical-flow-warped history, the anti-shimmer step for video)
//          -> composite: picture + mix * effect (upsampled when the working
//             size is smaller), back in the output's colour space
//
// Nothing here ships or modifies an NVIDIA file: the runtime is the user's own
// nvngx_dlssnr.dll, hash-checked by the installer before we are started.
#pragma once

#include "common.h"

#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <memory>

#include "nvsdk_ngx.h"
#include "nvsdk_ngx_defs.h"
#include "nvsdk_ngx_params.h"

class NvofMotionProvider;

namespace dm
{
using Microsoft::WRL::ComPtr;

struct NrLook
{
    int style = 0;            // DLSSNR.Style: 0 default, 1 natural, 2 cinematic
    float intensity = 1.0f;   // 0..1 (the runtime clamps higher values to 1)
    float tone = 1.0f;        // LocalToneStrength 0..2
    float structure = 1.0f;   // LocalStructureStrength 0..2
    float skin = -1.0f;       // SkinStructureStrength: -1 follows structure, 0..0.99
    bool autoMask = true;     // UseAutoMask (the automatic skin mask)
    int passes = 1;           // 1..3, each pass its own feature

    bool SameFeature(const NrLook &other) const
    {
        return style == other.style && intensity == other.intensity && tone == other.tone &&
            structure == other.structure && skin == other.skin && autoMask == other.autoMask;
    }
};

enum class SourceKind { Rgba8, Bgra8, ScRgb16 };
enum class OutputKind { Rgba8, Bgra8, ScRgb16 };

struct FrameArgs
{
    bool reset = true;           // start NR history (and stabiliser history) over
    float mix = 1.0f;            // how much of the effect to apply, 0..1
    float stabilize = 0.0f;      // 0 off .. 1 strongest (needs motion)
    bool useMotion = false;      // optical flow for this frame (video / desktop)
    bool motionToNr = false;     // also hand the flow to NR itself
    float sdrScale = 1.0f;       // HDR: scRGB value of SDR white (nits / 80)
    ID3D12Resource *externalSource = nullptr;   // desktop: shared texture, COMMON
    ID3D12Resource *presentTarget = nullptr;    // desktop: swap-chain buffer, PRESENT
    bool readback = false;       // copy the result to the CPU (pictures / video)
    unsigned splitX = 0;         // > 0: columns left of this stay original (before / after)
    unsigned marker = 0;         // > 0: magenta square of this size, top left (overlay self-test)
};

struct FrameStats
{
    double nrMs = 0.0;           // GPU time of the NR passes
    double gpuMs = 0.0;          // GPU time of the whole frame
    double cpuMs = 0.0;          // wall time of Process()
    bool motionUsed = false;
};

struct EngineInfo
{
    std::wstring adapter;
    unsigned long long vramBytes = 0;
    std::string driver;
    LUID luid = {};
    unsigned vendor = 0;
};

class Engine
{
public:
    Engine();
    ~Engine();

    bool Initialize(const std::wstring &nrPath, const std::wstring &bridgePath, int adapterIndex);
    const EngineInfo &Info() const { return info_; }

    ID3D12Device *Device() const { return device_.Get(); }
    ID3D12CommandQueue *Queue() const { return queue_.Get(); }
    IDXGIFactory4 *Factory() const { return factory_.Get(); }
    IDXGIAdapter1 *Adapter() const { return adapter_.Get(); }

    // (Re)build everything that depends on the frame size, the working size or
    // the look. Cheap when nothing changed. maxWorkPixels 0 = always full size.
    bool Configure(unsigned width, unsigned height, SourceKind source, OutputKind output,
        unsigned long long maxWorkPixels, const NrLook &look, bool wantMotion);

    unsigned Width() const { return width_; }
    unsigned Height() const { return height_; }
    unsigned WorkWidth() const { return workWidth_; }
    unsigned WorkHeight() const { return workHeight_; }
    bool MotionReady() const;

    // CPU frames (pictures, video): 4 bytes per pixel in the source layout.
    bool UploadSource(const unsigned char *pixels, int pitch);
    bool Process(const FrameArgs &args, FrameStats *stats);
    // After Process(readback=true): copy the result into dst, 4 bytes/pixel
    // (8 for ScRgb16), top-down.
    bool ReadResult(unsigned char *dst, int pitch);

    // Idle the GPU (before releasing anything the GPU may still use).
    void WaitIdle();

private:
    struct Tex
    {
        ComPtr<ID3D12Resource> res;
        D3D12_RESOURCE_STATES state = D3D12_RESOURCE_STATE_COMMON;
        DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
        unsigned width = 0, height = 0;
        explicit operator bool() const { return res != nullptr; }
    };

    bool CreateDevice(int adapterIndex);
    bool CreatePipelines();
    bool InitializeNgx(const std::wstring &nrPath, const std::wstring &bridgePath);
    HMODULE LoadNgxCore();
    bool CreateTex(unsigned w, unsigned h, DXGI_FORMAT format, bool uav, Tex &out, const wchar_t *name);
    bool FillTex(Tex &tex, const void *pixel, unsigned bytesPerPixel);
    void Barrier(ID3D12GraphicsCommandList *list, Tex &tex, D3D12_RESOURCE_STATES to);
    void Barrier(ID3D12GraphicsCommandList *list, ID3D12Resource *res, D3D12_RESOURCE_STATES from, D3D12_RESOURCE_STATES to);
    bool BeginList(int which);
    bool SubmitList(int which, bool waitCpu);
    UINT64 Signal();
    void WaitFence(UINT64 value);

    // Compute dispatch helper: up to 6 SRVs, 3 UAVs, 12 root constants.
    struct View { ID3D12Resource *res = nullptr; DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN; };
    void Dispatch(ID3D12GraphicsCommandList *list, ID3D12PipelineState *pso,
        std::initializer_list<View> srvs, std::initializer_list<View> uavs,
        const void *constants, unsigned constantCount, unsigned groupsX, unsigned groupsY);
    void BindCompute(ID3D12GraphicsCommandList *list);

    bool CreateFeatures();
    void ReleaseFeatures();
    void SetCreateParams();
    void SetEvalParams(ID3D12Resource *color, ID3D12Resource *output, ID3D12Resource *motion, bool reset);
    NVSDK_NGX_Result SafeCreate(NVSDK_NGX_Handle **handle, unsigned long *exception);
    NVSDK_NGX_Result SafeEvaluate(NVSDK_NGX_Handle *handle, unsigned long *exception);

    EngineInfo info_;
    ComPtr<IDXGIFactory4> factory_;
    ComPtr<IDXGIAdapter1> adapter_;
    ComPtr<ID3D12Device> device_;
    ComPtr<ID3D12CommandQueue> queue_;          // direct: everything we record
    ComPtr<ID3D12CommandQueue> computeQueue_;   // optical-flow preparation only
    ComPtr<ID3D12Fence> fence_;
    UINT64 fenceValue_ = 0;
    HANDLE fenceEvent_ = nullptr;
    ComPtr<ID3D12Fence> computeFence_;
    ComPtr<ID3D12CommandAllocator> allocators_[2];
    ComPtr<ID3D12GraphicsCommandList> lists_[2];
    UINT64 listFence_[2] = {0, 0};
    bool listOpen_[2] = {false, false};

    ComPtr<ID3D12RootSignature> root_;
    ComPtr<ID3D12PipelineState> psoIngest_, psoDownscale_, psoEffect_, psoComposite_;
    ComPtr<ID3D12DescriptorHeap> heap_;
    unsigned heapStride_ = 0, heapCursor_ = 0;
    static constexpr unsigned kHeapSize = 2048;

    ComPtr<ID3D12QueryHeap> queries_;
    ComPtr<ID3D12Resource> queryReadback_;
    double timestampFrequency_ = 0.0;

    // Frame-size resources
    unsigned width_ = 0, height_ = 0, workWidth_ = 0, workHeight_ = 0;
    SourceKind sourceKind_ = SourceKind::Rgba8;
    OutputKind outputKind_ = OutputKind::Rgba8;
    Tex source_, full_, work_, nrOut_[3], effect_[2], prevWork_, zeroMotion_, flatDepth_, output_;
    int effectIndex_ = 0;
    bool historyValid_ = false;
    ComPtr<ID3D12Resource> upload_, readback_;
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT uploadFootprint_ = {}, readbackFootprint_ = {};
    unsigned long long frameSerial_ = 0;

    // Optical flow (current -> previous, pixels at the working size)
    std::unique_ptr<NvofMotionProvider> nvof_;
    bool wantMotion_ = false;

    // NGX
    HMODULE coreModule_ = nullptr, nrModule_ = nullptr, bridgeModule_ = nullptr;
    void *nrCreate_ = nullptr, *nrEvaluate_ = nullptr, *nrRelease_ = nullptr, *nrPopulate_ = nullptr;
    void *bridgeCreate_ = nullptr, *bridgeEvaluate_ = nullptr, *bridgeRelease_ = nullptr, *bridgePopulate_ = nullptr;
    NVSDK_NGX_Parameter *params_ = nullptr;
    void *scalingCallback_ = nullptr;
    NVSDK_NGX_Handle *features_[3] = {nullptr, nullptr, nullptr};
    NrLook look_;
    NrLook featureLook_;
    unsigned featureWidth_ = 0, featureHeight_ = 0;
    int featureCount_ = 0;
    int requestedPasses_ = 0;
    float scalingRatio_ = 1.0f;
    bool ngxReady_ = false;
};

std::string NgxResultName(unsigned long result);
} // namespace dm
