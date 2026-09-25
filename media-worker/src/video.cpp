// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - videos through Media Foundation. Apache-2.0.
//
// Decode with the Source Reader (Windows' own decoders; advanced video
// processing converts to RGB32 with the file's colour matrix), run each frame
// through NR with NVIDIA Optical Flow motion and the effect stabiliser, and
// encode with the Sink Writer (NVENC when the driver offers it) into MP4.
// Audio is copied untouched when it is AAC, otherwise re-encoded to AAC.
// Timestamps and durations are carried over frame by frame, so variable frame
// rate footage keeps its timing.
#include "jobs.h"

#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <mfreadwrite.h>
#include <propvarutil.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace dm
{
namespace
{
// Declared locally so the build does not depend on which of these the
// toolchain's libmfuuid happens to define.
const GUID kTranscodeContainerType = {0x150ff23f, 0x4abc, 0x478b, {0xac, 0x4f, 0xe1, 0x91, 0x6f, 0xba, 0x1c, 0xca}};
const GUID kContainerMpeg4 = {0xdc6cd05d, 0xb9d0, 0x40ef, {0xbd, 0x35, 0xfa, 0x62, 0x2c, 0x1a, 0xb2, 0x8a}};
const GUID kVideoRotation = {0xc380465d, 0x2271, 0x428c, {0x9b, 0x83, 0xec, 0xea, 0x3b, 0x4a, 0x85, 0xc1}};
// CODECAPI_AVEncMPVDefaultBPictureCount / CODECAPI_AVEncMPVGOPSize (codecapi.h).
const GUID kCodecApiBPictureCount = {0x8d390aac, 0xdc5c, 0x4200, {0xb5, 0x7f, 0x81, 0x4d, 0x04, 0xba, 0xba, 0xb2}};
const GUID kCodecApiGopSize = {0x95f31b26, 0x95a4, 0x41aa, {0x93, 0x03, 0x24, 0x6a, 0x7f, 0xc6, 0xee, 0xf1}};

struct MfSession
{
    bool ok = false;
    MfSession() { ok = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_FULL)); }
    ~MfSession() { if (ok) MFShutdown(); }
};

struct Streams
{
    DWORD video = MAXDWORD;
    DWORD audio = MAXDWORD;
};

Streams FindStreams(IMFSourceReader *reader)
{
    Streams streams;
    for (DWORD index = 0;; ++index)
    {
        ComPtr<IMFMediaType> type;
        const HRESULT hr = reader->GetNativeMediaType(index, 0, &type);
        if (hr == MF_E_INVALIDSTREAMNUMBER) break;
        if (FAILED(hr)) continue;
        GUID major = {};
        type->GetGUID(MF_MT_MAJOR_TYPE, &major);
        if (major == MFMediaType_Video && streams.video == MAXDWORD) streams.video = index;
        else if (major == MFMediaType_Audio && streams.audio == MAXDWORD) streams.audio = index;
        if (index > 64) break;
    }
    return streams;
}

UINT32 Bitrate(unsigned w, unsigned h, double fps, const std::string &quality)
{
    const double bitsPerPixel = quality == "max" ? 0.32 : quality == "standard" ? 0.12 : 0.20;
    const double bits = static_cast<double>(w) * h * std::max(fps, 1.0) * bitsPerPixel;
    return static_cast<UINT32>(std::clamp(bits, 2.0e6, 150.0e6));
}

