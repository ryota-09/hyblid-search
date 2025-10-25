import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const { query } = await req.json();
  console.log("Semantic search query:", query);

  const embeddingRes = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const queryEmbedding = embeddingRes.data[0].embedding;
  console.log("Query embedding generated, length:", queryEmbedding.length);

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: queryEmbedding,
  });

  console.log("Supabase response:", { data: data?.slice(0, 3), error });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ results: data });
}
