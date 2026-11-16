-- Deneme Analiz: soru kayıtlarını istemci form satırlarıyla güvenilir eşleştirmek için zararsız şema güncellemesi.
begin;
alter table public.da_questions add column if not exists client_ref text;
create unique index if not exists da_questions_exam_client_ref_unique
  on public.da_questions (exam_id, client_ref)
  where client_ref is not null;
commit;
