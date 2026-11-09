if (process.argv[2] === 'migrate') await import('./scripts/migrate.ts')
else await import('./main.ts')
