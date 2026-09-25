// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - pictures through Windows Imaging Component. Apache-2.0.
//
// Anything WIC can open (PNG, JPEG, BMP, TIFF, GIF's first frame, and WebP /
// HEIC / AVIF when Windows has those codecs) is decoded to 8-bit sRGB RGBA -
// converting from an embedded colour profile first when there is one, and
// turning the picture upright from its EXIF orientation - run once through NR
// with a fresh history, and written as PNG (lossless, the default) or JPEG.
#include "jobs.h"

#include <wincodec.h>
#include <wincodecsdk.h>
#include <propvarutil.h>

#include <algorithm>
#include <cstring>

namespace dm
{
namespace
{
ComPtr<IWICImagingFactory> Factory()
{
    static ComPtr<IWICImagingFactory> factory;
    if (!factory)
    {
        if (FAILED(CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory))))
            CoCreateInstance(CLSID_WICImagingFactory1, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
    }
    return factory;
}

// EXIF orientation 1..8 -> WIC transform.
WICBitmapTransformOptions OrientationTransform(unsigned short orientation)
{
    switch (orientation)
    {
    case 2: return WICBitmapTransformFlipHorizontal;
    case 3: return WICBitmapTransformRotate180;
    case 4: return WICBitmapTransformFlipVertical;
    case 5: return static_cast<WICBitmapTransformOptions>(WICBitmapTransformRotate90 | WICBitmapTransformFlipHorizontal);
    case 6: return WICBitmapTransformRotate90;
    case 7: return static_cast<WICBitmapTransformOptions>(WICBitmapTransformRotate270 | WICBitmapTransformFlipHorizontal);
    case 8: return WICBitmapTransformRotate270;
    default: return WICBitmapTransformRotate0;
    }
}

unsigned short ReadOrientation(IWICBitmapFrameDecode *frame)
{
    ComPtr<IWICMetadataQueryReader> reader;
    if (FAILED(frame->GetMetadataQueryReader(&reader)) || !reader) return 1;
    const wchar_t *queries[] = {L"/app1/ifd/{ushort=274}", L"/ifd/{ushort=274}", L"/xmp/tiff:Orientation"};
    for (const wchar_t *query : queries)
    {
        PROPVARIANT value;
        PropVariantInit(&value);
        if (SUCCEEDED(reader->GetMetadataByName(query, &value)))
        {
            unsigned short orientation = 1;
            if (value.vt == VT_UI2) orientation = value.uiVal;
            else if (value.vt == VT_UI4) orientation = static_cast<unsigned short>(value.ulVal);
            else if (value.vt == VT_LPSTR && value.pszVal) orientation = static_cast<unsigned short>(atoi(value.pszVal));
            PropVariantClear(&value);
            if (orientation >= 1 && orientation <= 8) return orientation;
        }
        PropVariantClear(&value);
    }
    return 1;
}

struct Picture
{
    unsigned width = 0, height = 0;
    std::vector<unsigned char> rgba;
    bool hasAlpha = false;
    bool colorConverted = false;
    unsigned short orientation = 1;
};

bool LoadPicture(const std::wstring &path, Picture &out, std::string &error)
{
    ComPtr<IWICImagingFactory> factory = Factory();
    if (!factory) { error = "Windows Imaging Component is unavailable"; return false; }
    ComPtr<IWICBitmapDecoder> decoder;
    HRESULT hr = factory->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &decoder);
    if (FAILED(hr))
    {
        error = hr == static_cast<HRESULT>(0x88982F50) ? "Windows has no decoder for this picture format (for HEIC/AVIF/WebP install the matching extension from the Microsoft Store)"
            : "the picture could not be opened (" + Hex32(hr) + ")";
        return false;
    }
    ComPtr<IWICBitmapFrameDecode> frame;
    if (FAILED(hr = decoder->GetFrame(0, &frame))) { error = "the picture has no readable frame (" + Hex32(hr) + ")"; return false; }

