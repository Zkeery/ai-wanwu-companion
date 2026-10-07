import Companion from '@/components/companion';
import { Suspense } from 'react';
import { Loading } from '@/components/common';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<Loading />}><Companion key={id} id={/^\d+$/.test(id) ? Number(id) : 0} /></Suspense>;
}
