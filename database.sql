-- Aplicación independiente de votaciones para juntas de propietarios.
-- Ejecutar completo en Supabase > SQL Editor.
-- Si ya tenías la base creada, puedes volver a ejecutarlo: es idempotente y no borra datos.
create extension if not exists pgcrypto;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.voting_meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  status text not null default 'setup' check (status in ('setup','open','closed')),
  created_at timestamptz not null default now()
);

create table if not exists public.voting_codes (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.voting_meetings(id) on delete cascade,
  code text not null,
  label text not null,
  -- Peso legado: solo se usa si el código todavía no tiene unidades cargadas.
  weight numeric(12,6) not null default 0 check (weight >= 0),
  max_votes integer not null default 1 check (max_votes >= 1),
  created_at timestamptz not null default now(),
  unique (meeting_id, code)
);

create table if not exists public.voting_units (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.voting_meetings(id) on delete cascade,
  unit_code text not null,
  label text not null,
  weight numeric(12,6) not null check (weight >= 0),
  code_id uuid references public.voting_codes(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (meeting_id, unit_code)
);

-- Permite que los códigos creados con la versión anterior sigan funcionando
-- hasta que se les carguen unidades.
alter table public.voting_codes alter column weight set default 0;

create table if not exists public.voting_questions (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.voting_meetings(id) on delete cascade,
  question_text text not null,
  options jsonb not null,
  status text not null default 'draft' check (status in ('draft','active','closed')),
  position integer not null default 1,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 10)
);

