// The route-test kit. One import for a test:
//
//   import { createWorld, seedFile, post, params, call, USER_A, USER_B } from "@/lib/testing";
//
// What it can simulate: RLS by owner column on every table, unique
// constraints, PostgREST result shapes (single/maybeSingle, counts, column
// projection), the storage bucket policies (per-user prefixes, signed URLs),
// RPC dispatch, the auth surface, the compute dispatcher over a stubbed fetch,
// and the service-role client as a separate client with no RLS.
//
// What it cannot: SQL (joins, embedded selects, expressions), triggers beyond
// updated_at, foreign keys, concurrency, Realtime, and anything a live browser
// session would show (cookie refresh, tus uploads, range requests).

export { TestDb, testUuid, resetUuids, storagePolicy, type DbError, type Row } from "./db";
export { NOW, setNow, TABLES, tableMeta, type TableMeta } from "./schema";
export {
  anonClient,
  createTestClient,
  serviceClient,
  sessionClient,
  testUser,
  projection,
  type ClientOptions,
  type StorageCall,
  type TestSupabase,
} from "./supabase";
export { COMPUTE_URL, createWorld, activeWorld, jsonResponse, resetWorld, textResponse, USER_A, USER_B, World, type WorldOptions } from "./world";
export {
  sampleReport,
  seedBeatboxProfile,
  seedBreakdown,
  seedChop,
  seedComparison,
  seedConversation,
  seedFile,
  seedJob,
  seedLayer,
  seedLayerItem,
  seedLoop,
  seedMessage,
  seedMidi,
  seedProfile,
  seedRevoice,
  seedStem,
  seedUsageEvent,
} from "./rows";
export { BASE, body, call, del, get, jsonRequest, ndjson, params, patch, post, rawPost, type TestInit } from "./http";
