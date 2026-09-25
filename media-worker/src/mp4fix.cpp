// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
// dlss5-media - MP4 start fix. Apache-2.0.
//
// Media Foundation's MP4 sink gives H.264/HEVC video a composition offset
// (the first frame is presented ~2 frames after 0:00, even with B-frames off)
// but writes no edit list to take it back out, so the picture runs behind the
// sound in every player. This adds the edit list other muxers write: one
// entry that starts the video track at its first frame's composition time.
//
// Only the moov box is touched, and only when it is the last box in the file
// (Media Foundation always puts it after the media data), so no chunk offset
// moves. The patched moov is written over the old one in place; if writing
// fails the original bytes are put back.
#include "jobs.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <optional>
#include <vector>

namespace dm
{
namespace
{
struct Box
{
    size_t pos = 0;      // offset of the box header within the buffer
    size_t size = 0;     // whole box, header included
    size_t header = 8;   // 8, or 16 with a 64-bit size
    char type[5] = {};
};

uint32_t Be32(const unsigned char *p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
uint64_t Be64(const unsigned char *p) { return (uint64_t(Be32(p)) << 32) | Be32(p + 4); }
void Put32(unsigned char *p, uint32_t v) { p[0] = uint8_t(v >> 24); p[1] = uint8_t(v >> 16); p[2] = uint8_t(v >> 8); p[3] = uint8_t(v); }
void Put64(unsigned char *p, uint64_t v) { Put32(p, uint32_t(v >> 32)); Put32(p + 4, uint32_t(v)); }

// Children of the range [start, end) of buf; empty on any inconsistency.
std::optional<std::vector<Box>> Children(const std::vector<unsigned char> &buf, size_t start, size_t end)
{
    std::vector<Box> boxes;
    size_t pos = start;
    while (pos + 8 <= end)
    {
        Box box;
        box.pos = pos;
        uint64_t size = Be32(&buf[pos]);
        memcpy(box.type, &buf[pos + 4], 4);
        if (size == 1)
        {
            if (pos + 16 > end) return std::nullopt;
            size = Be64(&buf[pos + 8]);
            box.header = 16;
        }
        else if (size == 0) size = end - pos;
        if (size < box.header || size > end - pos) return std::nullopt;
        box.size = static_cast<size_t>(size);
        boxes.push_back(box);
        pos += box.size;
    }
    if (pos != end) return std::nullopt;
    return boxes;
}

const Box *Find(const std::vector<Box> &boxes, const char *type)
{
    for (const Box &box : boxes)
        if (memcmp(box.type, type, 4) == 0) return &box;
    return nullptr;
}

std::optional<std::vector<Box>> Inside(const std::vector<unsigned char> &buf, const Box &box)
{
    return Children(buf, box.pos + box.header, box.pos + box.size);
}

// Duration field of a full box (mvhd / tkhd / mdhd): offset within buf and width.
bool DurationField(const std::vector<unsigned char> &buf, const Box &box, bool tkhd, size_t &offset, bool &wide)
{
    const size_t body = box.pos + box.header;
    if (body + 4 > box.pos + box.size) return false;
    wide = buf[body] == 1;
    // version 0: creation(4) modification(4) [timescale(4) | track_ID(4) reserved(4)] duration(4)
    // version 1: creation(8) modification(8) [timescale(4) | track_ID(4) reserved(4)] duration(8)
    const size_t times = wide ? 16 : 8;
    offset = body + 4 + times + (tkhd ? 8 : 4);
    return offset + (wide ? 8 : 4) <= box.pos + box.size;
}

uint64_t ReadField(const std::vector<unsigned char> &buf, size_t offset, bool wide) { return wide ? Be64(&buf[offset]) : Be32(&buf[offset]); }
void WriteField(std::vector<unsigned char> &buf, size_t offset, bool wide, uint64_t value)
{
    if (wide) Put64(&buf[offset], value); else Put32(&buf[offset], static_cast<uint32_t>(value));
}

uint32_t Timescale(const std::vector<unsigned char> &buf, const Box &box)
{
    const size_t body = box.pos + box.header;
    const bool wide = buf[body] == 1;
    const size_t at = body + 4 + (wide ? 16 : 8);
    return at + 4 <= box.pos + box.size ? Be32(&buf[at]) : 0;
}

bool ReadAt(HANDLE file, uint64_t offset, void *data, DWORD bytes)
{
    LARGE_INTEGER at;
    at.QuadPart = static_cast<LONGLONG>(offset);
    DWORD done = 0;
    return SetFilePointerEx(file, at, nullptr, FILE_BEGIN) && ReadFile(file, data, bytes, &done, nullptr) && done == bytes;
}

bool WriteAt(HANDLE file, uint64_t offset, const void *data, DWORD bytes)
{
    LARGE_INTEGER at;
    at.QuadPart = static_cast<LONGLONG>(offset);
    DWORD done = 0;
    return SetFilePointerEx(file, at, nullptr, FILE_BEGIN) && WriteFile(file, data, bytes, &done, nullptr) && done == bytes;
}
} // namespace

bool Mp4FixVideoStart(const std::wstring &path, std::string &note)
{
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) { note = "could not open the file"; return false; }
    struct Closer { HANDLE h; ~Closer() { CloseHandle(h); } } closer{file};
    LARGE_INTEGER fileSize = {};
    if (!GetFileSizeEx(file, &fileSize) || fileSize.QuadPart < 16) { note = "file too small"; return false; }
    const uint64_t total = static_cast<uint64_t>(fileSize.QuadPart);

