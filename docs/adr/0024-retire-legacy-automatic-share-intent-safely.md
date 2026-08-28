# Retire legacy automatic Share intent safely

The upgrade retires `agent_pipeline.auto_send_notion` as an authorization source,
so its previous value can never create a new Share Action. Pending automatic
deliveries that have not started lose their Share intent while transcription and
summary continue; started, unknown, and completed deliveries retain their audit
state, remain fenced where necessary, and are never automatically retried.
