-- 乐学园晚托作业辅导工作台 · Supabase 建表脚本
-- 用法：在 Supabase 左侧菜单点「SQL Editor」(图标 </>)，新建一个查询，
--       把下面全部内容粘贴进去，点右上角「Run」执行一次即可。

-- 1) 四张数据表（每张表：id 主键 + data 存整条记录 + updated_at 时间戳）
create table if not exists students (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists homework (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists followups (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists exams (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);

-- 2) 开启行级安全（RLS）
alter table students enable row level security;
alter table homework enable row level security;
alter table followups enable row level security;
alter table exams enable row level security;

-- 3) 允许前端（anon 角色，即公开 anon key）读写这四张表
grant usage on schema public to anon;
grant select, insert, update, delete on students, homework, followups, exams to anon;

do $$
declare t text;
begin
  foreach t in array array['students','homework','followups','exams'] loop
    execute format('drop policy if exists "anon_all" on %I', t);
    execute format('create policy "anon_all" on %I for all to anon using (true) with check (true)', t);
  end loop;
end $$;

-- 执行完成后会显示「Success. No rows returned」，即表示建表成功。
