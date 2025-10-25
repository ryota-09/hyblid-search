export async function postFetcher(url: string, { arg }: { arg: unknown }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(arg),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("API error");
  return res.json();
}
