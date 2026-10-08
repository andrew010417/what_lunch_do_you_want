-- =====================================================================
-- BioNexus 점심 고르기: Supabase 공유 저장소 설정
-- Supabase 대시보드 → SQL Editor → New query 에 전부 붙여 넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- =====================================================================

-- 페이지의 모든 공유 기록(취향 수정, 먹은 기록·평가, 저장한 가게)을 담는 표
create table if not exists public.lunch_docs (
  collection text not null check (collection in ('prefs', 'days', 'restaurants')),
  id         text not null check (char_length(id) between 1 and 100),
  data       jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 8000),
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

-- 로그인 없이 페이지에서 읽고 쓸 수 있도록 허용 (표 하나에만 적용)
alter table public.lunch_docs enable row level security;

drop policy if exists "lunch read"   on public.lunch_docs;
drop policy if exists "lunch insert" on public.lunch_docs;
drop policy if exists "lunch update" on public.lunch_docs;
drop policy if exists "lunch delete" on public.lunch_docs;

create policy "lunch read"   on public.lunch_docs for select to anon, authenticated using (true);
create policy "lunch insert" on public.lunch_docs for insert to anon, authenticated with check (true);
create policy "lunch update" on public.lunch_docs for update to anon, authenticated using (true) with check (true);
create policy "lunch delete" on public.lunch_docs for delete to anon, authenticated using (true);

-- 다른 사람이 저장하면 내 화면에도 바로 반영되도록 실시간 알림 켜기
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lunch_docs'
  ) then
    alter publication supabase_realtime add table public.lunch_docs;
  end if;
end $$;
