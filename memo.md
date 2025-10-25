# Next.js + Supabase + OpenAIでハイブリッド検索を実装する完全ガイド

## 目次

1. [概要](#概要)
2. [技術構成](#技術構成)
3. [Supabaseのセットアップ](#supabaseのセットアップ)
4. [Next.jsアプリケーションの実装](#nextjsアプリケーションの実装)
5. [試行錯誤と解決した問題](#試行錯誤と解決した問題)
6. [動作確認](#動作確認)
7. [まとめ](#まとめ)

---

## 概要

### ハイブリッド検索とは？

このプロジェクトでは、**全文検索**と**セマンティック検索**を組み合わせたハイブリッド検索を実装します。

- **全文検索（即時返答）**: PostgreSQLの`tsvector`とGINインデックスを使い、瞬時にキーワードマッチした結果を表示
- **セマンティック検索（後追い）**: OpenAIのembedding APIで意味的類似度を計算し、より関連性の高い結果を追加表示

### アーキテクチャ

```
ユーザー入力
    ↓
[並列リクエスト]
    ├─→ 全文検索API → PostgreSQL全文検索 → 即座に表示
    └─→ セマンティック検索API → OpenAI Embedding → pgvector類似度検索 → 後から表示
```

---

## 技術構成

### フロントエンド

- **Next.js 16** (App Router)
- **React 19**
- **SWR** - データフェッチングとキャッシング
- **Tailwind CSS** - スタイリング

### バックエンド・データベース

- **Supabase** (PostgreSQL + pgvector)
- **OpenAI API** (text-embedding-3-small)

### 主要ライブラリ

```json
{
  "@supabase/supabase-js": "^2.76.1",
  "openai": "^6.7.0",
  "swr": "^2.3.6",
  "next": "16.0.0"
}
```

---

## Supabaseのセットアップ

### 1. 拡張機能の有効化

Supabaseダッシュボードで`pgvector`を有効化します。

1. Supabaseプロジェクトにログイン
2. **Database** → **Extensions**
3. `vector`を検索してONにする

### 2. テーブル作成

```sql
-- pgvector拡張を有効化
create extension if not exists vector;

-- 記事テーブルを作成
create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  title text,
  content text,
  embedding vector(1536) -- OpenAI text-embedding-3-smallの次元数
);

-- 全文検索用のtsvectorカラムを追加
alter table articles add column if not exists search_tsv tsvector;
```

### 3. 全文検索用トリガーの設定

```sql
-- tsvectorを自動更新するトリガー関数
create or replace function articles_tsv_trigger() returns trigger as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('simple', coalesce(new.title,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.content,'')), 'B');
  return new;
end
$$ language plpgsql;

-- トリガーを作成
drop trigger if exists tsv_update on articles;
create trigger tsv_update
before insert or update on articles
for each row execute procedure articles_tsv_trigger();
```

> **重要**: `to_tsvector('simple', ...)`の`simple`を使います。日本語の場合、`japanese`設定は標準では利用できないためエラーになります。

### 4. インデックスの作成

```sql
-- 全文検索用GINインデックス
create index if not exists idx_articles_tsv
  on articles using gin(search_tsv);

-- ベクトル検索用IVFFlatインデックス
create index if not exists idx_articles_embedding
  on articles using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
```

### 5. ハイブリッド検索関数の作成

```sql
create or replace function public.hybrid_search(
  query_text text,
  query_embedding vector(1536)
) returns table(
  id uuid,
  title text,
  content text,
  hybrid_score double precision
)
language sql as $$
  select
    id,
    title,
    content,
    (
      0.6 * ts_rank_cd(search_tsv, plainto_tsquery('simple', query_text))
      + 0.4 * coalesce(1 - (embedding <=> query_embedding), 0)
    ) as hybrid_score
  from articles
  order by hybrid_score desc
  limit 10;
$$;
```

**スコアの重み付け:**
- 全文検索: 60%
- ベクトル類似度: 40%
- `coalesce`でembeddingがnullの場合も対応

### 6. Row Level Security (RLS)

```sql
-- RLSを有効化
alter table articles enable row level security;

-- 読み取り専用ポリシー（匿名ユーザーでも閲覧可能）
create policy "read public articles"
on articles
for select
to public
using (true);
```

> **注意**: 書き込みはサービスロールキーが必要です。クライアントからは更新させません。

---

## Next.jsアプリケーションの実装

### プロジェクト構造

```
hyblid-search/
├── app/
│   ├── api/
│   │   └── search/
│   │       ├── fulltext/route.ts    # 全文検索API
│   │       └── semantic/route.ts    # セマンティック検索API
│   ├── search/
│   │   └── page.tsx                 # 検索UI
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   └── fetchers.ts                  # SWR用フェッチャー
├── scripts/
│   └── update-embeddings.ts         # embedding更新スクリプト
└── .env.local                       # 環境変数
```

### 環境変数の設定

`.env.local`を作成:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENAI_API_KEY=sk-your-openai-api-key
```

### 1. 全文検索API

**`app/api/search/fulltext/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: NextRequest) {
  const { query } = await req.json();

  // Supabaseの全文検索機能を使用
  const { data, error } = await supabase
    .from("articles")
    .select("*")
    .textSearch("content", query, {
      type: "websearch",
      config: "simple"
    })
    .limit(10);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ results: data });
}
```

### 2. セマンティック検索API

**`app/api/search/semantic/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // RPC呼び出しにはサービスロールキーが必要
);

export async function POST(req: NextRequest) {
  const { query } = await req.json();

  // OpenAI APIでクエリをembeddingに変換
  const embeddingRes = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const queryEmbedding = embeddingRes.data[0].embedding;

  // Supabaseのハイブリッド検索関数を呼び出し
  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: queryEmbedding,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ results: data });
}
```

### 3. フェッチャー関数

**`lib/fetchers.ts`**

```typescript
export async function postFetcher(url: string, { arg }: { arg: unknown }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(arg),
    cache: "no-store", // Next.jsのキャッシュを無効化
  });
  if (!res.ok) throw new Error("API error");
  return res.json();
}
```

### 4. 検索UI

**`app/search/page.tsx`**

```typescript
"use client";

