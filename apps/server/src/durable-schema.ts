/** Installed by the sole Store writer. Every receipt and its changes commit together. */
export async function initializeDurableConversations(query: (sql: string) => Promise<unknown>) {
  await query(`CREATE TABLE IF NOT EXISTS conversation_events (
    owner text NOT NULL, thread_id text NOT NULL, seq bigint NOT NULL, id text NOT NULL,
    data jsonb NOT NULL, PRIMARY KEY(owner,thread_id,seq), UNIQUE(owner,thread_id,id)
  )`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_conversation_event(event_owner text, event_thread text, event_id text, event_value jsonb)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved jsonb; next_seq bigint;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || event_owner,0));
      SELECT data INTO saved FROM conversation_events WHERE owner=event_owner AND thread_id=event_thread AND id=event_id;
      IF FOUND THEN RETURN saved; END IF;
      SELECT COALESCE(max(seq),0)+1 INTO next_seq FROM conversation_events WHERE owner=event_owner AND thread_id=event_thread;
      saved := event_value || jsonb_build_object('id',event_id,'threadId',event_thread,'seq',next_seq);
      INSERT INTO conversation_events(owner,thread_id,seq,id,data) VALUES(event_owner,event_thread,next_seq,event_id,saved);
      RETURN saved;
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_durable_mutation(mutation_owner text, receipt_id text, binding_hash text, mutations jsonb, events jsonb)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE previous jsonb; change jsonb; saved jsonb; result jsonb := '[]'::jsonb; event jsonb; journal jsonb := '[]'::jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || mutation_owner,0));
      SELECT data INTO previous FROM records WHERE owner=mutation_owner AND kind='mutation-receipts' AND id=receipt_id;
      IF FOUND THEN
        IF previous->>'bindingHash' <> binding_hash THEN RETURN jsonb_build_object('status','binding_conflict'); END IF;
        RETURN previous->'result' || jsonb_build_object('status','duplicate');
      END IF;
      FOR change IN SELECT value FROM jsonb_array_elements(mutations) LOOP
        SELECT data INTO saved FROM records WHERE owner=mutation_owner AND kind=change->>'kind' AND id=change->>'id' FOR UPDATE;
        IF (change->>'mode'='insert' AND FOUND) OR
           (change->>'mode'<>'insert' AND (NOT FOUND OR EXISTS (
             SELECT 1 FROM jsonb_each(COALESCE(change->'expected','{}'::jsonb)) field
             WHERE saved->field.key IS DISTINCT FROM field.value
           ))) THEN
          RETURN jsonb_build_object('status','revision_conflict');
        END IF;
      END LOOP;
      FOR change IN SELECT value FROM jsonb_array_elements(mutations) LOOP
        IF change->>'mode'='insert' THEN
          INSERT INTO records(owner,kind,id,data) VALUES(mutation_owner,change->>'kind',change->>'id',change->'value') RETURNING data INTO saved;
        ELSE
          UPDATE records SET data=CASE WHEN change->>'mode'='replace' THEN change->'value' ELSE data || (change->'value') END,updated_at=now()
          WHERE owner=mutation_owner AND kind=change->>'kind' AND id=change->>'id' RETURNING data INTO saved;
        END IF;
        result := result || jsonb_build_array(saved);
      END LOOP;
      FOR event IN SELECT value FROM jsonb_array_elements(events) LOOP
        journal := journal || jsonb_build_array(openmuse_conversation_event(mutation_owner,event->>'threadId',event->>'id',event));
      END LOOP;
      previous := jsonb_build_object('status','applied','values',result,'events',journal);
      INSERT INTO records(owner,kind,id,data) VALUES(mutation_owner,'mutation-receipts',receipt_id,jsonb_build_object('id',receipt_id,'bindingHash',binding_hash,'result',previous));
      RETURN previous;
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_thread_event(event_owner text, run_token text, event_value jsonb)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved jsonb; count_events integer;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || event_owner,0));
      UPDATE records AS run SET data=jsonb_set(data,'{events}',COALESCE(data->'events','[]'::jsonb) || jsonb_build_array(event_value)),updated_at=now()
      WHERE owner=event_owner AND kind='thread-runs' AND id=run_token AND data->>'status'='running' AND EXISTS (
        SELECT 1 FROM records thread WHERE thread.owner=run.owner AND thread.kind='threads' AND thread.id=run.data->>'threadId'
        AND thread.data->>'runToken'=run.id AND (thread.data->>'leaseUntil')::timestamptz>clock_timestamp()
      ) RETURNING data INTO saved;
      IF NOT FOUND THEN RAISE EXCEPTION 'Conversation run lease expired'; END IF;
      count_events := jsonb_array_length(saved->'events');
      PERFORM openmuse_conversation_event(event_owner,saved->>'threadId',run_token || ':' || count_events::text,
        jsonb_build_object('runId',saved->>'runId','origin','live','kind','agui','payload',event_value - 'input'));
      RETURN saved;
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_inbox_failure(event_owner text, message_id text, run_token text)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE saved jsonb; saved_thread jsonb; retryable boolean; failures integer; disposition jsonb; retry_at timestamptz;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || event_owner,0));
      SELECT data INTO saved_thread FROM records WHERE owner=event_owner AND kind='threads'
        AND data->>'runToken'=run_token FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
      SELECT data INTO saved FROM records WHERE owner=event_owner AND kind='conversation-inbox' AND id=message_id
        AND data->>'runId'=run_token AND data->>'status'='dispatching' FOR UPDATE;
      IF NOT FOUND OR saved->>'threadId' <> saved_thread->>'id' THEN RETURN false; END IF;
      PERFORM 1 FROM records WHERE owner=event_owner AND kind='thread-runs' AND data->>'runId'=run_token;
      retryable := NOT FOUND;
      failures := COALESCE((saved->>'dispatchFailures')::integer,0)+1;
      retry_at := clock_timestamp() + (LEAST(30000,250 * power(2,LEAST(failures-1,7)))::text || ' milliseconds')::interval;
      disposition := jsonb_build_object(
        'code',CASE WHEN retryable THEN 'RUN_NOT_STARTED' ELSE 'RUN_INTERRUPTED' END,
        'message',CASE WHEN retryable THEN 'Your message is saved, but the reply could not start. It will retry when storage is ready.'
          ELSE 'The reply could not start safely. Review the saved run before continuing; it will not be repeated automatically.' END,
        'retryable',retryable,'runId',run_token,'messageId',saved->>'messageId');
      UPDATE records SET data=data || jsonb_build_object('status',CASE WHEN retryable THEN 'accepted' ELSE 'interrupted' END,
        'dispatchFailures',failures,'retryAfter',CASE WHEN retryable THEN to_jsonb(retry_at) ELSE 'null'::jsonb END,
        'lastDeliveryError',disposition),updated_at=now()
        WHERE owner=event_owner AND kind='conversation-inbox' AND id=message_id;
      IF retryable THEN
        UPDATE records SET data=data || '{"runToken":null,"leaseUntil":null,"stopRunToken":null}'::jsonb,updated_at=now()
          WHERE owner=event_owner AND kind='threads' AND id=saved->>'threadId' AND data->>'runToken'=run_token;
      END IF;
      PERFORM openmuse_conversation_event(event_owner,saved->>'threadId','delivery-error:' || message_id || ':' || failures::text,
        jsonb_build_object('runId',run_token,'origin','live','kind','agui','payload',
          jsonb_build_object('type','CUSTOM','name','conversation_delivery_error','value',disposition)));
      RETURN true;
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_thread_recovery(event_owner text, event_thread text, run_token text, expected_events jsonb, run_patch jsonb)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE saved jsonb; event jsonb; event_number bigint;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || event_owner,0));
      UPDATE records AS run SET data=data || run_patch,updated_at=now()
      WHERE owner=event_owner AND kind='thread-runs' AND id=run_token AND data->>'threadId'=event_thread
      AND data->>'status'='running' AND data->'events'=expected_events AND NOT EXISTS (
        SELECT 1 FROM records thread WHERE thread.owner=run.owner AND thread.kind='threads' AND thread.id=event_thread
        AND thread.data->>'runToken'=run.id AND (thread.data->>'leaseUntil')::timestamptz>clock_timestamp()
      ) RETURNING data INTO saved;
      IF NOT FOUND THEN RETURN false; END IF;
      FOR event,event_number IN SELECT value,ordinality FROM jsonb_array_elements(saved->'events') WITH ORDINALITY LOOP
        PERFORM openmuse_conversation_event(event_owner,event_thread,run_token || ':' || event_number::text,
          jsonb_build_object('runId',saved->>'runId','origin','history','kind','agui','payload',event - 'input'));
      END LOOP;
      UPDATE records SET data=data || '{"runToken":null,"leaseUntil":null}'::jsonb,updated_at=now()
      WHERE owner=event_owner AND kind='threads' AND id=event_thread AND data->>'runToken'=run_token;
      RETURN true;
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_thread_publication(event_owner text, event_thread text, lease_token text, run_value jsonb)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE saved jsonb; event jsonb; event_number bigint;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || event_owner,0));
      SELECT data INTO saved FROM records WHERE owner=event_owner AND kind='threads' AND id=event_thread
      AND data->>'runToken'=lease_token AND (data->>'leaseUntil')::timestamptz>clock_timestamp() FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
      INSERT INTO records(owner,kind,id,data) VALUES(event_owner,'thread-runs',run_value->>'id',run_value)
      ON CONFLICT DO NOTHING RETURNING data INTO saved;
      IF NOT FOUND THEN RETURN false; END IF;
      FOR event,event_number IN SELECT value,ordinality FROM jsonb_array_elements(saved->'events') WITH ORDINALITY LOOP
        PERFORM openmuse_conversation_event(event_owner,event_thread,(run_value->>'id') || ':' || event_number::text,
          jsonb_build_object('runId',saved->>'runId','origin','task','kind','agui','payload',event - 'input'));
      END LOOP;
      UPDATE records SET data=data || '{"runToken":null,"leaseUntil":null}'::jsonb,updated_at=now()
      WHERE owner=event_owner AND kind='threads' AND id=event_thread AND data->>'runToken'=lease_token;
      RETURN true;
    END $$`);
}
