-- Separation quality on the stem, and source bandwidth on the file.
--
-- A weak separator measured on a real upload threw away 17.6 dB of 8-20 kHz
-- energy that a strong one preserved exactly. Nothing downstream could undo it:
-- the layer, the EQ and the producer's opinion of the whole system all inherited
-- the loss. So a stem now carries the evidence of how it was made, and a claim
-- built on that stem can say how far to trust it.
--
--   model              already existed: which model ran, '<model>-fake' for the
--                      development stand-in
--   model_family       the family it belongs to, for grouping and for policy
--   model_tier         reference > strong > baseline > weak > stand_in
--   model_sdr          the published SDR, or null when its author published none
--   model_sdr_basis    what that number is and where it came from - never a bare
--                      figure with no provenance
--   is_stand_in        true when no separation actually happened
--   quality_confidence [0, 1] from the tier; feeds the narration's hedge bands
--                      directly (>= 0.8 states it plainly, < 0.4 is "I can't tell")
--   quality_note       one sentence a producer can read
--
-- Rows written before this migration have null in every new column. That means
-- "unknown", not "fine": treat a null tier as untrusted, the same as 'weak'.
--
-- NOT APPLIED by the agent that wrote it: run it with the Supabase CLI.

alter table public.stems
  add column if not exists model_family      text,
  add column if not exists model_tier        text,
  add column if not exists model_sdr         real,
  add column if not exists model_sdr_basis   text,
  add column if not exists is_stand_in       boolean not null default false,
  add column if not exists quality_confidence real,
  add column if not exists quality_note      text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stems_model_tier_check') then
    alter table public.stems add constraint stems_model_tier_check
      check (model_tier is null or model_tier in ('reference', 'strong', 'baseline', 'weak', 'stand_in'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stems_quality_confidence_check') then
    alter table public.stems add constraint stems_quality_confidence_check
      check (quality_confidence is null or (quality_confidence >= 0 and quality_confidence <= 1));
  end if;
end $$;

comment on column public.stems.model_tier is
  'reference > strong > baseline > weak > stand_in. Null means the row predates the quality columns; treat it as untrusted.';
comment on column public.stems.model_sdr is
  'Published SDR for the model that ran, or null when none is published. See model_sdr_basis for what the number is.';
comment on column public.stems.is_stand_in is
  'True when the band-split development stand-in produced this row and no separation actually happened.';

-- "the stems in this file I can build a claim on", which is the only query the
-- narration and the loop finder need from these columns.
create index if not exists stems_trustworthy_idx
  on public.stems (file_id, stem)
  where is_stand_in = false and model_tier in ('reference', 'strong');

-- Source fidelity. The analyze job writes it into the report at
-- `report -> 'spectral' -> 'bandwidth'` as {value, confidence, method, notes};
-- `value` is the highest frequency in Hz still carrying real energy, measured on
-- the upload rather than on the 22.05 kHz analysis copy (whose own ceiling is
-- 11 kHz and would make every answer the same wrong number).
--
-- The queries this serves: "which of my records still have their top end", and
-- "is this flip dark because of the record or because of us".
create index if not exists files_report_bandwidth_idx
  on public.files (user_id, ((report -> 'spectral' -> 'bandwidth' ->> 'value')::numeric));

comment on index public.files_report_bandwidth_idx is
  'True bandwidth of the upload in Hz (report.spectral.bandwidth.value); the real uploads measured 12.0-15.7 kHz.';
