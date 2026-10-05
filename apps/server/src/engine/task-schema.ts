/** Installed once by the sole database writer. Mailbox application, journal
 * dispatch and accumulated budgets are database transactions, not JS locks. */
export async function initializeTaskRuntime(query: (sql: string) => Promise<unknown>) {
  await query(`CREATE OR REPLACE FUNCTION openmuse_apply_task_mailbox(task_owner text, task_id text, run_token text)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE task jsonb; mail jsonb; status text; applied bigint; instructions jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || task_owner,0));
      SELECT data INTO task FROM records WHERE owner=task_owner AND kind='tasks' AND id=task_id FOR UPDATE;
      IF NOT FOUND THEN RETURN NULL; END IF;
      IF task->>'status' NOT IN ('succeeded','failed','cancelled') AND
        (task->>'status'<>'running' OR task->>'leaseId' IS DISTINCT FROM run_token OR (task->>'leaseUntil')::timestamptz<=clock_timestamp()) THEN RETURN NULL; END IF;
      applied := COALESCE((task->'state'->>'appliedMailboxSeq')::bigint,0);
      instructions := COALESCE(task->'state'->'directives','[]'::jsonb);
      FOR mail IN SELECT data FROM records WHERE owner=task_owner AND kind='task-mailbox' AND data->>'taskId'=task_id AND data->>'status'='received' ORDER BY (data->>'seq')::bigint FOR UPDATE LOOP
        status := CASE WHEN task->>'status' IN ('succeeded','failed','cancelled') THEN 'completed_before_apply' ELSE 'applied' END;
        mail := mail || jsonb_build_object('status',status);
        UPDATE records SET data=mail,updated_at=now() WHERE owner=task_owner AND kind='task-mailbox' AND id=mail->>'id';
        PERFORM openmuse_conversation_event(task_owner,mail->>'threadId',(mail->>'id') || ':' || status,
          jsonb_build_object('id',(mail->>'id') || ':' || status,'threadId',mail->>'threadId','origin','task','kind','directive','payload',mail));
        IF status='applied' THEN
          applied := GREATEST(applied,(mail->>'seq')::bigint);
          instructions := instructions || jsonb_build_array(jsonb_build_object('id',mail->>'id','revision',mail->'desiredRevision','text',mail->>'text','attachmentIds',mail->'attachmentIds','annotations',mail->'annotations'));
        END IF;
      END LOOP;
      IF task->>'status'='running' THEN
        UPDATE records SET data=jsonb_set(data,'{state}',COALESCE(data->'state','{}'::jsonb) || jsonb_build_object(
          'appliedRevision',COALESCE((data->'state'->>'desiredRevision')::bigint,0),'appliedMailboxSeq',applied,'directives',instructions)),updated_at=now()
          WHERE owner=task_owner AND kind='tasks' AND id=task_id RETURNING data INTO task;
      END IF;
      RETURN task;
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_task_valid_until(task_owner text, task_id text)
    RETURNS timestamptz LANGUAGE plpgsql AS $$
    DECLARE current_id text := task_id; seen text[] := ARRAY[]::text[]; task jsonb; deadline timestamptz; own_deadline timestamptz;
    BEGIN
      LOOP
        IF current_id=ANY(seen) OR cardinality(seen)>=128 THEN RETURN '-infinity'::timestamptz; END IF;
        seen := array_append(seen,current_id);
        SELECT data INTO task FROM records WHERE owner=task_owner AND kind='tasks' AND id=current_id FOR SHARE;
        IF NOT FOUND THEN RETURN '-infinity'::timestamptz; END IF;
        own_deadline := (task->'timing'->>'validUntil')::timestamptz;
        IF own_deadline IS NOT NULL AND (deadline IS NULL OR own_deadline<deadline) THEN deadline := own_deadline; END IF;
        current_id := task->'state'->>'parentTaskId';
        IF current_id IS NULL THEN RETURN deadline; END IF;
      END LOOP;
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_authorize_task_operation(task_owner text, operation_id text, expected_revision bigint, run_token text, handles jsonb, validate_only boolean DEFAULT false)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE op jsonb; task jsonb; lease jsonb; handle jsonb; paused boolean; disposition text; physical_reservation boolean; containment boolean; target jsonb; manual jsonb; device jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-runtime-control',0));
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || task_owner,0));
      SELECT data INTO op FROM records WHERE owner=task_owner AND kind='task-operations' AND id=operation_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('code','missing'); END IF;
      IF op->>'status'<>'queued' AND NOT (validate_only AND op->>'status' IN ('dispatching','running')) THEN RETURN jsonb_build_object('code','existing','operation',op); END IF;
      SELECT data INTO task FROM records WHERE owner=task_owner AND kind='tasks' AND id=op->>'taskId' FOR UPDATE;
      IF op->>'manualRequestId' IS NOT NULL THEN
        SELECT data INTO manual FROM records WHERE owner=task_owner AND kind='manual-executor-requests' AND id=op->>'manualRequestId' FOR SHARE;
        SELECT data INTO device FROM records WHERE owner='system' AND kind='device-sessions' AND id=manual->>'deviceId' FOR SHARE;
        IF manual IS NULL OR device IS NULL OR device->>'owner'<>task_owner OR device->>'revokedAt' IS NOT NULL THEN RETURN jsonb_build_object('code','lease_lost','operation',op); END IF;
      END IF;
      IF op->'nativeEnvelope'->>'kind'='cancel' AND op->>'targetOperationId' IS NOT NULL THEN
        SELECT data INTO target FROM records WHERE owner=task_owner AND kind='task-operations' AND id=op->>'targetOperationId' FOR SHARE;
        containment := target->>'taskId'=op->>'taskId' AND target->>'executorId'=op->>'executorId' AND target->>'resourceHoldTaskId'=op->>'resourceHoldTaskId' AND target->>'status' IN ('dispatching','running','outcome_unknown');
      END IF;
      physical_reservation := task->>'status' IN ('running','waiting_job') AND op->'nativeEnvelope' IS NOT NULL AND op->>'runToken'=run_token AND task->'state'->>'waitingComputerCommandId'=op->>'id' AND EXISTS(
        SELECT 1 FROM records WHERE owner='__runtime__' AND kind='work-admissions' AND id=op->>'taskId' AND data->>'hold'='true');
      SELECT COALESCE((data->>'paused')::boolean,false) INTO paused FROM records WHERE owner='__runtime__' AND kind='runtime-pause' AND id='global';
      disposition := CASE
        WHEN task IS NULL THEN 'lease_lost'
        WHEN NOT COALESCE(physical_reservation,false) AND NOT COALESCE(containment,false) AND (task->>'status'<>'running' OR task->>'leaseId' IS DISTINCT FROM run_token OR (task->>'leaseUntil')::timestamptz<=clock_timestamp()) THEN 'lease_lost'
        WHEN COALESCE(paused,false) AND op->>'effect'='true' THEN 'paused'
        WHEN NOT COALESCE(containment,false) AND (COALESCE((task->'state'->>'desiredRevision')::bigint,0)<>expected_revision OR COALESCE((task->'state'->>'appliedRevision')::bigint,0)<>expected_revision OR (op->>'revision')::bigint<>expected_revision) THEN 'superseded'
        WHEN op->>'effect'='true' AND openmuse_task_valid_until(task_owner,op->>'taskId')<=clock_timestamp() THEN 'expired'
        ELSE NULL END;
      IF disposition IS NULL THEN
        FOR handle IN SELECT value FROM jsonb_array_elements(handles) LOOP
          SELECT data INTO lease FROM records WHERE owner='__runtime__' AND kind='resource-leases' AND id=handle->>'id' FOR SHARE;
          IF NOT FOUND OR lease->>'owner'<>task_owner OR lease->>'taskId'<>COALESCE(op->>'resourceHoldTaskId',op->>'taskId') OR (lease->>'fence')::bigint<>(handle->>'fence')::bigint OR
            (lease->>'hold' IS DISTINCT FROM 'true' AND (lease->>'expiresAt')::timestamptz<=clock_timestamp()) THEN disposition := 'resource_lost'; EXIT; END IF;
          END LOOP;
        IF jsonb_array_length(COALESCE(op->'resourceLeaseIds','[]'::jsonb))>0 AND
          EXISTS(SELECT 1 FROM jsonb_array_elements_text(op->'resourceLeaseIds') expected(id) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(handles) supplied(value) WHERE supplied.value->>'id'=expected.id)) THEN disposition := 'resource_lost'; END IF;
      END IF;
      IF disposition IS NOT NULL THEN
        IF disposition IN ('superseded','expired') AND op->>'status'='queued' THEN
          UPDATE records SET data=data || jsonb_build_object('status',CASE WHEN disposition='superseded' THEN 'superseded' ELSE 'rejected_not_dispatched' END,'rejection',disposition),updated_at=now()
            WHERE owner=task_owner AND kind='task-operations' AND id=operation_id RETURNING data INTO op;
        END IF;
        RETURN jsonb_build_object('code',disposition,'operation',op);
      END IF;
      IF validate_only THEN RETURN jsonb_build_object('code','validated','operation',op); END IF;
      UPDATE records SET data=data || jsonb_build_object('status','dispatching','resourceLeaseIds',COALESCE((SELECT jsonb_agg(value->>'id') FROM jsonb_array_elements(handles)),'[]'::jsonb),'dispatchedAt',clock_timestamp()),updated_at=now()
        WHERE owner=task_owner AND kind='task-operations' AND id=operation_id RETURNING data INTO op;
      RETURN jsonb_build_object('code','authorized','operation',op);
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_guard_task_action(action_owner text, action_id text, validate_only boolean DEFAULT false)
    RETURNS text LANGUAGE plpgsql AS $$
    DECLARE proposal jsonb; task jsonb; paused boolean;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-runtime-control',0));
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || action_owner,0));
      SELECT data INTO proposal FROM records WHERE owner=action_owner AND kind='actions' AND id=action_id FOR UPDATE;
      IF NOT FOUND OR proposal->>'status'<>'executing' THEN RETURN 'missing'; END IF;
      SELECT COALESCE((data->>'paused')::boolean,false) INTO paused FROM records WHERE owner='__runtime__' AND kind='runtime-pause' AND id='global';
      IF COALESCE(paused,false) THEN RETURN 'paused'; END IF;
      IF proposal->>'taskId' IS NOT NULL THEN
        SELECT data INTO task FROM records WHERE owner=action_owner AND kind='tasks' AND id=proposal->>'taskId' FOR UPDATE;
        IF task IS NULL THEN RETURN 'lease_lost'; END IF;
        IF COALESCE((task->'state'->>'desiredRevision')::bigint,0)<>COALESCE((task->'state'->>'appliedRevision')::bigint,0) THEN RETURN 'superseded'; END IF;
        IF COALESCE((proposal->>'preparedRevision')::bigint,0)<>COALESCE((task->'state'->>'appliedRevision')::bigint,0) THEN RETURN 'superseded'; END IF;
        IF openmuse_task_valid_until(action_owner,proposal->>'taskId')<=clock_timestamp() THEN RETURN 'expired'; END IF;
        IF task->>'status' NOT IN ('running','waiting_approval') THEN RETURN 'lease_lost'; END IF;
      END IF;
      IF NOT validate_only THEN
        UPDATE records SET data=data || jsonb_build_object('dispatchedRevision',COALESCE((task->'state'->>'appliedRevision')::bigint,0),'dispatchedAt',clock_timestamp()),updated_at=now() WHERE owner=action_owner AND kind='actions' AND id=action_id;
      END IF;
      RETURN 'authorized';
    END $$`);
  // Retire the old automatic cap; explicitly extended budgets retain their revision.
  await query(`UPDATE records SET data=data || jsonb_build_object('maxSteps',NULL,'maxMilliseconds',NULL)
    WHERE kind='task-budgets' AND (data->>'revision')::bigint=0
      AND (data->>'maxSteps')::bigint=96 AND (data->>'maxMilliseconds')::bigint=21600000`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_consume_task_budget(budget_owner text, root_id text, elapsed_ms bigint)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE budget jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-budget:' || budget_owner || ':' || root_id,0));
      INSERT INTO records(owner,kind,id,data) VALUES(budget_owner,'task-budgets',root_id,
        jsonb_build_object('id',root_id,'revision',0,'maxSteps',NULL,'usedSteps',0,'maxMilliseconds',NULL,'usedMilliseconds',0)) ON CONFLICT DO NOTHING;
      SELECT data INTO budget FROM records WHERE owner=budget_owner AND kind='task-budgets' AND id=root_id FOR UPDATE;
      UPDATE records SET data=data || jsonb_build_object('usedMilliseconds',(data->>'usedMilliseconds')::bigint+GREATEST(0,elapsed_ms)),updated_at=now()
        WHERE owner=budget_owner AND kind='task-budgets' AND id=root_id RETURNING data INTO budget;
      IF (budget->>'usedSteps')::bigint >= (budget->>'maxSteps')::bigint OR (budget->>'usedMilliseconds')::bigint >= (budget->>'maxMilliseconds')::bigint THEN RETURN NULL; END IF;
      UPDATE records SET data=data || jsonb_build_object('usedSteps',(data->>'usedSteps')::bigint+1),updated_at=now()
        WHERE owner=budget_owner AND kind='task-budgets' AND id=root_id RETURNING data INTO budget;
      RETURN budget;
    END $$`);
  await query(`CREATE OR REPLACE FUNCTION openmuse_charge_task_budget(budget_owner text, root_id text, elapsed_ms bigint)
    RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE budget jsonb; BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-budget:' || budget_owner || ':' || root_id,0));
      UPDATE records SET data=data || jsonb_build_object('usedMilliseconds',(data->>'usedMilliseconds')::bigint+GREATEST(0,elapsed_ms)),updated_at=now()
        WHERE owner=budget_owner AND kind='task-budgets' AND id=root_id RETURNING data INTO budget;
      RETURN budget;
    END $$`);
}
