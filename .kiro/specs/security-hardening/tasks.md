# Implementation Plan

- [x] 1. Verify existing security layers
  - Run the existing `tests/security.test.ts` suite without any modification
  - Confirm all DB encryption, Web Basic Auth, and MCP bearer token tests pass
  - All existing security tests are green before any code changes are made
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 3.1, 3.2_

- [x] 2. Extract `startServer` helper from the web server entry point
  - Extract the `app.listen(port, host, cb)` call from `main()` into an exported `startServer(app, host?, port?)` function with default `host = '127.0.0.1'` and default `port = 3333`
  - Reattach or move the `EADDRINUSE` error handler so it remains active on the returned `http.Server`
  - `main()` delegates entirely to `startServer(createApp())`; no production behaviour changes (same bind address, same port, same error handling)
  - Running the server still binds on `127.0.0.1:3333` and the EADDRINUSE path still works
  - _Requirements: 4.1_

- [ ] 3. Add localhost-binding test to the security test suite
  - Import `startServer` and `createApp` in `tests/security.test.ts`
  - Call `startServer(createApp(), undefined, 0)` to bind on an ephemeral port using the function's default host
  - Assert `server.address().address === '127.0.0.1'`
  - Close the server in cleanup (afterEach or within the test) so the port is released
  - The new test passes, confirming the default bind address is `127.0.0.1` and that a future change to `main()` broadening the host would fail this test
  - _Requirements: 4.1_
  - _Depends: 2_
