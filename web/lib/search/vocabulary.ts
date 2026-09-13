// The tag vocabulary (analysis/lockedgroove/analysis/tags.py VOCABULARY),
// mirrored so the query parser can recognize producer terms, plus the few
// synonyms producers type that the vocabulary spells differently. Tags in the
// database are written by the embed job from this same list.

export const TAG_VOCABULARY: readonly string[] = [
  // instruments
  "rhodes", "wurlitzer", "piano", "upright piano", "organ", "clavinet", "electric guitar", "acoustic guitar",
  "bass guitar", "upright bass", "synth bass", "808", "strings", "violin", "cello", "brass", "trumpet", "saxophone",
  "flute", "harp", "vibraphone", "marimba", "bells", "choir", "vocals", "vocal chop", "rap vocal", "female vocal",
  "male vocal", "humming", "whistle", "synth lead", "synth pad", "arpeggio", "pluck", "sitar", "kalimba", "steel drum",
  "accordion", "harmonica", "drum break", "drum machine", "kick", "snare", "hi-hat", "clap", "rimshot", "shaker",
  "tambourine", "congas", "bongos", "tabla", "timpani", "cymbal", "percussion loop", "beatbox",
  // genres and eras
  "soul", "funk", "jazz", "gospel", "blues", "hip hop", "boom bap", "trap", "drill", "lo-fi", "house", "techno",
  "disco", "reggae", "dub", "afrobeat", "latin", "bossa nova", "rock", "psychedelic", "library music", "film score",
  "sixties", "seventies", "eighties", "nineties",
  // texture and character
  "dusty", "warm", "vinyl crackle", "tape hiss", "lo-fi texture", "clean", "bright", "dark", "mellow", "aggressive",
  "distorted", "saturated", "filtered", "reverb heavy", "dry", "wide stereo", "mono", "ambient", "cinematic",
  "melancholic", "uplifting", "eerie", "sparse", "dense", "minor key", "major key", "slow", "fast", "swung",
  "straight", "loop", "one shot", "sample", "acapella", "instrumental", "intro", "breakdown", "riser", "fx",
];

/** Words producers type that map onto vocabulary tags. The typed word is kept as the tag; the expansion is what the database is asked for. */
export const TAG_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  horns: ["brass", "trumpet", "saxophone"],
  horn: ["brass", "trumpet", "saxophone"],
  sax: ["saxophone"],
  guitar: ["electric guitar", "acoustic guitar"],
  guitars: ["electric guitar", "acoustic guitar"],
  keys: ["piano", "rhodes", "wurlitzer", "organ", "clavinet"],
  vocal: ["vocals", "vocal chop", "female vocal", "male vocal"],
  vox: ["vocals", "vocal chop"],
  voice: ["vocals"],
  synth: ["synth lead", "synth pad", "synth bass"],
  synths: ["synth lead", "synth pad", "synth bass"],
  pad: ["synth pad"],
  pads: ["synth pad"],
  bass: ["bass guitar", "upright bass", "synth bass", "808"],
  break: ["drum break"],
  breaks: ["drum break"],
  drums: ["drum break", "drum machine", "kick", "snare", "hi-hat", "percussion loop"],
  percussion: ["percussion loop", "congas", "bongos", "shaker", "tambourine"],
  hats: ["hi-hat"],
  hihat: ["hi-hat"],
  crackle: ["vinyl crackle"],
  vinyl: ["vinyl crackle", "dusty"],
  lofi: ["lo-fi", "lo-fi texture"],
  "lo-fi": ["lo-fi", "lo-fi texture"],
  hiphop: ["hip hop"],
  "hip-hop": ["hip hop"],
  boombap: ["boom bap"],
  "boom-bap": ["boom bap"],
  wide: ["wide stereo"],
  reverb: ["reverb heavy"],
  wet: ["reverb heavy"],
  gritty: ["distorted", "saturated"],
  crunchy: ["distorted", "saturated"],
  chill: ["mellow"],
  sad: ["melancholic"],
  moody: ["melancholic", "dark"],
  happy: ["uplifting"],
  spooky: ["eerie"],
  '60s': ["sixties"],
  '70s': ["seventies"],
  '80s': ["eighties"],
  '90s': ["nineties"],
};

/** The tags that mean "has drums" (the same list the search RPCs use). */
export const DRUM_TAGS: readonly string[] = ["drums", "drum break", "drum machine", "kick", "snare", "hi-hat", "percussion loop"];

const vocabularySet = new Set(TAG_VOCABULARY);

export function isVocabularyTag(word: string): boolean {
  return vocabularySet.has(word.toLowerCase());
}

/** Tags the database should be asked for, given the words the producer typed. */
export function expandTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of tags) {
    const t = raw.toLowerCase().trim();
    if (!t) continue;
    if (vocabularySet.has(t)) out.add(t);
    for (const s of TAG_SYNONYMS[t] ?? []) out.add(s);
    if (!vocabularySet.has(t) && !TAG_SYNONYMS[t]) out.add(t);
  }
  return [...out];
}
