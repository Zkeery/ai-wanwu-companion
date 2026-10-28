/** Maintenance controls stay available in local and test builds, and are hidden from visitors. */
export const operatorTools = process.env.NODE_ENV !== 'production';
