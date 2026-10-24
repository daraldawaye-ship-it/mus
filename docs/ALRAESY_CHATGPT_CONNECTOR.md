# الرئيسي – Alraesy: ChatGPT connector on Render

## Scope and identity
This is a **new private plugin**, not an update to the previous «تجارة» App or the
legacy general-table-only plugin. Keep those installations unchanged.

The connector runs in the same deployed API as the existing website, at
`https://<confirmed-render-host>/mcp/alraesy`. Do **not** guess the hostname.
The MCP OAuth authorization server is the matching Render origin.

Authorization scopes:
- `alraesy.read`: discover API routes and read permitted records.
- `alraesy.read alraesy.write`: also execute authorized create/edit/delete/post
  operations.

Each user signs in to the Alraesy website and consents to a separate connection.
The owner retains existing owner privileges, company staff receive only their
current company/employee/role/page/action permissions. Legacy ChatGPT grants
cannot access the new connector. The REST backend is always the authority.

No direct SQL, cross-company access, automatic role escalation or disclosure
of password hashes, session tokens or OAuth bearer tokens. Password changes
happen at the existing protected `/profile` screen, not in chat arguments.

## MCP tools
- `alraesy_api_catalog`: live registered endpoint discovery, method/filter.
- `alraesy_api_read`: GET registered endpoint with optional query.
- `alraesy_api_write`: POST, PUT, PATCH, DELETE registered endpoint, JSON body.
- `alraesy_password_settings`: link to user password settings on the site.

The connector talks to `/api` through the loopback interface; the delegated
endpoint re-checks all current authorization, company isolation, page/action
gates, revision requirements, audit logging and idempotency rules.

## Private plugin manifest for ChatGPT
Create the plugin only after confirming the deployed Render service hostname and
successful `/api/health`, `/mcp/alraesy` and OAuth metadata responses.
Use private display name **الرئيسي – Alraesy**, description in Arabic,
`mcpServers.alraesy.type = streamable-http`, server
`https://<confirmed-render-host>/mcp/alraesy`, OAuth DCR,
`authorizationServerBase = https://<confirmed-render-host>`,
`resource = https://<confirmed-render-host>/mcp/alraesy`, and both scopes.

## Acceptance checklist before merging or deploying
1. `npm run check`, `npm run build`, focused MCP and OAuth tests all pass.
2. Legacy general-table plugin still reads and writes with previous explicit
   scopes and its approval/revocation flows still work.
3. Owner: read/write an authorized company record, including an audited change.
4. Ordinary employee: own-company permitted read and explicitly permitted write;
   an unauthorized page action and another company's record both return 403.
5. Read-only OAuth cannot write; revoked/expired token cannot read or write.
6. JSON API CSRF remains enforced for browser cookies; bearer bypass applies
   exclusively to scoped OAuth authentication.
7. Authentication/password/login routes cannot be called through the connector;
   password form remains reachable under `/profile`.
8. Re-check Render service deploy health, then link/test private plugin installation.
