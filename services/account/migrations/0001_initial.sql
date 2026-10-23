create table users (
  id             text primary key,
  email          text unique not null,
  email_verified integer not null default 0,
  password_hash  text,
  google_sub     text unique,
  created_at     text not null,
  updated_at     text not null
);

create table login_requests (
  id             text primary key,
  redirect_uri   text not null,
  state          text not null,
  code_challenge text not null,
  expires_at     text not null
);

create table auth_codes (
  code_hash      text primary key,
  user_id        text not null references users(id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  expires_at     text not null,
  used_at        text
);

create table sessions (
  id           text primary key,
  user_id      text not null references users(id) on delete cascade,
  token_hash   text unique not null,
  created_at   text not null,
  revoked_at   text
);

create index sessions_by_user on sessions (user_id);
