# slskd owns workflow state

The CLI will be a thin, deterministic interface over one configured slskd instance: slskd remains the sole authority for search and transfer state, while agents orchestrate multi-step workflows by querying it. We deliberately reject a CLI-owned workflow-run database to avoid duplicated, inconsistent state and to keep workflows resumable through slskd itself.
