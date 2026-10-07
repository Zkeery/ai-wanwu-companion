import { previewId } from '@/lib/creation-origin';
import { notFound } from 'next/navigation';
import ThemeWall from '@/components/theme-wall';

export default async function ThemeWallPage({ params, searchParams }: {
  params: Promise<{ themeId: string }>; searchParams: Promise<{ work?: string | string[]; preview?: string | string[]; resume?: string | string[] }>;
}) {
  const { themeId } = await params;
  if (themeId !== 'fruit') notFound();
  const { work, preview, resume } = await searchParams;
  return <ThemeWall key={`${themeId}:${preview ?? ""}:${resume ?? ""}`} initialPreview={previewId(preview)} resume={resume === "1"} theme={themeId} initialWork={typeof work === 'string' ? work : null} />;
}
