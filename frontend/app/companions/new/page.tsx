import { originFromQuery } from '@/lib/creation-origin';
import CreateCompanion from '@/components/create-companion';

export default async function NewCompanionPage({ searchParams }: { searchParams: Promise<{ theme?: string | string[]; team?: string | string[] }> }) {
  const { theme, team } = await searchParams;
  return <CreateCompanion initialOrigin={originFromQuery(theme, team)} initialTheme={theme === undefined ? null : typeof theme === 'string' ? theme : 'invalid'} />;
}
