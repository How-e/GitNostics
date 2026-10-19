// The production entry defaults to secure production configuration.
process.env.NODE_ENV ??= 'development';
await import('./main');
export {};
