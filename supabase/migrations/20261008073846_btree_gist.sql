-- Needed for the "no bus or person on two overlapping journeys" constraints (Phase C).
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