import { useState } from "react";
import useSWRMutation from "swr/mutation";
import { postFetcher } from "@/lib/fetchers";

type Article = { id: string; title: string; content: string };

export default function SearchPage() {
  const [query, setQuery] = useState("");

  // 全文検索用のSWR mutation
  const { data: fulltextData, isMutating: fulltextLoading, trigger: triggerFulltext } = useSWRMutation(
    "/api/search/fulltext",
    postFetcher
  );

  // セマンティック検索用のSWR mutation
  const { data: semanticData, isMutating: semanticLoading, trigger: triggerSemantic } = useSWRMutation(
    "/api/search/semantic",
    postFetcher
  );

  const fulltextResults: Article[] = fulltextData?.results || [];
  const semanticResults: Article[] = semanticData?.results || [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 並列で両方のAPIを呼び出し
    triggerFulltext({ query });
    triggerSemantic({ query });
  };

  return (
    <div className="p-6 space-y-6 mx-auto max-w-xl">
      <h1 className="text-xl font-bold">ハイブリッド検索</h1>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          className="border px-2 py-1 w-80"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="検索ワードを入力"
        />
        <button className="bg-blue-500 text-white px-3 py-1 rounded">
          検索
        </button>
      </form>

      {/* 全文検索結果 */}
      <section>
        <h2 className="font-semibold my-4">📝全文検索結果</h2>
        {fulltextLoading && <p>🔍 検索中...</p>}
        <ul>
          {fulltextResults.map((r) => (
            <li key={r.id} className="border-b py-2">
              <strong>{r.title}</strong>
            </li>
          ))}
        </ul>
      </section>

      {/* セマンティック検索結果 */}
      {semanticLoading && <p>💡 意味的類似を解析中...</p>}
      {semanticResults.length > 0 && (
        <section>
          <h2 className="font-semibold my-4">💡セマンティック検索結果</h2>
          <ul>
            {semanticResults.map((r) => (
              <li key={r.id} className="border-b py-2">
                <strong>{r.title}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

**ポイント:**
- `useSWRMutation`で両方のAPIを並列呼び出し
- 全文検索は即座に結果表示
- セマンティック検索は遅れて結果が追加される

### 5. Embedding更新スクリプト

**`scripts/update-embeddings.ts`**

```typescript
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import * as path from 'path';

// .env.localを読み込み
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // embeddingの更新にはサービスロールキーが必要
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

    // OpenAI APIでembeddingを生成
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: doc.content ?? '',
    });

    const embedding = embeddingResponse.data[0].embedding;

    // Supabaseに保存
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
```

**実行方法:**

```bash
npm install dotenv
npx tsx scripts/update-embeddings.ts
```

---

## 試行錯誤と解決した問題

### 問題1: `japanese`設定エラー

**エラー:**
```
ERROR: text search configuration "japanese" does not exist
```

**原因:**
PostgreSQLの標準では`japanese`設定が存在しない

**解決:**
`to_tsvector('simple', ...)`と`plainto_tsquery('simple', ...)`に変更

---

### 問題2: セマンティック検索の結果が常に同じ

**症状:**
どんなクエリでも同じ結果（SE、エンジニアなど）が返ってくる

**原因:**
1. `articles`テーブルの`embedding`カラムがnullだった
2. Supabase関数が`documents`テーブルを参照していた（実際は`articles`）

**解決:**
1. `update-embeddings.ts`スクリプトを実行してembeddingを登録
2. `hybrid_search`関数のテーブル名を`articles`に修正

**確認クエリ:**
```sql
SELECT id, title,
       embedding IS NOT NULL as has_embedding,
       array_length(embedding::float[], 1) as dimension
FROM articles
LIMIT 5;
```

---

### 問題3: `hybrid_score`が常にnull

**原因:**
embeddingがnullの場合、ベクトル演算結果がnullになる

**解決:**
`coalesce(1 - (embedding <=> query_embedding), 0)`でnull安全に変更

```sql
(
  0.6 * ts_rank_cd(search_tsv, plainto_tsquery('simple', query_text))
  + 0.4 * coalesce(1 - (embedding <=> query_embedding), 0)
) as hybrid_score
```

---

### 問題4: Next.jsのfetchキャッシュ

**症状:**
同じクエリで検索すると、前回の結果がキャッシュされる

**原因:**
Next.jsのfetchはデフォルトでキャッシュする

**解決:**
`lib/fetchers.ts`に`cache: "no-store"`を追加

```typescript
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(arg),
  cache: "no-store", // キャッシュを無効化
});
```

---

### 問題5: テーブル名の不一致

**エラー:**
```
Could not find the table 'public.documents' in the schema cache
```

**原因:**
初期実装では`documents`テーブルを想定していたが、実際は`articles`だった

**解決:**
すべてのファイルで`documents`→`articles`に統一
- API Routes
- Supabase関数
- スクリプト

---

## 動作確認

### 1. 開発サーバー起動

```bash
npm run dev
```

### 2. テストデータ登録

Supabaseの**Table Editor**で、`articles`テーブルにデータを手動追加するか、SQLで一括挿入:

```sql
INSERT INTO articles (title, content) VALUES
  ('エンジニア', 'エンジニア'),
  ('SE', 'SE'),
  ('バックエンドエンジニア', 'バックエンドエンジニア'),
  ('技術者', '技術者');
```

### 3. Embedding更新

```bash
npx tsx scripts/update-embeddings.ts
```

### 4. ブラウザで確認

http://localhost:3000/search にアクセスして検索を実行

**期待される動作:**
- 「医者」で検索 → セマンティック検索で「技術者」「開発者」など意味的に類似したものが表示
- 「エンジニア」で検索 → 全文検索で完全一致、セマンティック検索でSE、技術者なども表示

---

## まとめ

### このプロジェクトで実現したこと

✅ **全文検索**: PostgreSQLのtsvector + GINインデックスで高速キーワード検索
✅ **セマンティック検索**: OpenAI Embedding + pgvectorで意味的類似検索
✅ **ハイブリッドスコアリング**: 両方の結果を重み付けして統合
✅ **並列フェッチ**: SWRで2つのAPIを独立して呼び出し、UX向上
✅ **Next.js App Router**: 最新のNext.js 16で実装

### 技術的ポイント

1. **Supabaseの拡張機能**: pgvectorで1536次元のベクトル検索をサポート
2. **トリガーとインデックス**: tsvectorを自動更新し、検索性能を最適化
3. **RPC関数**: ハイブリッドスコアリングをデータベース側で実行
4. **useSWRMutation**: キャッシュを活用しつつ並列リクエストを実現
5. **環境変数の分離**: ANON KEYとSERVICE ROLE KEYを適切に使い分け

### 今後の拡張案

- **結果のマージ表示**: 全文とセマンティックの結果を統合して1つのリストに表示
- **スコア表示**: hybrid_scoreを画面に表示してランキングの根拠を明示
- **フィルタリング**: 日付、カテゴリなどの条件を追加
- **ページネーション**: 大量の結果を扱う場合の対応
- **リアルタイム更新**: Supabaseのリアルタイム機能で新規記事を即座に反映

---

## 参考リンク

- [Supabase Vector Documentation](https://supabase.com/docs/guides/ai/vector-columns)
- [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings)
- [PostgreSQL Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [SWR Documentation](https://swr.vercel.app/)
- [Next.js App Router](https://nextjs.org/docs/app)
