import { previewId } from '@/lib/creation-origin';
import Teams from '@/components/teams';
export default async function Page({ params, searchParams }: { params: Promise<{ teamId: string }>; searchParams: Promise<{ preview?: string | string[]; resume?: string | string[] }> }) {
  const { teamId } = await params;
  const { preview, resume } = await searchParams;
  return <Teams key={`${teamId}:${preview ?? ""}:${resume ?? ""}`} id={teamId} initialPreview={previewId(preview)} resume={resume === "1"} />;
}