    WICPixelFormatGUID native = {};
    frame->GetPixelFormat(&native);
    ComPtr<IWICComponentInfo> info;
    ComPtr<IWICPixelFormatInfo2> formatInfo;
    BOOL alpha = FALSE;
    if (SUCCEEDED(factory->CreateComponentInfo(native, &info)) && SUCCEEDED(info.As(&formatInfo))) formatInfo->SupportsTransparency(&alpha);
    out.hasAlpha = alpha != FALSE;

    ComPtr<IWICBitmapSource> source = frame;
    // An embedded colour profile that is not sRGB (Display P3 phone photos,
    // Adobe RGB exports) is converted to sRGB first: NR expects display sRGB.
    UINT contexts = 0;
    if (SUCCEEDED(frame->GetColorContexts(0, nullptr, &contexts)) && contexts > 0)
    {
        std::vector<IWICColorContext *> list(contexts, nullptr);
        std::vector<ComPtr<IWICColorContext>> owned(contexts);
        for (UINT i = 0; i < contexts; ++i) { factory->CreateColorContext(&owned[i]); list[i] = owned[i].Get(); }
        UINT got = 0;
        ComPtr<IWICColorContext> srgb;
        ComPtr<IWICColorTransform> transform;
        if (SUCCEEDED(frame->GetColorContexts(contexts, list.data(), &got)) && got > 0 &&
            SUCCEEDED(factory->CreateColorContext(&srgb)) && SUCCEEDED(srgb->InitializeFromExifColorSpace(1)) &&
            SUCCEEDED(factory->CreateColorTransformer(&transform)))
        {
            WICColorContextType type = WICColorContextUninitialized;
            owned[0]->GetType(&type);
            const WICPixelFormatGUID target = out.hasAlpha ? GUID_WICPixelFormat32bppBGRA : GUID_WICPixelFormat24bppBGR;
            if (type == WICColorContextProfile && SUCCEEDED(transform->Initialize(frame.Get(), owned[0].Get(), srgb.Get(), target)))
            {
                source = transform;
                out.colorConverted = true;
            }
        }
    }

    out.orientation = ReadOrientation(frame.Get());
    const WICBitmapTransformOptions orient = OrientationTransform(out.orientation);
    if (orient != WICBitmapTransformRotate0)
    {
        ComPtr<IWICBitmapFlipRotator> rotator;
        if (SUCCEEDED(factory->CreateBitmapFlipRotator(&rotator)) && SUCCEEDED(rotator->Initialize(source.Get(), orient)))
            source = rotator;
    }

    ComPtr<IWICFormatConverter> converter;
    if (FAILED(hr = factory->CreateFormatConverter(&converter)) ||
        FAILED(hr = converter->Initialize(source.Get(), GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom)))
    {
        error = "the picture could not be converted to RGBA (" + Hex32(hr) + ")";
        return false;
    }
    UINT w = 0, h = 0;
    converter->GetSize(&w, &h);
    if (w == 0 || h == 0) { error = "the picture is empty"; return false; }
    out.width = w;
    out.height = h;
    out.rgba.resize(static_cast<size_t>(w) * h * 4);
    if (FAILED(hr = converter->CopyPixels(nullptr, w * 4, static_cast<UINT>(out.rgba.size()), out.rgba.data())))
    {
        error = "the picture's pixels could not be read (" + Hex32(hr) + ")";
        return false;
    }
    if (!out.hasAlpha)
        for (size_t i = 3; i < out.rgba.size(); i += 4) out.rgba[i] = 255;
    return true;
}

