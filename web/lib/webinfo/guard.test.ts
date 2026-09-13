import { describe, expect, it } from "vitest";
import { checkContentType, checkUrl } from "./guard";

describe("checkUrl (before any request)", () => {
  const rejected = [
    "https://www.youtube.com/watch?v=abc123",
    "https://youtu.be/abc123",
    "https://soundcloud.com/artist/track/stream",
    "https://soundcloud.com/artist/track",
    "https://open.spotify.com/track/xyz",
    "https://music.apple.com/us/album/x/1",
    "https://tidal.com/browse/track/1",
    "https://www.deezer.com/track/1",
    "https://www.mixcloud.com/someone/mix/",
    "https://audiomack.com/song/x",
    "https://example.com/audio/song.mp3",
    "https://example.com/files/take1.WAV",
    "https://example.com/x/y.flac?dl=1",
    "https://example.com/x/y.m4a",
    "https://example.com/x/y.aac",
    "https://example.com/x/y.ogg",
    "https://example.com/x/y.mp4",
    "https://example.com/x/y.webm",
    "https://cdn.example.com/hls/index.m3u8",
    "https://example.com/download/12345",
    "https://example.com/stream/abc",
    "https://example.com/dl/abc",
    "https://example.com/get?file=song.mp3",
    "https://artist.bandcamp.com/download/track?id=1",
    "https://t4.bcbits.com/stream/abc/mp3-128/123",
    "ftp://example.com/page",
    "http://127.0.0.1/admin",
    "http://192.168.1.4/",
    "http://localhost:3000/",
    "not a url",
  ];
  it.each(rejected)("rejects %s", (url) => {
    const v = checkUrl(url);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
  });

  const allowed = [
    "https://www.whosampled.com/Track/Sample/",
    "https://en.wikipedia.org/wiki/Producer",
    "https://artist.bandcamp.com/album/record",
    "https://www.discogs.com/release/123-Artist-Title",
    "https://example.com/interview-about-the-mpc3000",
    "https://example.com/stream-of-consciousness-essay",
    "https://example.com/downloads-are-bad/article",
  ];
  it.each(allowed)("allows %s", (url) => {
    expect(checkUrl(url).ok).toBe(true);
  });

  it("names the platform in the refusal", () => {
    const v = checkUrl("https://www.youtube.com/watch?v=abc");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("youtube.com");
  });
});

describe("checkContentType (after the response)", () => {
  it("accepts the readable types", () => {
    for (const t of ["text/html; charset=utf-8", "text/plain", "application/xhtml+xml", "application/json"]) {
      expect(checkContentType(t).ok).toBe(true);
    }
  });

  it("refuses audio, video, octet-stream and everything else, naming the type", () => {
    for (const t of ["audio/mpeg", "video/mp4", "application/octet-stream", "image/png", "application/pdf", "application/zip"]) {
      const v = checkContentType(t);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain(t);
    }
    expect(checkContentType(null).ok).toBe(false);
  });
});
