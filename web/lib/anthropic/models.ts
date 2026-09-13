// Model ids, in one place (OPEN_QUESTIONS E.21). Chat turns and the hybrid
// search parser both run on Opus 5 today; the parser is the one the owner may
// move to `claude-sonnet-5` for cost, which is a one-line change here.

export const CHAT_MODEL = "claude-opus-5";
export const QUERY_PARSER_MODEL = "claude-opus-5";

/** Output budget for a streamed chat turn (streaming, so a large cap is safe). */
export const CHAT_MAX_TOKENS = 64_000;
/** The parser returns one small JSON object. */
export const QUERY_PARSER_MAX_TOKENS = 2_000;
