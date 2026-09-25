// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - compute shaders (compiled at start-up with D3DCompile). Apache-2.0.
//
// One root signature for all of them: t0..t5 SRV table, u0..u2 UAV table,
// b0 = 12 root constants, s0 linear clamp, s1 point clamp.
#pragma once

namespace dm
{
static const char kShaderCommon[] = R"HLSL(
SamplerState Linear : register(s0);
SamplerState Point : register(s1);
float3 SrgbEncode(float3 x)
{
    x = saturate(x);
    float3 lo = x * 12.92;
    float3 hi = 1.055 * pow(max(x, 1e-8), 1.0 / 2.4) - 0.055;
    return x <= 0.0031308 ? lo : hi;
}
float3 SrgbDecode(float3 x)
{
    x = saturate(x);
    float3 lo = x / 12.92;
    float3 hi = pow((x + 0.055) / 1.055, 2.4);
    return x <= 0.04045 ? lo : hi;
}
float Luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }
)HLSL";

// Source (RGBA8 / BGRA8 view / scRGB FP16) -> display-referred RGBA8 picture.
// Mode 0 keeps alpha, 1 forces it opaque, 2 turns scRGB into an SDR proxy:
// SDR white at 1.0, highlights rolled off above Knee, sRGB-encoded.
static const char kShaderIngest[] = R"HLSL(
Texture2D<float4> Src : register(t0);
RWTexture2D<unorm float4> Dst : register(u0);
cbuffer C : register(b0) { uint Width; uint Height; uint Mode; float SdrScale; float Knee; float P0; float P1; float P2; float P3; float P4; float P5; float P6; };
[numthreads(8, 8, 1)] void CS(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= Width || id.y >= Height) return;
    float4 c = Src.Load(int3(id.xy, 0));
    if (Mode == 1) c.a = 1.0;
    else if (Mode == 2)
    {
        float3 lin = max(c.rgb, 0.0) / max(SdrScale, 0.01);
        float range = max(1.0 - Knee, 0.01);
        float3 over = max(lin - Knee, 0.0);
        float3 rolled = Knee + range * (1.0 - exp(-over / range));
        lin = lin > Knee ? rolled : lin;
        c = float4(SrgbEncode(lin), 1.0);
    }
    Dst[id.xy] = saturate(c);
}
)HLSL";

// Area-averaging downscale to the working size (bilinear taps over each
// destination pixel's footprint), in the display-referred domain NR sees.
static const char kShaderDownscale[] = R"HLSL(
Texture2D<float4> Src : register(t0);
RWTexture2D<unorm float4> Dst : register(u0);
cbuffer C : register(b0) { uint DstW; uint DstH; uint SrcW; uint SrcH; uint Taps; uint P0; uint P1; uint P2; uint P3; uint P4; uint P5; uint P6; };
[numthreads(8, 8, 1)] void CS(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= DstW || id.y >= DstH) return;
    float2 src = float2(SrcW, SrcH);
    float2 scale = src / float2(DstW, DstH);
    float2 origin = float2(id.xy) * scale;
    float4 acc = 0;
    uint taps = clamp(Taps, 1u, 8u);
    for (uint j = 0; j < taps; j++)
        for (uint i = 0; i < taps; i++)
        {
            float2 p = origin + (float2(i, j) + 0.5) * scale / taps;
            acc += Src.SampleLevel(Linear, p / src, 0);
        }
    Dst[id.xy] = saturate(acc / (taps * taps));
}
)HLSL";