bool SavePicture(const std::wstring &path, const Picture &picture, int jpegQuality, std::string &error)
{
    ComPtr<IWICImagingFactory> factory = Factory();
    const std::wstring ext = ExtensionOf(path);
    const bool jpeg = ext == L".jpg" || ext == L".jpeg";
    const bool tiff = ext == L".tif" || ext == L".tiff";
    const GUID container = jpeg ? GUID_ContainerFormatJpeg : (tiff ? GUID_ContainerFormatTiff : GUID_ContainerFormatPng);
    // Written beside the target and moved into place, so a crash never leaves
    // a half-written file under the real name.
    const std::wstring partial = path + L".partial";
    DeleteFileW(partial.c_str());
    HRESULT hr;
    {
        ComPtr<IWICStream> stream;
        ComPtr<IWICBitmapEncoder> encoder;
        ComPtr<IWICBitmapFrameEncode> frame;
        ComPtr<IPropertyBag2> props;
        if (FAILED(hr = factory->CreateStream(&stream)) ||
            FAILED(hr = stream->InitializeFromFilename(partial.c_str(), GENERIC_WRITE)) ||
            FAILED(hr = factory->CreateEncoder(container, nullptr, &encoder)) ||
            FAILED(hr = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache)) ||
            FAILED(hr = encoder->CreateNewFrame(&frame, &props)))
        { error = "the output file could not be created (" + Hex32(hr) + ")"; DeleteFileW(partial.c_str()); return false; }
        if (jpeg && props)
        {
            PROPBAG2 option = {};
            option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
            VARIANT value;
            VariantInit(&value);
            value.vt = VT_R4;
            value.fltVal = std::clamp(jpegQuality, 1, 100) / 100.0f;
            props->Write(1, &option, &value);
        }
        if (FAILED(hr = frame->Initialize(props.Get()))) { error = "encoder refused its options (" + Hex32(hr) + ")"; DeleteFileW(partial.c_str()); return false; }
        frame->SetSize(picture.width, picture.height);
        frame->SetResolution(96.0, 96.0);
        WICPixelFormatGUID wanted = jpeg ? GUID_WICPixelFormat24bppBGR : (picture.hasAlpha ? GUID_WICPixelFormat32bppRGBA : GUID_WICPixelFormat24bppBGR);
        WICPixelFormatGUID accepted = wanted;
        frame->SetPixelFormat(&accepted);

        ComPtr<IWICBitmap> bitmap;
        if (FAILED(hr = factory->CreateBitmapFromMemory(picture.width, picture.height, GUID_WICPixelFormat32bppRGBA, picture.width * 4,
                static_cast<UINT>(picture.rgba.size()), const_cast<BYTE *>(picture.rgba.data()), &bitmap)))
        { error = "result could not be wrapped (" + Hex32(hr) + ")"; DeleteFileW(partial.c_str()); return false; }
        ComPtr<IWICBitmapSource> source = bitmap;
        if (!IsEqualGUID(accepted, GUID_WICPixelFormat32bppRGBA))
        {
            ComPtr<IWICFormatConverter> converter;
            if (FAILED(hr = factory->CreateFormatConverter(&converter)) ||
                FAILED(hr = converter->Initialize(bitmap.Get(), accepted, WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom)))
            { error = "result could not be converted for the encoder (" + Hex32(hr) + ")"; DeleteFileW(partial.c_str()); return false; }
            source = converter;
        }
        if (FAILED(hr = frame->WriteSource(source.Get(), nullptr)) || FAILED(hr = frame->Commit()) || FAILED(hr = encoder->Commit()))
        { error = "the result could not be written (" + Hex32(hr) + ")"; DeleteFileW(partial.c_str()); return false; }
    }
    if (!MoveFileExW(partial.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    {
        error = "the finished file could not be moved into place (Windows error " + std::to_string(GetLastError()) + ")";
        DeleteFileW(partial.c_str());
        return false;
    }
    return true;
}
} // namespace

bool SaveRgba(const std::wstring &path, const unsigned char *rgba, unsigned width, unsigned height, bool alpha, int jpegQuality, std::string &error)
{
    Picture picture;
    picture.width = width;
    picture.height = height;
    picture.hasAlpha = alpha;
    picture.rgba.assign(rgba, rgba + static_cast<size_t>(width) * height * 4);
    return SavePicture(path, picture, jpegQuality, error);
}

