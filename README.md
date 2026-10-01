# SAP LeanIX to xMatters Service Sync

This job keeps xMatters Services and Service Dependencies aligned with selected SAP LeanIX Fact Sheets and relationships. LeanIX is the source of truth for the records managed by the sync.

## Use case

Use this sync when the service catalog in xMatters should reflect the application and interface landscape maintained in LeanIX. Each in-scope LeanIX Fact Sheet becomes an xMatters Service. Selected active LeanIX relations become xMatters Service Dependencies, allowing xMatters to represent which services rely on other services.

The current configuration includes every Fact Sheet whose type is `Application` or `Interface`. The `includeFactSheet` hook currently accepts all Fact Sheets of those types. Change these settings in the configuration block to fit a different LeanIX workspace or scope.

## What is synced

### LeanIX Fact Sheets → xMatters Services

For each included Fact Sheet, the script creates or updates an xMatters Service with:

| xMatters field | Source / behavior |
| --- | --- |
| `targetName` | LeanIX `displayName`, falling back to `name` and then ID. The name is sanitized and truncated to 250 characters. A configured prefix can be added. If it collides with an xMatters Group name, the configured suffix (` [Service]`) is appended. |
| `description` | LeanIX description plus a managed metadata block containing the Fact Sheet ID, type, original name, ITIL assignment group, and ITIL approval group. The total is limited to 2,000 characters; long source descriptions are trimmed. |
| `serviceType` | Mapped by Fact Sheet type: `Application` → `APPLICATION`; `Interface` → `TECHNICAL`. |
| `serviceTier` | Mapped by Fact Sheet type: `Application` → `GOLD`; `Interface` → `SILVER`. |
| `ownedBy` | Uses the LeanIX Application `itilAssignment` value when enabled and when it matches an existing xMatters Group. Otherwise it falls back to the configured owner mapping/default group. The current Application and Interface fallback owner is an empty string. Update as needed |

The managed metadata in the description lets later runs identify services created or managed from LeanIX Fact Sheets. xMatters fields outside the managed set are not used to determine whether a service needs an update.

### LeanIX relations → xMatters Service Dependencies

The current rules include these LeanIX relation types:

- `relConsumerApplicationToInterface`
- `relProviderApplicationToInterface`

For both rules, the `from` Fact Sheet is treated as the dependent service and the `to` Fact Sheet as the service it depends on. In the xMatters API payload, that means:

- `serviceId` = the depended-on service (LeanIX `to`)
- `dependentServiceId` = the service that depends on it (LeanIX `from`)

Only active relations of a configured type are synced, and both endpoint Fact Sheets must be in scope and resolve to xMatters Services. Unsupported relation types, missing endpoints, out-of-scope endpoints, and self-dependencies are skipped. Multiple LeanIX relations that resolve to the same service pair produce one xMatters dependency.

## Reconciliation and deletion behavior

- Existing xMatters Services are matched first by the LeanIX ID marker in their description or saved local state. Name matching is also enabled as a fallback.
- Changed managed fields are updated; missing services and dependencies are created.
- With stale deletion enabled, a managed Service is deleted if its LeanIX Fact Sheet disappears or falls out of scope. Dependencies involving that service are removed first.
- A Service Dependency is deleted when its corresponding LeanIX relationship is no longer present in the desired set and both endpoints are managed by this sync.
- Unmarked xMatters Services are not selected for stale Service deletion.
- Deletion limits guard each run (`25` Services and `200` Dependencies by default). A run fails rather than exceeding those limits.
- If LeanIX returns no desired Fact Sheets, stale Service deletion is refused unless `allowDeleteWhenNoLeanixResults` is explicitly enabled.

The local state file (`.leanix-xmatters-sync-state.json` by default) stores LeanIX-to-xMatters ID mappings and dependency mappings. Keep it available between runs, and protect it as operational data.

## Requirements

- Node.js 18 or newer (uses the built-in `fetch` API).
- A LeanIX API token with permission to read the configured Fact Sheets and their relations.
- xMatters credentials with permission to read, create, update, and delete Services and Service Dependencies.
- Network access from the runtime to the configured LeanIX and xMatters instances.

## Run

The configuration defaults to dry-run (`dryRun: true`). In dry-run mode, the script reads both systems and logs planned create, update, and delete actions without changing xMatters or saving state.

```sh
node sync-leanix-xmatters.mjs
```

To force a dry-run regardless of the configured default:

```sh
node sync-leanix-xmatters.mjs --dry-run
```

To apply changes:

```sh
node sync-leanix-xmatters.mjs --apply
```

Review the dry-run output before applying changes, especially planned deletions and service-name collisions. `--apply` disables dry-run for that execution; it does not bypass deletion limits or the empty-result guard.

## Operational notes

- Run as a scheduled job or controlled deployment task after validating the dry-run output.
- Store credentials in the runtime environment or an approved secrets manager.
- Persist the state file between executions, or ensure the description markers are retained for service identification.
- Review the configured relation types against the LeanIX workspace; relation type identifiers can differ between metamodels.
- The script retries selected transient network errors and HTTP responses, and logs a summary of created, updated, unchanged, skipped, and deleted records.
