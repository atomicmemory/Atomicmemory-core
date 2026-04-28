import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

const envPath = ['.env.test', '.env']
  .map((file) => resolve(process.cwd(), file))
  .find((file) => existsSync(file));

if (envPath) {
  loadDotenv({ path: envPath, override: false });
}

process.env.OPENAI_API_KEY ??= 'test-openai-key';
process.env.DATABASE_URL ??= 'postgresql://atomicmem:atomicmem@localhost:5433/atomicmem_test';
process.env.EMBEDDING_DIMENSIONS ??= '1536';