// Effect = NR out - NR in, at the working size. With history and motion it is
// stabilised: the previous frame's effect is warped along the optical flow
// (current -> previous), clamped to this frame's 3x3 effect range, and blended
// in where the flow is trustworthy. The picture itself is never delayed - only
// the change NR makes to it is smoothed, which is what stops grain shimmer.
static const char kShaderEffect[] = R"HLSL(
Texture2D<float4> NrIn : register(t0);
Texture2D<float4> NrOut : register(t1);
Texture2D<float4> PrevIn : register(t2);
Texture2D<float4> History : register(t3);
Texture2D<float2> Motion : register(t4);
Texture2D<float> Rejection : register(t5);
RWTexture2D<float4> Effect : register(u0);
cbuffer C : register(b0) { uint W; uint H; uint HasHistory; uint UseRejection; float Stabilize; float Margin; float DeadZone; float P0; float P1; float P2; float P3; float P4; };
[numthreads(8, 8, 1)] void CS(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= W || id.y >= H) return;
    int2 p = int2(id.xy);
    float3 e = NrOut.Load(int3(p, 0)).rgb - NrIn.Load(int3(p, 0)).rgb;
    if (HasHistory == 0 || Stabilize <= 0.0)
    {
        Effect[id.xy] = float4(e, 0);
        return;
    }
    float2 mv = Motion.Load(int3(p, 0));
    if (dot(mv, mv) < DeadZone * DeadZone) mv = 0;
    float2 size = float2(W, H);
    float2 prevPos = float2(p) + 0.5 + mv;
    float inside = (all(prevPos >= 0.0) && all(prevPos <= size)) ? 1.0 : 0.0;
    float3 emin = e, emax = e;
    [unroll] for (int y = -1; y <= 1; y++)
        [unroll] for (int x = -1; x <= 1; x++)
        {
            int2 q = clamp(p + int2(x, y), int2(0, 0), int2(W - 1, H - 1));
            float3 n = NrOut.Load(int3(q, 0)).rgb - NrIn.Load(int3(q, 0)).rgb;
            emin = min(emin, n);
            emax = max(emax, n);
        }
    float2 uv = prevPos / size;
    float3 h = History.SampleLevel(Linear, uv, 0).rgb;
    h = clamp(h, emin - Margin, emax + Margin);
    float reproj = abs(Luma(NrIn.Load(int3(p, 0)).rgb) - Luma(PrevIn.SampleLevel(Linear, uv, 0).rgb));
    float trust = inside * (1.0 - smoothstep(0.03, 0.06, reproj));
    if (UseRejection != 0) trust *= 1.0 - saturate(Rejection.Load(int3(p, 0)));
    float wcur = lerp(1.0, 1.0 - 0.75 * saturate(Stabilize), trust);
    Effect[id.xy] = float4(lerp(h, e, wcur), 0);
}
)HLSL";

// Picture + mix * effect, the effect upsampled when the working size is
// smaller. One limit t is shared by R, G and B so the result stays inside
// 0..1 without bending the hue of the change. Mode 0 writes RGBA, 1 writes
// BGRA byte order (for Media Foundation's RGB32), 2 applies the change to the
// scRGB original as a bounded linear delta (HDR desktop).
static const char kShaderComposite[] = R"HLSL(
Texture2D<float4> Base : register(t0);
Texture2D<float4> EffectTex : register(t1);
Texture2D<float4> Original : register(t2);
RWTexture2D<float4> Out : register(u0);
// SplitX > 0: columns left of it stay original (before/after view) with a thin
// divider on the line. Marker > 0: a Marker x Marker magenta square in the top
// left corner (the desktop overlay's is-it-on-screen self-test).
cbuffer C : register(b0) { uint W; uint H; uint Mode; uint FullRes; float Mix; float SdrScale; float HdrLimit; uint SplitX; uint Marker; float P2; float P3; float P4; };
[numthreads(8, 8, 1)] void CS(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= W || id.y >= H) return;
    const bool marker = Marker > 0 && id.x < Marker && id.y < Marker;
    const bool divider = SplitX > 0 && (id.x == SplitX || id.x + 1 == SplitX);
    if (marker || divider)
    {
        const float3 c = marker ? float3(1.0, 0.0, 1.0) : float3(0.85, 0.85, 0.85);
        const float s = Mode == 2 ? max(SdrScale, 0.1) : 1.0;
        Out[id.xy] = Mode == 1 ? float4(c.b, c.g, c.r, 1.0) * float4(s, s, s, 1.0) : float4(c * s, 1.0);
        return;
    }
    float4 base = Base.Load(int3(id.xy, 0));
    float3 e;
    if (FullRes != 0) e = EffectTex.Load(int3(id.xy, 0)).rgb;
    else e = EffectTex.SampleLevel(Linear, (float2(id.xy) + 0.5) / float2(W, H), 0).rgb;
    e *= (SplitX > 0 && id.x < SplitX) ? 0.0 : saturate(Mix);
    float t = 1.0;
    [unroll] for (int k = 0; k < 3; k++)
    {
        if (e[k] > 1e-6) t = min(t, (1.0 - base[k]) / e[k]);
        else if (e[k] < -1e-6) t = min(t, (0.0 - base[k]) / e[k]);
    }
    t = saturate(t);
    float3 sdr = saturate(base.rgb + t * e);
    if (Mode == 2)
    {
        float4 orig = Original.Load(int3(id.xy, 0));
        float3 d = SrgbDecode(sdr) - SrgbDecode(base.rgb);
        d = clamp(d, -HdrLimit, HdrLimit) * SdrScale;
        Out[id.xy] = float4(orig.rgb + d, 1.0);
    }
    else if (Mode == 1) Out[id.xy] = float4(sdr.b, sdr.g, sdr.r, base.a);
    else Out[id.xy] = float4(sdr, base.a);
}
)HLSL";
} // namespace dm