    // Top-level walk (headers only) to find moov and make sure it is last.
    uint64_t pos = 0, moovPos = 0, moovSize = 0;
    bool sawMdat = false;
    while (pos + 8 <= total)
    {
        unsigned char header[16];
        if (!ReadAt(file, pos, header, 8)) { note = "read failed"; return false; }
        uint64_t size = Be32(header);
        if (size == 1)
        {
            if (!ReadAt(file, pos + 8, header + 8, 8)) { note = "read failed"; return false; }
            size = Be64(header + 8);
        }
        else if (size == 0) size = total - pos;
        if (size < 8 || size > total - pos) { note = "unexpected box layout"; return false; }
        if (memcmp(header + 4, "mdat", 4) == 0) sawMdat = true;
        if (memcmp(header + 4, "moov", 4) == 0) { moovPos = pos; moovSize = size; }
        pos += size;
    }
    if (!moovSize) { note = "no moov box"; return false; }
    if (moovPos + moovSize != total || !sawMdat) { note = "moov is not the last box - left as it is"; return false; }
    if (moovSize > (256ull << 20)) { note = "moov unusually large - left as it is"; return false; }

    std::vector<unsigned char> moov(static_cast<size_t>(moovSize));
    if (!ReadAt(file, moovPos, moov.data(), static_cast<DWORD>(moov.size()))) { note = "read failed"; return false; }
    const std::vector<unsigned char> original = moov;
    Box moovBox;
    moovBox.pos = 0;
    moovBox.size = moov.size();
    moovBox.header = Be32(moov.data()) == 1 ? 16 : 8;
    auto top = Inside(moov, moovBox);
    if (!top) { note = "moov could not be read"; return false; }
    const Box *mvhd = Find(*top, "mvhd");
    if (!mvhd) { note = "no mvhd"; return false; }
    const uint32_t movieScale = Timescale(moov, *mvhd);
    if (!movieScale) { note = "no movie timescale"; return false; }

    // The video track without an edit list whose first frame is presented after 0.
    const Box *target = nullptr;
    int64_t mediaTime = 0;
    uint32_t mediaScale = 0;
    for (const Box &trak : *top)
    {
        if (memcmp(trak.type, "trak", 4) != 0) continue;
        auto parts = Inside(moov, trak);
        if (!parts || Find(*parts, "edts") || !Find(*parts, "tkhd")) continue;
        const Box *mdia = Find(*parts, "mdia");
        if (!mdia) continue;
        auto mdiaParts = Inside(moov, *mdia);
        if (!mdiaParts) continue;
        const Box *hdlr = Find(*mdiaParts, "hdlr");
        const Box *mdhd = Find(*mdiaParts, "mdhd");
        const Box *minf = Find(*mdiaParts, "minf");
        if (!hdlr || !mdhd || !minf || hdlr->pos + hdlr->header + 12 > hdlr->pos + hdlr->size) continue;
        if (memcmp(&moov[hdlr->pos + hdlr->header + 8], "vide", 4) != 0) continue;
        auto minfParts = Inside(moov, *minf);
        const Box *stbl = minfParts ? Find(*minfParts, "stbl") : nullptr;
        auto stblParts = stbl ? Inside(moov, *stbl) : std::nullopt;
        const Box *ctts = stblParts ? Find(*stblParts, "ctts") : nullptr;
        if (!ctts) { note = "video has no composition offsets - nothing to fix"; return false; }
        const size_t body = ctts->pos + ctts->header;
        if (body + 16 > ctts->pos + ctts->size || Be32(&moov[body + 4]) == 0) continue;
        const bool signedOffsets = moov[body] == 1;
        const uint32_t raw = Be32(&moov[body + 12]);   // first entry: sample_count(4) sample_offset(4)
        mediaTime = signedOffsets ? static_cast<int32_t>(raw) : static_cast<int64_t>(raw);
        mediaScale = Timescale(moov, *mdhd);
        target = &trak;
        break;
    }
    if (!target) { note = "no video track needing a fix"; return false; }
    if (mediaTime <= 0 || !mediaScale) { note = "the video already starts at 0:00"; return false; }
    if (mediaTime > INT32_MAX) { note = "offset out of range"; return false; }

