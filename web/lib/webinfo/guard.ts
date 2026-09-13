// The fetch guard (principle 3, BUILD_PACKET sections 13 and 21). Two checks:
// before the request, the URL; after the response, the content type. Both are
// pure so the tests can assert them without a network.

const MEDIA_HOSTS: readonly string[] = [
  // streaming platforms
  "youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com",
  "soundcloud.com", "sndcdn.com",
  "spotify.com", "scdn.co", "spotifycdn.com",
  "music.apple.com", "itunes.apple.com", "mzstatic.com",
  "tidal.com", "tidalhifi.com",
  "deezer.com", "dzcdn.net",
  "mixcloud.com", "audiomack.com",
  "vimeo.com", "dailymotion.com", "tiktok.com", "twitch.tv",
  // bandcamp's media CDN (bandcamp.com pages themselves are fine: credits live there)
  "bcbits.com",
  // file-sharing download surfaces
  "mega.nz", "mediafire.com", "zippyshare.com", "wetransfer.com", "4shared.com", "sendspace.com",
];

/** bandcamp.com is allowed for its pages, but its download and stream paths are not. */
const HOST_PATH_RULES: ReadonlyArray<{ host: string; paths: RegExp }> = [
  { host: "bandcamp.com", paths: /\/(download|stream|api\/(download|stream|mobile\/\d+\/tralbum_details))(\/|$)/i },
];

const MEDIA_EXTENSIONS = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|wma|aif|aiff|mp4|m4v|webm|mkv|mov|avi|m3u8|mpd|ts)$/i;
const MEDIA_PATHS = /\/(download|stream|dl)(\/|$)/i;

const ALLOWED_CONTENT_TYPES: readonly string[] = ["text/html", "text/plain", "application/xhtml+xml", "application/json"];

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

function hostMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0") return true;
  if (host === "::1" || host.startsWith("[")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Decide whether a URL may be requested at all. Refuses media platforms,
 * media CDNs, download and stream paths, media file extensions, non-http
 * schemes, credentials in the URL, and private addresses.
 */
export function checkUrl(input: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "that isn't a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `only http and https pages can be read, not ${url.protocol.replace(":", "")}` };
  }
  if (url.username || url.password) return { ok: false, reason: "URLs with credentials are not fetched" };
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return { ok: false, reason: "private and local addresses are not fetched" };
  for (const h of MEDIA_HOSTS) {
    if (hostMatches(host, h)) {
      return { ok: false, reason: `${h} is a media platform; I read pages for information but never pull audio or video from a link` };
    }
  }
  const path = url.pathname;
  for (const rule of HOST_PATH_RULES) {
    if (hostMatches(host, rule.host) && rule.paths.test(path)) {
      return { ok: false, reason: `${rule.host} download and stream paths are not fetched` };
    }
  }
  if (MEDIA_PATHS.test(path)) return { ok: false, reason: "download and stream paths are not fetched" };
  if (MEDIA_EXTENSIONS.test(path)) {
    return {
      ok: false,
      reason: `that link points at a media file (${path.slice(path.lastIndexOf(".") + 1).toLowerCase()}); I don't download audio or video`,
    };
  }
  // a media file named in the query string (?file=song.mp3) is the same thing
  for (const value of url.searchParams.values()) {
    if (MEDIA_EXTENSIONS.test(value)) return { ok: false, reason: "that link points at a media file; I don't download audio or video" };
  }
  return { ok: true, url };
}

export type ContentTypeVerdict = { ok: true; type: string } | { ok: false; reason: string; type: string };

/** After the response: only readable text types are extracted; everything else is refused by name. */
export function checkContentType(header: string | null): ContentTypeVerdict {
  const type = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type) return { ok: false, reason: "the response had no content type, so I won't read it", type: "unknown" };
  if (ALLOWED_CONTENT_TYPES.includes(type)) return { ok: true, type };
  const family = type.split("/")[0];
  const what = family === "audio" || family === "video" ? `${family} (${type})` : type;
  return { ok: false, reason: `the response is ${what}, not a readable page; I only read text, HTML and JSON`, type };
}

export const MEDIA_HOST_LIST = MEDIA_HOSTS;
export const ALLOWED_CONTENT_TYPE_LIST = ALLOWED_CONTENT_TYPES;
