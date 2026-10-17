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

-- 읽기는 누구나. 먹은 기록·평가·가게는 누구나 쓰고, 취향(prefs)은 아래 함수로만 바뀜
create policy "lunch read"   on public.lunch_docs for select to anon, authenticated using (true);
create policy "lunch insert" on public.lunch_docs for insert to anon, authenticated with check (collection <> 'prefs');
create policy "lunch update" on public.lunch_docs for update to anon, authenticated using (collection <> 'prefs') with check (collection <> 'prefs');
create policy "lunch delete" on public.lunch_docs for delete to anon, authenticated using (collection <> 'prefs');

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

-- =====================================================================
-- 로그인: 이름 + "제일 좋아하는 음식"(비밀번호)
-- - 비밀번호는 암호화(bcrypt)해서 보관하고, 페이지에서는 이 표를 직접 볼 수 없음
-- - 5번 틀리면 10분 동안 잠김
-- - 비밀번호를 잊으면 Table Editor → lunch_secrets 에서 그 사람 줄을 지우면 초기화됨
-- =====================================================================
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.lunch_secrets (
  person_id    text primary key,
  secret_hash  text not null,
  fail_count   int not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.lunch_secrets enable row level security;  -- 정책이 없으니 페이지에서는 읽기·쓰기 모두 불가

-- 결과: 'new'(처음) | 'ok' | 'wrong' | 'locked' | 'invalid'
create or replace function public.lunch_check_secret(p_person text, p_secret text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r public.lunch_secrets%rowtype;
begin
  if p_person is null or p_person !~ '^[a-z0-9_-]{1,40}$'
     or p_secret is null or char_length(p_secret) not between 1 and 50 then
    return 'invalid';
  end if;

  select * into r from public.lunch_secrets where person_id = p_person;
  if not found then
    return 'new';
  end if;
  if r.locked_until is not null and r.locked_until > now() then
    return 'locked';
  end if;
  if r.secret_hash = crypt(p_secret, r.secret_hash) then
    update public.lunch_secrets set fail_count = 0, locked_until = null where person_id = p_person;
    return 'ok';
  end if;

  update public.lunch_secrets
     set fail_count   = case when fail_count + 1 >= 5 then 0 else fail_count + 1 end,
         locked_until = case when fail_count + 1 >= 5 then now() + interval '10 minutes' else null end
   where person_id = p_person;
  return 'wrong';
end;
$$;

-- 맞으면 취향을 저장. p_register = true(처음 로그인 화면)일 때만 새 비밀번호를 등록. 결과는 위와 같음
drop function if exists public.lunch_save_prefs(text, text, jsonb, jsonb);
create or replace function public.lunch_save_prefs(p_person text, p_secret text, p_likes jsonb, p_dislikes jsonb, p_register boolean default false)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v text;
begin
  if jsonb_typeof(p_likes) is distinct from 'array' or jsonb_typeof(p_dislikes) is distinct from 'array'
     or pg_column_size(p_likes) + pg_column_size(p_dislikes) > 6000 then
    return 'invalid';
  end if;

  v := public.lunch_check_secret(p_person, p_secret);
  if v = 'new' then
    if not p_register then
      return 'new';  -- 관리자가 초기화했거나 아직 등록 전
    end if;
    insert into public.lunch_secrets (person_id, secret_hash)
    values (p_person, crypt(p_secret, gen_salt('bf')))
    on conflict (person_id) do nothing;
    if not found then
      return 'wrong';  -- 같은 순간 다른 사람이 먼저 등록함
    end if;
  elsif v <> 'ok' then
    return v;
  end if;

  insert into public.lunch_docs (collection, id, data, updated_at)
  values ('prefs', p_person, jsonb_build_object('likes', p_likes, 'dislikes', p_dislikes), now())
  on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  return 'ok';
end;
$$;

revoke all on function public.lunch_check_secret(text, text) from public;
revoke all on function public.lunch_save_prefs(text, text, jsonb, jsonb, boolean) from public;
grant execute on function public.lunch_check_secret(text, text) to anon, authenticated;
grant execute on function public.lunch_save_prefs(text, text, jsonb, jsonb, boolean) to anon, authenticated;