    // Shorten the track by the offset and insert edts/elst right after tkhd.
    auto parts = Inside(moov, *target);
    const Box *tkhd = Find(*parts, "tkhd");
    size_t durationAt = 0;
    bool wide = false;
    if (!DurationField(moov, *tkhd, true, durationAt, wide)) { note = "tkhd could not be read"; return false; }
    const uint64_t trackDuration = ReadField(moov, durationAt, wide);
    const uint64_t shift = static_cast<uint64_t>((static_cast<double>(mediaTime) * movieScale) / mediaScale + 0.5);
    const uint64_t presented = trackDuration > shift ? trackDuration - shift : trackDuration;
    if (presented > UINT32_MAX) { note = "track too long for a version-0 edit list"; return false; }
    WriteField(moov, durationAt, wide, presented);

    unsigned char edts[36];
    Put32(edts, 36);
    memcpy(edts + 4, "edts", 4);
    Put32(edts + 8, 28);
    memcpy(edts + 12, "elst", 4);
    Put32(edts + 16, 0);                                   // version 0, flags 0
    Put32(edts + 20, 1);                                   // one entry
    Put32(edts + 24, static_cast<uint32_t>(presented));    // segment_duration (movie timescale)
    Put32(edts + 28, static_cast<uint32_t>(mediaTime));    // media_time (media timescale)
    Put32(edts + 32, 0x00010000);                          // media_rate 1.0
    const size_t insertAt = tkhd->pos + tkhd->size;
    const size_t trakPos = target->pos, trakHeader = target->header;
    moov.insert(moov.begin() + static_cast<ptrdiff_t>(insertAt), edts, edts + sizeof(edts));

    auto grow = [&](size_t boxPos, size_t header)
    {
        if (header == 16) Put64(&moov[boxPos + 8], Be64(&moov[boxPos + 8]) + sizeof(edts));
        else Put32(&moov[boxPos], Be32(&moov[boxPos]) + sizeof(edts));
    };
    grow(trakPos, trakHeader);
    grow(0, moovBox.header);

    // The movie lasts as long as its longest track.
    moovBox.size = moov.size();
    auto after = Inside(moov, moovBox);
    if (!after) { moov = original; note = "patched moov did not parse - left as it is"; return false; }
    uint64_t longest = 0;
    for (const Box &trak : *after)
    {
        if (memcmp(trak.type, "trak", 4) != 0) continue;
        auto trakParts = Inside(moov, trak);
        const Box *header = trakParts ? Find(*trakParts, "tkhd") : nullptr;
        size_t at = 0;
        bool w = false;
        if (header && DurationField(moov, *header, true, at, w)) longest = std::max(longest, ReadField(moov, at, w));
    }
    const Box *movieHeader = Find(*after, "mvhd");
    size_t movieDurationAt = 0;
    bool movieWide = false;
    if (movieHeader && longest && DurationField(moov, *movieHeader, false, movieDurationAt, movieWide))
        WriteField(moov, movieDurationAt, movieWide, longest);

    if (!WriteAt(file, moovPos, moov.data(), static_cast<DWORD>(moov.size())))
    {
        WriteAt(file, moovPos, original.data(), static_cast<DWORD>(original.size()));
        LARGE_INTEGER end;
        end.QuadPart = static_cast<LONGLONG>(total);
        SetFilePointerEx(file, end, nullptr, FILE_BEGIN);
        SetEndOfFile(file);
        note = "write failed - left as it was";
        return false;
    }
    FlushFileBuffers(file);
    char text[160];
    snprintf(text, sizeof(text), "video starts at 0:00 (removed a %.1f ms encoder offset)", mediaTime * 1000.0 / mediaScale);
    note = text;
    return true;
}
} // namespace dm