// Mean absolute luma change on a coarse grid of a BGRA frame, 0..1.
double LumaChange(const unsigned char *frame, int pitch, unsigned w, unsigned h, std::vector<float> &previous)
{
    const unsigned gx = 64, gy = 36;
    std::vector<float> current(gx * gy);
    for (unsigned y = 0; y < gy; ++y)
    {
        const unsigned sy = std::min(h - 1, (y * h + h / 2) / gy);
        const unsigned char *row = frame + static_cast<ptrdiff_t>(sy) * pitch;
        for (unsigned x = 0; x < gx; ++x)
        {
            const unsigned sx = std::min(w - 1, (x * w + w / 2) / gx);
            const unsigned char *p = row + sx * 4;
            current[y * gx + x] = (0.0722f * p[0] + 0.7152f * p[1] + 0.2126f * p[2]) / 255.0f;
        }
    }
    double change = previous.empty() ? 1.0 : 0.0;
    if (!previous.empty())
    {
        for (size_t i = 0; i < current.size(); ++i) change += std::fabs(current[i] - previous[i]);
        change /= current.size();
    }
    previous.swap(current);
    return change;
}

std::string CodecHint(HRESULT hr)
{
    if (hr == MF_E_TOPO_CODEC_NOT_FOUND || hr == MF_E_INVALIDMEDIATYPE || hr == MF_E_UNSUPPORTED_D3D_TYPE)
        return " Windows has no decoder for this video's codec - HEVC needs 'HEVC Video Extensions' and AV1 needs 'AV1 Video Extension' from the Microsoft Store.";
    return "";
}

// How the audio track goes into the output, in order of preference.
enum class AudioPlan { Copy, Aac, None };

// Adds the audio stream to a fresh writer for one plan. A refused plan leaves
// the writer unusable (a stream may already be added), so the caller builds a
// new writer for the next plan.
bool AddAudio(IMFSourceReader *reader, IMFSinkWriter *writer, DWORD audioIndex, AudioPlan plan,
    DWORD &audioStream, std::string &how)
{
    audioStream = MAXDWORD;
    if (plan == AudioPlan::None || audioIndex == MAXDWORD)
    {
        if (audioIndex != MAXDWORD) reader->SetStreamSelection(audioIndex, FALSE);
        how = audioIndex == MAXDWORD ? "no audio track" : "no audio";
        return true;
    }
    ComPtr<IMFMediaType> native;
    if (FAILED(reader->GetNativeMediaType(audioIndex, 0, &native))) return false;
    GUID subtype = {};
    native->GetGUID(MF_MT_SUBTYPE, &subtype);
    if (plan == AudioPlan::Copy)
    {
        if (subtype != MFAudioFormat_AAC) return false;
        ComPtr<IMFMediaType> copy;
        MFCreateMediaType(&copy);
        native->CopyAllItems(copy.Get());
        if (FAILED(reader->SetCurrentMediaType(audioIndex, nullptr, native.Get())) ||
            FAILED(writer->AddStream(copy.Get(), &audioStream)) ||
            FAILED(writer->SetInputMediaType(audioStream, copy.Get(), nullptr)))
        { audioStream = MAXDWORD; return false; }
        reader->SetStreamSelection(audioIndex, TRUE);
        how = "AAC audio copied unchanged";
        return true;
    }
    UINT32 rate = MFGetAttributeUINT32(native.Get(), MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000);
    UINT32 channels = MFGetAttributeUINT32(native.Get(), MF_MT_AUDIO_NUM_CHANNELS, 2);
    if (rate != 44100 && rate != 48000) rate = 48000;
    if (channels != 1 && channels != 2 && channels != 6) channels = 2;
    ComPtr<IMFMediaType> pcm;
    MFCreateMediaType(&pcm);
    pcm->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    pcm->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    pcm->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    pcm->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate);
    pcm->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels);
    pcm->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, channels * 2);
    pcm->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * channels * 2);
    pcm->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    if (FAILED(reader->SetCurrentMediaType(audioIndex, nullptr, pcm.Get())))
    {
        // Let the reader resample to the one layout the AAC encoder always takes.
        rate = 48000; channels = 2;
        pcm->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate);
        pcm->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels);
        pcm->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, channels * 2);
        pcm->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * channels * 2);
        if (FAILED(reader->SetCurrentMediaType(audioIndex, nullptr, pcm.Get()))) return false;
    }
    ComPtr<IMFMediaType> aac;
    MFCreateMediaType(&aac);
    aac->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    aac->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
    aac->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    aac->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate);
    aac->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels);
    aac->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);   // 192 kbit/s
    if (FAILED(writer->AddStream(aac.Get(), &audioStream)) || FAILED(writer->SetInputMediaType(audioStream, pcm.Get(), nullptr)))
    { audioStream = MAXDWORD; return false; }
    reader->SetStreamSelection(audioIndex, TRUE);
    how = "audio re-encoded to AAC 192 kbit/s (" + std::to_string(rate) + " Hz, " + std::to_string(channels) + " ch)";
    return true;
}

