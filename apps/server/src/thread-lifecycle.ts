/** Transcript deletion shares the inbox writer lock so stale clients cannot revive a chat. */
export async function initializeThreadLifecycle(query: (sql: string) => Promise<unknown>) {
  await query(`CREATE OR REPLACE FUNCTION openmuse_delete_thread(event_owner text, event_thread text, next_main text)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE saved jsonb; main_id text; replacement text;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || event_owner,0));
      SELECT data INTO saved FROM records WHERE owner=event_owner AND kind='threads' AND id=event_thread FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
      IF saved->>'deletedAt' IS NOT NULL THEN
        RETURN jsonb_build_object('status','deleted','mainThreadId',saved->>'replacementMainThreadId');
      END IF;
      IF (saved->>'runToken' IS NOT NULL AND (saved->>'leaseUntil')::timestamptz>clock_timestamp())
        OR EXISTS(SELECT 1 FROM records WHERE owner=event_owner AND kind='conversation-inbox'
          AND data->>'threadId'=event_thread AND data->>'status' IN ('accepted','dispatching'))
        OR EXISTS(SELECT 1 FROM records WHERE owner=event_owner AND kind='tasks'
          AND data->>'originThreadId'=event_thread AND data->>'status' NOT IN ('succeeded','failed','cancelled')) THEN
        RETURN jsonb_build_object('status','busy');
      END IF;
      SELECT data->>'threadId' INTO main_id FROM records WHERE owner=event_owner AND kind='conversation-settings' AND id='main' FOR UPDATE;
      IF main_id=event_thread THEN
        replacement := next_main;
        UPDATE records SET data=data || jsonb_build_object('threadId',replacement,'existing',false),updated_at=now()
          WHERE owner=event_owner AND kind='conversation-settings' AND id='main';
      END IF;
      DELETE FROM thread_messages WHERE owner=event_owner AND thread_id=event_thread;
      DELETE FROM conversation_events WHERE owner=event_owner AND thread_id=event_thread;
      DELETE FROM records WHERE owner=event_owner AND kind IN ('thread-runs','conversation-inbox','task-mailbox','thread-publications') AND data->>'threadId'=event_thread;
      DELETE FROM records WHERE owner=event_owner AND kind IN ('interaction-requests','credential-requests') AND data->>'threadId'=event_thread;
      DELETE FROM records WHERE owner=event_owner AND kind IN ('integration-requests','service-credential-requests') AND data->'interaction'->>'threadId'=event_thread;
      DELETE FROM records WHERE owner=event_owner AND (
        (kind='jev_threads' AND id=event_thread)
        OR (kind='jev_panels' AND data->'panel'->>'threadId'=event_thread)
        OR (kind='jev_evidence' AND data->>'threadId'=event_thread)
        OR (kind='jev_mail_evidence' AND left(id,length(event_thread)+1)=event_thread || ':')
      );
      DELETE FROM records receipt WHERE owner=event_owner AND kind='mutation-receipts' AND (
        EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(receipt.data->'result'->'values','[]'::jsonb)) value WHERE value->>'threadId'=event_thread)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(receipt.data->'result'->'events','[]'::jsonb)) value WHERE value->>'threadId'=event_thread)
      );
      UPDATE records SET data=jsonb_build_object('id',event_thread,'archived',true,'deletedAt',clock_timestamp(),
        'replacementMainThreadId',replacement),updated_at=now()
        WHERE owner=event_owner AND kind='threads' AND id=event_thread;
      RETURN jsonb_build_object('status','deleted','mainThreadId',replacement);
    END $$`);
}
