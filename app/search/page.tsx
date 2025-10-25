"use client";

import { useState } from "react";
import useSWRMutation from "swr/mutation";
import { postFetcher } from "@/lib/fetchers";

type Article = { id: string; title: string; content: string };

export default function SearchPage() {
  const [query, setQuery] = useState("");

  const { data: fulltextData, isMutating: fulltextLoading, trigger: triggerFulltext } = useSWRMutation(
    `/api/search/fulltext`,
    postFetcher
  );

  const { data: semanticData, isMutating: semanticLoading, trigger: triggerSemantic } = useSWRMutation(
    `/api/search/semantic`,
    postFetcher
  );

  const fulltextResults: Article[] = fulltextData?.results || [];
  const semanticResults: Article[] = semanticData?.results || [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    triggerFulltext({ query });
    triggerSemantic({ query });
  };

  return (
    <div className="p-6 space-y-6 mx-auto max-w-xl flex flex-col justify-center">
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
              {/* <p className="text-sm text-gray-600">{r.content}</p> */}
            </li>
          ))}
        </ul>
      </section>

      {/* セマンティック結果 */}
      {semanticLoading && <p>💡 意味的類似を解析中...</p>}
      {semanticResults.length > 0 && (
        <section>
          <h2 className="font-semibold my-4">💡セマンティック検索結果</h2>
          <ul>
            {semanticResults.map((r) => (
              <li key={r.id} className="border-b py-2">
                <strong>{r.title}</strong>
                {/* <p className="text-sm text-gray-600">{r.content}</p> */}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