bool ProcessOne(Engine *engine, const JobItem &item, size_t index, const Settings &settings)
{
    auto fail = [&](const std::string &message)
    {
        JsonLine("file-error").Int("index", static_cast<long long>(index)).WStr("input", item.input).Str("message", message).Emit();
        return false;
    };
    const double started = NowMs();

    ComPtr<IMFAttributes> readerAttributes;
    MFCreateAttributes(&readerAttributes, 2);
    readerAttributes->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);
    ComPtr<IMFSourceReader> reader;
    HRESULT hr = MFCreateSourceReaderFromURL(item.input.c_str(), readerAttributes.Get(), &reader);
    if (FAILED(hr)) return fail("the video could not be opened (" + Hex32(hr) + ")." + CodecHint(hr));
    const Streams streams = FindStreams(reader.Get());
    if (streams.video == MAXDWORD) return fail("the file has no video track");
    reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);

    ComPtr<IMFMediaType> nativeVideo;
    reader->GetNativeMediaType(streams.video, 0, &nativeVideo);
    const UINT32 transfer = nativeVideo ? MFGetAttributeUINT32(nativeVideo.Get(), MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_Unknown) : 0;
    const bool hdr = transfer == MFVideoTransFunc_2084 || transfer == MFVideoTransFunc_HLG;
    const UINT32 rotation = nativeVideo ? MFGetAttributeUINT32(nativeVideo.Get(), kVideoRotation, 0) : 0;

    ComPtr<IMFMediaType> want;
    MFCreateMediaType(&want);
    want->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    want->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    hr = reader->SetCurrentMediaType(streams.video, nullptr, want.Get());
    if (FAILED(hr)) return fail("this video cannot be decoded to RGB (" + Hex32(hr) + ")." + CodecHint(hr));
    reader->SetStreamSelection(streams.video, TRUE);
    ComPtr<IMFMediaType> current;
    reader->GetCurrentMediaType(streams.video, &current);
    UINT32 width = 0, height = 0, rateNum = 30, rateDen = 1, parNum = 1, parDen = 1;
    MFGetAttributeSize(current.Get(), MF_MT_FRAME_SIZE, &width, &height);
    if (FAILED(MFGetAttributeRatio(current.Get(), MF_MT_FRAME_RATE, &rateNum, &rateDen)) || rateNum == 0 || rateDen == 0) { rateNum = 30; rateDen = 1; }
    if (FAILED(MFGetAttributeRatio(current.Get(), MF_MT_PIXEL_ASPECT_RATIO, &parNum, &parDen)) || parNum == 0 || parDen == 0) { parNum = parDen = 1; }
    if (width < 64 || height < 64) return fail("the video is smaller than 64x64");
    const double fps = static_cast<double>(rateNum) / rateDen;
    // 4:2:0 encoders need even sizes: an odd last row/column is left out.
    const UINT32 encWidth = width & ~1u, encHeight = height & ~1u;

    PROPVARIANT durationValue;
    PropVariantInit(&durationValue);
    LONGLONG duration = 0;
    if (SUCCEEDED(reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &durationValue)))
        duration = static_cast<LONGLONG>(durationValue.uhVal.QuadPart);
    PropVariantClear(&durationValue);
    const long long estimatedFrames = duration > 0 ? static_cast<long long>(duration / 1e7 * fps + 0.5) : 0;

    if (engine && !engine->Configure(width, height, SourceKind::Bgra8, OutputKind::Bgra8, settings.maxWorkPixels, settings.look,
            settings.stabilize > 0.0f || settings.motionToNr))
        return fail("neural rendering could not be set up for " + std::to_string(width) + "x" + std::to_string(height));

    // Output: written under a temporary name and moved into place when done.
    // Each (codec, audio plan) combination gets a fresh writer; the first one
    // every part of which is accepted is used.
    const std::wstring partial = item.output + L".partial.mp4";
    DeleteFileW(partial.c_str());
    EnsureDirectory(DirectoryOf(item.output));
    std::vector<std::string> codecs = {settings.codec == "hevc" ? "hevc" : "h264"};
    if (codecs[0] == "hevc") codecs.push_back("h264");
    std::vector<AudioPlan> plans;
    if (settings.audio == "copy") plans = {AudioPlan::Copy, AudioPlan::Aac, AudioPlan::None};
    else if (settings.audio == "aac") plans = {AudioPlan::Aac, AudioPlan::None};
    else plans = {AudioPlan::None};
    ComPtr<IMFSinkWriter> writer;
    DWORD videoStream = 0, audioStream = MAXDWORD;
    std::string codec, audioHow, videoError;
    bool opened = false, plainEncoder = false;
    // Opens a writer for one codec and audio plan. "extras" asks the encoder
    // for no B-frames (so the first frame shows at 0:00 - MP4s from Media
    // Foundation carry no edit list to hide B-frame delay, which would put
    // the picture ~67 ms behind the sound) and a 2-second GOP, and tags the
    // stream BT.709 / limited range so players and the colour converter agree.
    // Returns 0 opened, 1 video refused, 2 audio refused, 3 BeginWriting
    // failed, 4 the file itself could not be created.
    auto tryOpen = [&](const std::string &tryCodec, AudioPlan plan, bool extras) -> int
    {
        writer.Reset();
        DeleteFileW(partial.c_str());
        ComPtr<IMFAttributes> writerAttributes;
        MFCreateAttributes(&writerAttributes, 3);
        writerAttributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
        writerAttributes->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE);
        writerAttributes->SetGUID(kTranscodeContainerType, kContainerMpeg4);
        HRESULT openHr = MFCreateSinkWriterFromURL(partial.c_str(), nullptr, writerAttributes.Get(), &writer);
        if (FAILED(openHr)) { videoError = Hex32(openHr); return 4; }
        ComPtr<IMFMediaType> out;
        MFCreateMediaType(&out);
        out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        out->SetGUID(MF_MT_SUBTYPE, tryCodec == "hevc" ? MFVideoFormat_HEVC : MFVideoFormat_H264);
        out->SetUINT32(MF_MT_AVG_BITRATE, Bitrate(encWidth, encHeight, fps, settings.quality));
        out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        MFSetAttributeSize(out.Get(), MF_MT_FRAME_SIZE, encWidth, encHeight);
        MFSetAttributeRatio(out.Get(), MF_MT_FRAME_RATE, rateNum, rateDen);
        MFSetAttributeRatio(out.Get(), MF_MT_PIXEL_ASPECT_RATIO, parNum, parDen);
        if (tryCodec == "h264") out->SetUINT32(MF_MT_MPEG2_PROFILE, 100);   // High
        if (rotation) out->SetUINT32(kVideoRotation, rotation);
        ComPtr<IMFMediaType> in;
        MFCreateMediaType(&in);
        in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
        in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        MFSetAttributeSize(in.Get(), MF_MT_FRAME_SIZE, encWidth, encHeight);
        MFSetAttributeRatio(in.Get(), MF_MT_FRAME_RATE, rateNum, rateDen);
        MFSetAttributeRatio(in.Get(), MF_MT_PIXEL_ASPECT_RATIO, parNum, parDen);
        in->SetUINT32(MF_MT_DEFAULT_STRIDE, width * 4);
        ComPtr<IMFAttributes> encoding;
        if (extras)
        {
            out->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
            out->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
            out->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
            out->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
            in->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
            in->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_sRGB);
            in->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_0_255);
            MFCreateAttributes(&encoding, 2);
            encoding->SetUINT32(kCodecApiBPictureCount, 0);
            encoding->SetUINT32(kCodecApiGopSize, static_cast<UINT32>(std::clamp(std::lround(fps * 2.0), 1L, 600L)));
        }
        if (FAILED(openHr = writer->AddStream(out.Get(), &videoStream)) ||
            FAILED(openHr = writer->SetInputMediaType(videoStream, in.Get(), encoding.Get())))
        { videoError = Hex32(openHr); return 1; }
        if (!AddAudio(reader.Get(), writer.Get(), streams.audio, plan, audioStream, audioHow)) return 2;
        if (FAILED(openHr = writer->BeginWriting())) { videoError = Hex32(openHr); return 3; }
        return 0;
    };
    for (const std::string &tryCodec : codecs)
    {
        for (AudioPlan plan : plans)
        {
            int result = tryOpen(tryCodec, plan, true);
            if (result == 4)
            {
                writer.Reset();
                DeleteFileW(partial.c_str());
                return fail("the output file could not be created (" + videoError + ")");
            }
            if (result == 1 || result == 3)
            {
                Log("encoder refused the B-frame/colour settings for %s (%s) - trying its defaults", tryCodec.c_str(), videoError.c_str());
                result = tryOpen(tryCodec, plan, false);
                if (result == 0) plainEncoder = true;
            }
            if (result == 0) { codec = tryCodec; opened = true; break; }
            if (result == 1) break;   // this codec is refused whatever the audio: try the next codec
        }
        if (opened) break;
        if (tryCodec == "hevc") EmitWarning("This PC has no HEVC encoder Media Foundation can use - writing H.264 instead.");
    }
    if (!opened)
    {
        writer.Reset();
        DeleteFileW(partial.c_str());
        return fail("no encoder accepted " + std::to_string(encWidth) + "x" + std::to_string(encHeight) + " (" + videoError + ")");
    }
    if (settings.audio == "copy" && audioStream != MAXDWORD && audioHow.find("re-encoded") != std::string::npos)
        Log("audio: AAC passthrough was not possible - %s", audioHow.c_str());
    if (streams.audio != MAXDWORD && audioStream == MAXDWORD && settings.audio != "none")
        EmitWarning("The audio track could not be carried over - the result has no sound.");
    JsonLine("file-info").Int("index", static_cast<long long>(index)).Int("width", width).Int("height", height)
        .Int("workWidth", engine ? engine->WorkWidth() : width).Int("workHeight", engine ? engine->WorkHeight() : height).Num("fps", fps)
        .Num("seconds", duration / 1e7).Int("frames", estimatedFrames).Str("codec", codec).Str("audio", audioHow)
        .Bool("hdr", hdr).Bool("motion", engine && engine->MotionReady()).Bool("passthrough", engine == nullptr)
        .Bool("encoderDefaults", plainEncoder).Emit();
    if (hdr) EmitWarning("This is an HDR video. Windows converts it to standard range before neural rendering, so the result is SDR.");

    std::vector<float> lumaHistory;
    long long frames = 0;
    double nrTotal = 0.0, lastProgress = 0.0, firstFrameAt = 0.0;
    bool videoEnded = false, audioEnded = audioStream == MAXDWORD, ok = true;
    const size_t outBytes = static_cast<size_t>(width) * encHeight * 4;
    while (!videoEnded || !audioEnded)
    {
        if (g_cancel) { ok = false; break; }
        DWORD streamIndex = 0, flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        hr = reader->ReadSample(MF_SOURCE_READER_ANY_STREAM, 0, &streamIndex, &flags, &timestamp, &sample);
        if (FAILED(hr)) { fail("decoding stopped (" + Hex32(hr) + ")." + CodecHint(hr)); ok = false; break; }
        const bool isVideo = streamIndex == streams.video;
        const bool isAudio = streamIndex == streams.audio && audioStream != MAXDWORD;
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM)
        {
            if (isVideo) videoEnded = true;
            else if (isAudio) audioEnded = true;
            else if (streamIndex == streams.audio) audioEnded = true;
        }
        if (flags & MF_SOURCE_READERF_STREAMTICK)
        {
            if (isVideo) writer->SendStreamTick(videoStream, timestamp);
            else if (isAudio) writer->SendStreamTick(audioStream, timestamp);
        }
        if (isVideo && (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED))
        {
            ComPtr<IMFMediaType> changed;
            UINT32 newWidth = 0, newHeight = 0;
            if (SUCCEEDED(reader->GetCurrentMediaType(streams.video, &changed)))
                MFGetAttributeSize(changed.Get(), MF_MT_FRAME_SIZE, &newWidth, &newHeight);
            if (newWidth != width || newHeight != height)
            { fail("the video changes its picture size part-way through, which is not supported"); ok = false; break; }
            current = changed;
        }
        if (!sample) continue;
        if (isAudio) { writer->WriteSample(audioStream, sample.Get()); continue; }
        if (!isVideo) continue;

        LONGLONG sampleDuration = 0;
        if (FAILED(sample->GetSampleDuration(&sampleDuration)) || sampleDuration <= 0)
            sampleDuration = static_cast<LONGLONG>(1e7 * rateDen / rateNum);
        ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) continue;
        ComPtr<IMF2DBuffer> buffer2d;
        BYTE *scanline0 = nullptr;
        LONG pitch = 0;
        BYTE *linear = nullptr;
        DWORD linearLength = 0;
        bool locked2d = false;
        if (SUCCEEDED(buffer.As(&buffer2d)) && SUCCEEDED(buffer2d->Lock2D(&scanline0, &pitch))) locked2d = true;
        else if (SUCCEEDED(buffer->Lock(&linear, nullptr, &linearLength)))
        {
            // Top-down unless the media type says otherwise.
            const INT32 stride = static_cast<INT32>(MFGetAttributeUINT32(current.Get(), MF_MT_DEFAULT_STRIDE, width * 4));
            pitch = stride;
            scanline0 = stride < 0 ? linear + static_cast<ptrdiff_t>(-stride) * (height - 1) : linear;
        }
        else continue;

        const bool cut = LumaChange(scanline0, pitch, width, height, lumaHistory) > settings.sceneCut;
        FrameStats stats;
        ComPtr<IMFMediaBuffer> outBuffer;
        ComPtr<IMFSample> outSample;
        BYTE *dst = nullptr;
        if (FAILED(MFCreateMemoryBuffer(static_cast<DWORD>(static_cast<size_t>(width) * height * 4), &outBuffer)) ||
            FAILED(outBuffer->Lock(&dst, nullptr, nullptr)))
        {
            if (locked2d) buffer2d->Unlock2D(); else buffer->Unlock();
            fail("out of memory for an output frame"); ok = false; break;
        }
        bool frameOk = true;
        if (engine)
        {
            const bool uploaded = engine->UploadSource(scanline0, pitch);
            if (locked2d) buffer2d->Unlock2D(); else buffer->Unlock();
            FrameArgs args;
            args.reset = frames == 0 || cut;
            args.mix = settings.mix;
            args.stabilize = settings.stabilize;
            args.useMotion = settings.stabilize > 0.0f || settings.motionToNr;
            args.motionToNr = settings.motionToNr;
            args.readback = true;
            frameOk = uploaded && engine->Process(args, &stats) && engine->ReadResult(dst, static_cast<int>(width * 4));
            nrTotal += stats.nrMs;
        }
        else
        {
            for (UINT32 y = 0; y < height; ++y) memcpy(dst + static_cast<size_t>(y) * width * 4, scanline0 + static_cast<ptrdiff_t>(y) * pitch, static_cast<size_t>(width) * 4);
            if (locked2d) buffer2d->Unlock2D(); else buffer->Unlock();
        }
        outBuffer->Unlock();
        outBuffer->SetCurrentLength(static_cast<DWORD>(outBytes));
        if (!frameOk) { fail("neural rendering failed at frame " + std::to_string(frames + 1)); ok = false; break; }
        MFCreateSample(&outSample);
        outSample->AddBuffer(outBuffer.Get());
        outSample->SetSampleTime(timestamp);
        outSample->SetSampleDuration(sampleDuration);
        if (FAILED(hr = writer->WriteSample(videoStream, outSample.Get())))
        { fail("the encoder refused a frame (" + Hex32(hr) + ")"); ok = false; break; }
        ++frames;

        const double now = NowMs();
        if (frames == 1) firstFrameAt = now;
        if (now - lastProgress > 250.0)
        {
            lastProgress = now;
            // Speed from the first finished frame on, so start-up (optical
            // flow and NR set-up, ~2 s) does not drag the estimate down.
            const double elapsed = (now - firstFrameAt) / 1000.0;
            const double rate = frames > 1 && elapsed > 0.05 ? (frames - 1) / elapsed : 0.0;
            JsonLine("progress").Int("index", static_cast<long long>(index)).Int("frame", frames).Int("frames", estimatedFrames)
                .Num("seconds", timestamp / 1e7).Num("duration", duration / 1e7).Num("fps", rate)
                .Num("nrMs", stats.nrMs).Bool("cut", cut).Bool("motion", stats.motionUsed).Emit();
        }
    }

    if (!ok)
    {
        writer.Reset();
        reader.Reset();
        DeleteFileW(partial.c_str());
        if (g_cancel) JsonLine("file-cancelled").Int("index", static_cast<long long>(index)).WStr("input", item.input).Emit();
        return false;
    }
    hr = writer->Finalize();
    writer.Reset();
    reader.Reset();
    if (FAILED(hr)) { DeleteFileW(partial.c_str()); return fail("the MP4 could not be finished (" + Hex32(hr) + ")"); }
    {
        std::string note;
        const bool fixed = Mp4FixVideoStart(partial, note);
        Log("mp4 start: %s%s", fixed ? "" : "not changed - ", note.c_str());
    }
    if (!MoveFileExW(partial.c_str(), item.output.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    {
        DeleteFileW(partial.c_str());
        return fail("the finished video could not be moved into place (Windows error " + std::to_string(GetLastError()) + ")");
    }
    JsonLine("file-done").Int("index", static_cast<long long>(index)).WStr("input", item.input).WStr("output", item.output)
        .Num("ms", NowMs() - started).Int("frames", frames).Num("nrMs", frames ? nrTotal / frames : 0.0).Str("codec", codec).Str("audio", audioHow).Emit();
    return true;
}
} // namespace

bool RunVideos(Engine *engine, const std::vector<JobItem> &items, const Settings &settings)
{
    MfSession session;
    if (!session.ok) { EmitError("Media Foundation is not available on this Windows installation (an N edition needs the Media Feature Pack).", true); return false; }
    int done = 0, failed = 0;
    for (size_t index = 0; index < items.size() && !g_cancel; ++index)
    {
        JsonLine("file-start").Int("index", static_cast<long long>(index)).WStr("input", items[index].input).Str("kind", "video").Emit();
        if (ProcessOne(engine, items[index], index, settings)) ++done; else if (!g_cancel) ++failed;
    }
    JsonLine("summary").Int("done", done).Int("failed", failed).Bool("cancelled", g_cancel.load()).Emit();
    return failed == 0 && !g_cancel;
}
} // namespace dm
