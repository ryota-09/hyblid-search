import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.local
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

async function updateEmbeddings() {
  console.log('Fetching documents...');
  const { data: documents, error } = await supabase
    .from('articles')
    .select('id, title, content');

  if (error) {
    console.error('Error fetching documents:', error);
    throw error;
  }

  console.log(`Found ${documents.length} documents. Updating embeddings...`);

  for (const doc of documents) {
    console.log(`Processing: ${doc.title}`);

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: doc.content ?? '',
    });

    const embedding = embeddingResponse.data[0].embedding;

    const { error: updateError } = await supabase
      .from('articles')
      .update({ embedding })
      .eq('id', doc.id);

    if (updateError) {
      console.error(`Error updating ${doc.title}:`, updateError);
    } else {
      console.log(`✓ Updated ${doc.title}`);
    }
  }

  console.log('All embeddings updated successfully!');
}

updateEmbeddings().catch(console.error);
