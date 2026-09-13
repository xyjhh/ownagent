import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import type { AppConfig } from '../config/env.js'

export async function createPostgresCheckpointer(config: AppConfig) {
  const checkpointer = PostgresSaver.fromConnString(config.DATABASE_URL, {
    schema: config.SUPABASE_DB_SCHEMA,
  })
  await checkpointer.setup()
  return checkpointer
}
