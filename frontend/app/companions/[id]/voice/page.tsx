import VoiceCompanion from '@/components/voice-companion';
import '../../../gatherings/shared-life.css';
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <VoiceCompanion id={Number(id)} />; }
