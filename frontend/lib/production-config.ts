export function assertProductionConfig(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.NEXT_PUBLIC_AUTH_HEADER && !['Authorization', 'X-Companion-Authorization'].includes(env.NEXT_PUBLIC_AUTH_HEADER)) {
    throw new Error('Production configuration blocked: invalid authentication header.');
  }
  if (env.NEXT_PUBLIC_AUTH_MODE && !['sms', 'invite'].includes(env.NEXT_PUBLIC_AUTH_MODE)) {
    throw new Error('Production configuration blocked: invalid login mode.');
  }
  const preview = ['NEXT_PUBLIC_OFFLINE_PREVIEW', 'NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW']
    .some(key => { const value = env[key]?.trim().toLowerCase(); return value && !['false', '0'].includes(value); });
  if (env.NEXT_PUBLIC_DEV_SMS_CODE || preview) {
    throw new Error('Production configuration blocked: remove development login hints and offline preview flags.');
  }
  if (Object.entries(env).some(([key, value]) => key.startsWith('NEXT_PUBLIC_') && value && /SECRET|TOKEN|PASSWORD|(?:API|ACCESS|PRIVATE)_?KEY/.test(key))) {
    throw new Error('Production configuration blocked: public environment variables must not contain credentials.');
  }
}