bool RunImages(Engine *engine, const std::vector<JobItem> &items, const Settings &settings)
{
    int done = 0, failed = 0;
    for (size_t index = 0; index < items.size(); ++index)
    {
        if (g_cancel) break;
        const JobItem &item = items[index];
        const double started = NowMs();
        JsonLine("file-start").Int("index", static_cast<long long>(index)).WStr("input", item.input).Str("kind", "image").Emit();
        Picture picture;
        std::string error;
        if (!LoadPicture(item.input, picture, error))
        {
            JsonLine("file-error").Int("index", static_cast<long long>(index)).WStr("input", item.input).Str("message", error).Emit();
            ++failed;
            continue;
        }
        std::vector<unsigned char> original;
        double nrMs = 0.0;
        if (engine)
        {
            if (!engine->Configure(picture.width, picture.height, SourceKind::Rgba8, OutputKind::Rgba8, settings.maxWorkPixels, settings.look, false))
            {
                JsonLine("file-error").Int("index", static_cast<long long>(index)).WStr("input", item.input)
                    .Str("message", "neural rendering could not be set up for " + std::to_string(picture.width) + "x" + std::to_string(picture.height)).Emit();
                ++failed;
                continue;
            }
            JsonLine("file-info").Int("index", static_cast<long long>(index)).Int("width", picture.width).Int("height", picture.height)
                .Int("workWidth", engine->WorkWidth()).Int("workHeight", engine->WorkHeight()).Bool("alpha", picture.hasAlpha)
                .Bool("colorConverted", picture.colorConverted).Int("orientation", picture.orientation).Emit();
            FrameStats stats;
            bool ok = engine->UploadSource(picture.rgba.data(), static_cast<int>(picture.width * 4));
            const int evaluations = std::clamp(settings.refine, 1, 16);
            for (int pass = 0; ok && pass < evaluations; ++pass)
            {
                FrameArgs args;
                args.reset = pass == 0;
                args.mix = settings.mix;
                args.readback = pass == evaluations - 1;
                ok = engine->Process(args, &stats);
                nrMs += stats.nrMs;
            }
            if (ok)
            {
                original.swap(picture.rgba);
                picture.rgba.resize(original.size());
                ok = engine->ReadResult(picture.rgba.data(), static_cast<int>(picture.width * 4));
            }
            if (!ok)
            {
                JsonLine("file-error").Int("index", static_cast<long long>(index)).WStr("input", item.input).Str("message", "neural rendering failed on this picture").Emit();
                ++failed;
                continue;
            }
        }
        else
        {
            JsonLine("file-info").Int("index", static_cast<long long>(index)).Int("width", picture.width).Int("height", picture.height)
                .Bool("alpha", picture.hasAlpha).Bool("colorConverted", picture.colorConverted).Int("orientation", picture.orientation)
                .Bool("passthrough", true).Emit();
            original = picture.rgba;
        }
        // How much NR changed: mean absolute difference, a sanity signal for the UI.
        double change = 0.0;
        for (size_t i = 0; i < original.size(); i += 4)
            change += std::abs(int(picture.rgba[i]) - int(original[i])) + std::abs(int(picture.rgba[i + 1]) - int(original[i + 1])) + std::abs(int(picture.rgba[i + 2]) - int(original[i + 2]));
        change /= (original.size() / 4) * 3.0 * 255.0;
        if (!EnsureDirectory(DirectoryOf(item.output)) || !SavePicture(item.output, picture, settings.jpegQuality, error))
        {
            JsonLine("file-error").Int("index", static_cast<long long>(index)).WStr("input", item.input).Str("message", error.empty() ? "the output folder is not writable" : error).Emit();
            ++failed;
            continue;
        }
        ++done;
        JsonLine("file-done").Int("index", static_cast<long long>(index)).WStr("input", item.input).WStr("output", item.output)
            .Num("ms", NowMs() - started).Num("nrMs", nrMs).Num("change", change).Emit();
    }
    JsonLine("summary").Int("done", done).Int("failed", failed).Bool("cancelled", g_cancel.load()).Emit();
    return failed == 0 && !g_cancel;
}
} // namespace dm
