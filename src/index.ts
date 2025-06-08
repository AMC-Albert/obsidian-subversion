// Main barrel exports for the plugin
export { default as ObsidianSvnPlugin } from './main';
export * from './settings';
export * from '@/core';
export * from '@/services';
export * from '@/views';
export * from '@/utils';

// Re-export types explicitly to avoid conflicts
export type * from '@/types';
