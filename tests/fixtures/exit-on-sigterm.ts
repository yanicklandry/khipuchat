// Test fixture: waits for SIGTERM, then exits with code 7 so the parent can see it was forwarded.
process.on('SIGTERM', () => process.exit(7))
process.stdout.write('ready\n')
setInterval(() => {}, 1000)
