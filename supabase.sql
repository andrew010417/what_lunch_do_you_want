-- =====================================================================
-- BioNexus 점심 고르기: Supabase 공유 저장소 설정
-- Supabase 대시보드 → SQL Editor → New query 에 전부 붙여 넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- =====================================================================

-- 페이지의 모든 공유 기록(취향 수정, 먹은 기록·평가, 저장한 가게)을 담는 표
create table if not exists public.lunch_docs (
  collection text not null,
  id         text not null check (char_length(id) between 1 and 100),
  data       jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 8000),
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

-- 담을 수 있는 기록 종류 (예전 버전에서 만든 표도 새 종류를 담을 수 있게 다시 정함)
--   people: 가입한 사람 / prefs: 취향 / days: 먹은 기록·평가·날씨 / restaurants: 저장한 가게
--   checkins: 오늘 어느 사무실에서 먹는지(출석 체크) / requests: 메뉴 추가 요청 / ratings: 각자 남긴 별점
alter table public.lunch_docs drop constraint if exists lunch_docs_collection_check;
alter table public.lunch_docs add constraint lunch_docs_collection_check
  check (collection in ('people', 'prefs', 'days', 'restaurants', 'checkins', 'requests', 'ratings'));

-- 같은 이름으로 두 번 가입하지 못하게
create unique index if not exists lunch_people_name_unique
  on public.lunch_docs (lower(data->>'name')) where collection = 'people';

-- 로그인 없이 페이지에서 읽고 쓸 수 있도록 허용 (표 하나에만 적용)
alter table public.lunch_docs enable row level security;

drop policy if exists "lunch read"   on public.lunch_docs;
drop policy if exists "lunch insert" on public.lunch_docs;
drop policy if exists "lunch update" on public.lunch_docs;
drop policy if exists "lunch delete" on public.lunch_docs;

-- 읽기는 누구나. 먹은 기록·가게·출석·메뉴 요청·별점은 누구나 쓰고, 사람(people)과 취향(prefs)은 아래 함수로만 바뀜
create policy "lunch read"   on public.lunch_docs for select to anon, authenticated using (true);
create policy "lunch insert" on public.lunch_docs for insert to anon, authenticated
  with check (collection in ('days', 'restaurants', 'checkins', 'requests', 'ratings'));
create policy "lunch update" on public.lunch_docs for update to anon, authenticated
  using (collection in ('days', 'restaurants', 'checkins', 'requests', 'ratings'))
  with check (collection in ('days', 'restaurants', 'checkins', 'requests', 'ratings'));
create policy "lunch delete" on public.lunch_docs for delete to anon, authenticated
  using (collection in ('days', 'restaurants', 'checkins', 'requests', 'ratings'));

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
-- 가입·로그인: 이름 + 주 사무실 + "제일 좋아하는 음식"(비밀번호)
-- - 비밀번호는 암호화(bcrypt)해서 보관하고, 페이지에서는 이 표를 직접 볼 수 없음
-- - 5번 틀리면 10분 동안 잠김
-- - 비밀번호를 잊으면 Table Editor → lunch_secrets 에서 그 사람 줄을 지우면,
--   다음 로그인 때 새 음식으로 다시 정할 수 있음
-- - 사람을 아예 지우려면 lunch_docs 에서 그 사람 id 의 people·prefs 줄과 lunch_secrets 줄을 지움
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
drop function if exists public.lunch_save_prefs(text, text, jsonb, jsonb, boolean);
create or replace function public.lunch_save_prefs(p_person text, p_secret text, p_likes jsonb, p_dislikes jsonb,
                                                   p_register boolean default false, p_office text default null)
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
  if not exists (select 1 from public.lunch_docs where collection = 'people' and id = p_person) then
    return 'invalid';  -- 가입하지 않은 사람
  end if;

  if v = 'new' then
    if not p_register then
      return 'new';  -- 관리자가 비밀번호를 초기화함
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

  if p_office is not null and p_office ~ '^[a-z0-9_-]{1,30}$' then
    update public.lunch_docs
       set data = jsonb_set(data, '{office}', to_jsonb(p_office)), updated_at = now()
     where collection = 'people' and id = p_person;
  end if;
  return 'ok';
end;
$$;

-- 가입: 성공하면 새 사람 id('u' + 12자리), 아니면 'taken'(같은 이름 있음) | 'invalid'
create or replace function public.lunch_register(p_name text, p_office text, p_secret text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id   text := 'u' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
  v_name text := btrim(p_name);
begin
  if v_name is null or char_length(v_name) not between 1 and 20
     or p_office is null or p_office !~ '^[a-z0-9_-]{1,30}$'
     or p_secret is null or char_length(p_secret) not between 1 and 50 then
    return 'invalid';
  end if;
  if exists (select 1 from public.lunch_docs where collection = 'people' and lower(data->>'name') = lower(v_name)) then
    return 'taken';
  end if;

  insert into public.lunch_docs (collection, id, data)
  values ('people', v_id, jsonb_build_object('name', v_name, 'office', p_office));
  insert into public.lunch_secrets (person_id, secret_hash) values (v_id, crypt(p_secret, gen_salt('bf')));
  insert into public.lunch_docs (collection, id, data)
  values ('prefs', v_id, jsonb_build_object('likes', '[]'::jsonb, 'dislikes', '[]'::jsonb));
  return v_id;
exception when unique_violation then
  return 'taken';  -- 같은 순간 같은 이름으로 가입
end;
$$;

-- 예전 버전(이름이 미리 들어 있던 때)에 저장한 취향·비밀번호 정리
delete from public.lunch_docs
 where collection = 'prefs' and id !~ '^u[0-9a-f]{12}$';
delete from public.lunch_secrets
 where person_id !~ '^u[0-9a-f]{12}$';

revoke all on function public.lunch_check_secret(text, text) from public;
revoke all on function public.lunch_save_prefs(text, text, jsonb, jsonb, boolean, text) from public;
revoke all on function public.lunch_register(text, text, text) from public;
grant execute on function public.lunch_check_secret(text, text) to anon, authenticated;
grant execute on function public.lunch_save_prefs(text, text, jsonb, jsonb, boolean, text) to anon, authenticated;
grant execute on function public.lunch_register(text, text, text) to anon, authenticated;
