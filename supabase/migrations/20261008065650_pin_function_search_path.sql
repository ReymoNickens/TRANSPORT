-- Pin search_path on every app function so a caller's search_path can never
-- redirect a name inside them (Supabase security advisor 0011). Every
-- reference inside these functions is already schema-qualified.
alter function app.uuid_v7() set search_path = '';
alter function app.current_organisation_id() set search_path = '';
alter function app.current_actor_id() set search_path = '';
alter function app.request_setting(text) set search_path = '';
alter function app.set_updated_at() set search_path = '';
alter function app.refuse_change() set search_path = '';
alter function app.refuse_delete() set search_path = '';
alter function app.mask(text) set search_path = '';
alter function app.settings_before_write() set search_path = '';
alter function app.write_audit(text, text, text, jsonb, jsonb, uuid) set search_path = '';
alter function app.audit_row_change() set search_path = '';
alter function app.user_permissions(uuid) set search_path = '';
alter function app.ensure_passenger(uuid, text) set search_path = '';
alter function app.create_organisation(text, text) set search_path = '';