create table if not exists public.voting_ballots (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.voting_questions(id) on delete cascade,
  code_id uuid not null references public.voting_codes(id) on delete restrict,
  choice_index integer not null check (choice_index >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_voting_codes_meeting on public.voting_codes(meeting_id);
create index if not exists idx_voting_units_meeting on public.voting_units(meeting_id);
create index if not exists idx_voting_units_code on public.voting_units(code_id);
create index if not exists idx_voting_questions_meeting on public.voting_questions(meeting_id);
create index if not exists idx_voting_ballots_question_code on public.voting_ballots(question_id, code_id);
create unique index if not exists one_active_question_per_meeting
  on public.voting_questions(meeting_id) where status = 'active';

create or replace function public.is_voting_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

alter table public.admin_users enable row level security;
alter table public.voting_meetings enable row level security;
alter table public.voting_codes enable row level security;
alter table public.voting_units enable row level security;
alter table public.voting_questions enable row level security;
alter table public.voting_ballots enable row level security;

drop policy if exists "admin can read own admin row" on public.admin_users;
create policy "admin can read own admin row" on public.admin_users
for select to authenticated using (user_id = auth.uid());

drop policy if exists "admins manage meetings" on public.voting_meetings;
create policy "admins manage meetings" on public.voting_meetings
for all to authenticated using (public.is_voting_admin()) with check (public.is_voting_admin());

drop policy if exists "admins manage codes" on public.voting_codes;
create policy "admins manage codes" on public.voting_codes
for all to authenticated using (public.is_voting_admin()) with check (public.is_voting_admin());

drop policy if exists "admins manage units" on public.voting_units;
create policy "admins manage units" on public.voting_units
for all to authenticated using (public.is_voting_admin()) with check (public.is_voting_admin());

drop policy if exists "admins manage questions" on public.voting_questions;
create policy "admins manage questions" on public.voting_questions
for all to authenticated using (public.is_voting_admin()) with check (public.is_voting_admin());

drop policy if exists "admins read ballots" on public.voting_ballots;
create policy "admins read ballots" on public.voting_ballots
for select to authenticated using (public.is_voting_admin());

create or replace function public.get_active_question(p_code text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_code public.voting_codes%rowtype;
  v_question public.voting_questions%rowtype;
  v_count integer;
  v_total_units integer;
  v_active_units integer;
  v_weight numeric;
begin
  select * into v_code from public.voting_codes
  where upper(code) = upper(trim(p_code))
  for update;
  if not found then raise exception 'Código no válido'; end if;

  select count(*)::integer,
         (count(*) filter (where active))::integer,
         coalesce(sum(weight) filter (where active), 0)
    into v_total_units, v_active_units, v_weight
  from public.voting_units
  where code_id = v_code.id;

  if v_total_units = 0 then
    -- Códigos creados con la versión anterior, todavía sin unidades cargadas.
    if v_code.weight <= 0 then
      raise exception 'Este código no tiene unidades habilitadas para votar';
    end if;
    v_weight := v_code.weight;
    v_active_units := 1;
  elsif v_active_units = 0 then
    raise exception 'Este código no tiene unidades habilitadas para votar';
  end if;

  select * into v_question from public.voting_questions
  where meeting_id = v_code.meeting_id and status = 'active'
  order by position desc limit 1;
  if not found then raise exception 'No hay una votación activa'; end if;

  select count(*) into v_count from public.voting_ballots
  where question_id = v_question.id and code_id = v_code.id;
  if v_count >= v_code.max_votes then
    raise exception 'Este código ya alcanzó el máximo de votos permitido';
  end if;

  return jsonb_build_object(
    'question_id', v_question.id,
    'question', v_question.question_text,
    'options', v_question.options,
    'remaining_votes', v_code.max_votes - v_count,
    'weight', v_weight,
    'units', v_active_units
  );
end;
$$;

create or replace function public.submit_vote(p_code text, p_choice_index integer)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_code public.voting_codes%rowtype;
  v_question public.voting_questions%rowtype;
  v_count integer;
  v_option_count integer;
  v_total_units integer;
  v_active_units integer;
begin
  select * into v_code from public.voting_codes
  where upper(code) = upper(trim(p_code))
  for update;
  if not found then raise exception 'Código no válido'; end if;

  select count(*)::integer, (count(*) filter (where active))::integer
    into v_total_units, v_active_units
  from public.voting_units
  where code_id = v_code.id;
  if (v_total_units = 0 and v_code.weight <= 0) or (v_total_units > 0 and v_active_units = 0) then
    raise exception 'Este código no tiene unidades habilitadas para votar';
  end if;

  select * into v_question from public.voting_questions
  where meeting_id = v_code.meeting_id and status = 'active'
  order by position desc limit 1;
  if not found then raise exception 'La votación no está activa'; end if;

  v_option_count := jsonb_array_length(v_question.options);
  if p_choice_index < 0 or p_choice_index >= v_option_count then
    raise exception 'Opción no válida';
  end if;

  select count(*) into v_count from public.voting_ballots
  where question_id = v_question.id and code_id = v_code.id;

  if v_count >= v_code.max_votes then
    raise exception 'Este código ya alcanzó el máximo de votos permitido';
  end if;

  insert into public.voting_ballots(question_id, code_id, choice_index)
  values (v_question.id, v_code.id, p_choice_index);

  return jsonb_build_object('ok', true, 'message', 'Voto registrado');
end;
$$;

create or replace function public.get_voting_results(p_question_id uuid)
returns table (
  choice_index integer,
  option_label text,
  ballots integer,
  weighted_percentage numeric
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_voting_admin() then
    raise exception 'Acceso no autorizado';
  end if;

  return query
  with code_weights as (
    select c.id as code_id,
           case
             when count(u.id) = 0 then c.weight
             else coalesce(sum(u.weight) filter (where u.active), 0)
           end as weight
    from public.voting_codes c
    left join public.voting_units u on u.code_id = c.id
    group by c.id, c.weight
  ),
  ballot_counts as (
    select b.code_id, count(*)::integer as n
    from public.voting_ballots b
    where b.question_id = p_question_id
    group by b.code_id
  ),
  weighted as (
    select b.choice_index,
           sum(cw.weight / bc.n)::numeric as total_weight,
           count(*)::integer as n_ballots
    from public.voting_ballots b
    join ballot_counts bc on bc.code_id = b.code_id
    join code_weights cw on cw.code_id = b.code_id
    where b.question_id = p_question_id
    group by b.choice_index
  ),
  opts as (
    select (e.ordinality - 1)::integer as idx, e.value #>> '{}' as label
    from public.voting_questions q,
         jsonb_array_elements(q.options) with ordinality as e(value, ordinality)
    where q.id = p_question_id
  )
  select o.idx, o.label, coalesce(w.n_ballots,0),
         coalesce(w.total_weight,0)::numeric
  from opts o
  left join weighted w on w.choice_index = o.idx
  order by o.idx;
end;
$$;

grant usage on schema public to anon, authenticated;
grant select on public.admin_users to authenticated;
grant select, insert, update, delete on public.voting_meetings, public.voting_codes, public.voting_units, public.voting_questions to authenticated;
grant select on public.voting_ballots to authenticated;
grant execute on function public.get_active_question(text) to anon, authenticated;
grant execute on function public.submit_vote(text, integer) to anon, authenticated;
grant execute on function public.get_voting_results(uuid) to authenticated;

-- Después de crear el usuario administrador en Authentication > Users,
-- copia su UUID y ejecuta:
-- insert into public.admin_users(user_id) values ('UUID-DEL-ADMIN');
