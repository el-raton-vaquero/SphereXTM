import PrismApp from '../../components/prism/PrismApp';

export default async function PrismPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value !== undefined) qs.set(k, value);
  }
  return <PrismApp initialQuery={qs.toString()} />;
}
