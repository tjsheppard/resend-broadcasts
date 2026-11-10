# Resend Broadcasts plugin: build specification

An EmDash plugin that lets an editor email a published or scheduled entry to subscribers through Resend Broadcasts, using a Ghost-style "publish, then send" workflow. This document is the complete brief: it records the decisions made, the behaviour required, and the facts still to verify before or during the build.

Related: [newsletter.md](./newsletter.md) describes the existing sign-up, confirm and unsubscribe flow, which this plugin sits alongside and does not change.

## 1. Goal

Writing and publishing an entry stays exactly as it is today. After an entry is published or scheduled, an editor can choose to also email it to subscribers: pick who it goes to, preview the email, approve it, and the plugin sends it through Resend, immediately for a published entry or at publish time for a scheduled one. Each entry is emailed at most once.

### Non-goals

- No "email only, don't publish to the website" mode. Use the Resend dashboard for that.
- No change to any collection's schema: no extra field, tag or category on entries.
- No blocking of publish or schedule. Publishing never depends on this plugin.
- No custom unsubscribe page. Broadcasts use Resend's hosted unsubscribe and preference page.
- No management of contacts, segments or topics from EmDash. The plugin only reads them.
- No use of Resend's template system for the entry body.

## 2. Decisions already made

| Topic                      | Decision                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the choice lives     | A sidebar panel on the entry editor, not a field on the entry                                                                                                                                                     |
| When the panel is usable   | Only when the entry is **published** or **scheduled**; for drafts it shows "Publish or schedule this entry first"                                                                                                 |
| Sending a published entry  | Immediately, on the editor's confirmation                                                                                                                                                                         |
| Sending a scheduled entry  | Approved in advance; sent automatically when the entry goes live                                                                                                                                                  |
| Review                     | Mandatory preview and explicit approve before any send; nothing is ever auto-sent unapproved                                                                                                                      |
| Edits after approval       | Approval lapses and the editor must re-approve (scheduled entries only matter here)                                                                                                                               |
| Unapproved scheduled entry | Nothing is sent; the overview flags it "scheduled, not approved"                                                                                                                                                  |
| Content types              | The plugin settings tick which content types (collections) show the panel, for example `posts` and `newsletters`. No other collection shows it                                                                    |
| Audience                   | Chosen **per entry** in the panel: one Resend **segment** (required) and one **topic** (optional). No topic means the whole segment, regardless of topic opt-ins; contacts who have unsubscribed never receive it |
| Topic source               | Loaded from Resend via the API key; not typed by hand and not mirrored from EmDash tags or categories                                                                                                             |
| Body content               | Excerpt with a link back, or the full entry; selectable per send (section 6)                                                                                                                                      |
| Duplicates                 | Plugin storage records every send; an entry marked sent is never sent again                                                                                                                                       |
| Visibility                 | An overview page lists sent entries, approved scheduled entries, and scheduled entries not yet approved                                                                                                           |

## 3. Background facts the design depends on

- A Resend broadcast has one segment and at most one topic label. It cannot target several topics.
- Everyone in the segment gets the broadcast except contacts who opted out of its topic.
- A broadcast sent **without** a topic ignores topic preferences, and a recipient who unsubscribes from it is unsubscribed from all email. Leaving the topic empty carries this caveat, so the panel must state it next to the topic control.
- The existing site flow subscribes people to `RESEND_TOPIC_IDS` and its website unsubscribe sets the contact-wide `unsubscribed` status. Broadcasts should be compatible with that: contacts who are globally unsubscribed receive nothing.
- The plugin works with any collection the editor enables, so field names differ between collections. `posts` uses `content` (Portable Text), `title`, `subtitle` and `featured_image`; the `newsletters` collection's fields must be inspected when building. A collection may also be non-routable (no public page), in which case there is no entry URL to link to (see section 9). A sample of 50 entries in `posts` contained only these Portable Text elements: normal, blockquote and H1 to H5 blocks; bullet and numbered lists; `strong`, `em` and link marks; `image` blocks; `break` blocks. There are no custom blocks, tables, embeds or code.
- Entries in `posts` are served at `/blog/{slug}`. The site origin is `https://www.unltd.org.uk` in production; previews are on `*.unltd.workers.dev`. Use the configured site URL, never a preview URL, in production sends.

## 4. Plugin shape

- Format: sandboxed plugin (`src/plugin.ts` default-exporting a `SandboxedPlugin`, manifest in `emdash-plugin.jsonc`), following the `creating-plugins` skill in `.agents/skills/creating-plugins/`. Read that skill and its references before writing code.
- Name and slug: `resend-broadcasts`, displayed as "Resend Broadcasts" (adjust if the registry requires). Describe it as unofficial, for example "Send EmDash content as Resend broadcasts".
- Only Web APIs; no Node built-ins.

### Capabilities (request nothing beyond these)

| Capability                                                | Why                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `content:read`                                            | Read the entry, its status and schedule, and resolve its public URL                                            |
| `network:request` with `allowedHosts: ["api.resend.com"]` | Resend API calls                                                                                               |
| `schema:read`                                             | List collections for the settings tick-list and detect each collection's title, body, excerpt and image fields |
| `media:read` (only if needed)                             | Public URLs for images; see section 9                                                                          |

Do not request `hooks.content-policy:register`, content write or publish, or unrestricted network access.

### Hooks used

- `content:afterPublish`: if the entry has a valid approval and is unsent, send it (this covers both manual publish and scheduler-driven publish).
- `content:afterSchedule` and `content:afterUnschedule`: keep plugin records in step (a record for an unscheduled, unpublished entry becomes inactive).
- `content:afterSave`: if the entry has an approval and the email-relevant content changed since approval, mark the approval lapsed (also checked again at send time, section 7).
- `content:afterDelete` and `content:afterUnpublish`: deactivate pending records.

### Admin surfaces

- **Settings page** (Block Kit page): Resend API key, enabled content types, from address, reply-to, URL, body default.
- **Editor panel** on the enabled collections: the per-entry "Send as broadcast" panel. Editor panel scoping is declared in `emdash-plugin.jsonc`, so confirm during scaffolding whether `collections` can be omitted (all collections) or must list them. If it cannot be driven by settings, declare the panel broadly and have the panel route return no content (or a one-line "not enabled for this content type") for collections that are not ticked.
- **Editor actions** (with confirm dialogs): "Approve email" and "Send broadcast".
- **Overview page** (Block Kit page): sent and pending lists.

All plugin routes must be private (authenticated, with the declared permission). Block Kit shapes are in `references/block-kit.md`.

## 5. Settings

| Setting                      | Type                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resend API key               | secret (encrypted via `ctx.settings`, needs `EMDASH_ENCRYPTION_KEY`) | Must be a Full access key (a sending-only key fails with `restricted_api_key`). Write-only in the UI                                                                                                                                                                                                                                                                                                                                                                      |
| Content types                | multi-choice                                                         | Collections from `ctx.schema.listCollections()`; tick each one that should show the panel (for example `posts` and `newsletters`)                                                                                                                                                                                                                                                                                                                                         |
| Per-collection field mapping | auto-detected, editable                                              | For each ticked collection: title field, subtitle field, body field (Portable Text), optional featured image field. Auto-detect by field type and common slugs (`title`, `subtitle`, `content`, `featured_image`). None is required to enable a collection: the editor can type a subject and preview by hand, and approval validates what is actually needed (see section 6). Subject and preview are never entry fields and nothing is added to the collection's schema |
| Default segment              | choice, optional                                                     | Loaded from Resend (`GET /segments`); only pre-selects the segment in the panel. The editor still chooses per entry and the segment is required to send                                                                                                                                                                                                                                                                                                                   |
| Default topic                | choice, optional                                                     | Loaded from Resend (`GET /topics`); only pre-selects the topic in the panel                                                                                                                                                                                                                                                                                                                                                                                               |
| From address                 | string                                                               | Default `UnLtd <newsletter@unltd.org.uk>`, matching the existing `NEWSLETTER_FROM` default; must be a verified Resend sender                                                                                                                                                                                                                                                                                                                                              |
| Reply-to                     | string, optional                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Site base URL                | string                                                               | Used for absolute entry and image URLs; default `https://www.unltd.org.uk`                                                                                                                                                                                                                                                                                                                                                                                                |
| Default body mode            | choice                                                               | `excerpt` (default) or `full`                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Because the segment and topic options come from a live API call, the settings are a custom Block Kit page rather than the static `admin.settingsSchema` form. The page needs a "Reload from Resend" control, clear errors for a bad or restricted key, and a graceful empty state before a key exists. Never log or echo the key.

Page through Resend list endpoints (`has_more`/`after`) rather than assuming one page. Respect Resend's rate limit (default 2 requests per second) with the same single retry on `429` used in `src/lib/newsletter/resend.ts`.

## 6. Editor panel

Shown only on entries of the collections ticked in settings. Each entry has its own independent state. States:

1. **Draft or unpublished:** read-only message, "Publish or schedule this entry to send it as a broadcast."
2. **Not configured:** link to the settings page when no key or segment is set.
3. **Published, not sent:** controls below, **Send broadcast** enabled once approved.
4. **Scheduled, not approved:** controls below, with the scheduled publish time shown and a warning "Will not be emailed unless approved before it publishes".
5. **Scheduled, approved:** shows what was approved (audience, subject, body mode, approved time) and the scheduled time; offers **Change** (which clears approval) and **Revoke approval**.
6. **Sent:** read-only summary: audience, subject, time, Resend broadcast ID, who approved it. No send control. Explain that an entry is only emailed once.
7. **Failed:** shows the error and a **Retry**.
8. **Approval lapsed:** shows that the entry changed after approval, and requires re-approval.

Controls:

- **Segment (required):** a dropdown of the segments loaded from Resend, pre-selected from the default segment if one is set. Approval and sending are disabled until a segment is chosen.
- **Topic (optional):** a dropdown of the topics loaded from Resend, with an empty "No topic (whole segment)" option. When empty, show the caveat: "This goes to everyone in the segment, regardless of topic preferences. People who unsubscribe from it will be unsubscribed from all email." Contacts who are unsubscribed never receive it either way.
- **Subject (required to approve):** a panel input, not an entry field. It inherits the entry's mapped title field, like a slug inherits a slugified title: it follows the title until the editor edits it, after which the typed value is kept. Store only the override; the default is read from the saved entry. If the collection has no title, or it is empty, the editor must type one.
- **Preview text (optional):** a panel input, not an entry field. It inherits the mapped subtitle field in the same way and can be overwritten. If there is no subtitle, it is empty by default (and the converter may suggest the first sentence of the body).
- **Body mode:** `Excerpt and link` or `Full entry`. If the entry has no public URL (non-routable collection or no published page), only `Full entry` is offered.
- **Preview:** the rendered email inside the panel, with a plain-text fallback available. Provide **Send test email** to the editor's own address if feasible (via `POST /emails`, so no contact or broadcast is created). This is optional for the first version.
- **Approve email** (editor action with confirm dialog): stores the approval snapshot and, for an entry that is already published, becomes **Send broadcast now** with a confirm dialog naming the audience.

If the entry has no excerpt and `Excerpt and link` is chosen, use the first paragraph of the body, truncated at a sentence boundary. Approval validation: a segment, a non-empty subject, and either a body to render or (in excerpt mode) a public URL. A collection with no body field can still be sent as a subject, preview text and link.

## 7. Behaviour and state machine

Storage (plugin storage collection, keyed by collection slug plus entry ID, with an index on `status`):

| Field                              | Meaning                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `entryId`, `collection`, `slug`    | Identity at approval time                                                                               |
| `status`                           | `approved`, `sending`, `sent`, `failed`, `lapsed`, `inactive`                                           |
| `audience`                         | `{ segmentId, segmentName, topicId?, topicName? }`; no topic means the whole segment                    |
| `subject`, `preheader`, `bodyMode` | As approved                                                                                             |
| `html`, `text`                     | The approved rendering (snapshot)                                                                       |
| `contentHash`                      | Hash of the email-relevant fields at approval (title, subtitle, excerpt, content, featured image, slug) |
| `approvedBy`, `approvedAt`         | Audit                                                                                                   |
| `sendAfter`                        | The scheduled publish time, if any                                                                      |
| `broadcastId`, `sentAt`, `error`   | Outcome                                                                                                 |

Rules:

1. **Approve:** only if the entry is published or scheduled. Writes `approved` with a rendering snapshot and hash.
2. **Lapse:** if the entry's email-relevant fields differ from `contentHash` before sending, set `lapsed`. Check this both on save and again immediately before sending, because `afterSave` may not run before a scheduled publish.
3. **Send trigger:** on `content:afterPublish`, if the broadcast record is `approved` and unsent, send. A published entry sends on the editor's confirmation instead.
4. **Atomic claim:** before calling Resend, move `approved` to `sending` using a compare-and-set (`ctx.storage` revision or predicate-guarded update). Only the caller that wins the claim sends. This prevents a double send from a retry, a re-fired hook, or two editors clicking at once.
5. **Send:** `POST /broadcasts` with `segment_id`, the topic if one was chosen, `from`, `reply_to`, `subject`, `html`, `text`, `name` (entry title and date, for the Resend dashboard), and `send: true`. Store the returned broadcast ID and mark `sent`.
6. **Idempotency:** if the Resend call fails or times out after the claim, do not blindly retry: first look up whether a broadcast with that `name` exists for the recorded attempt, and mark `failed` with the error otherwise. Never mark `sent` without a Resend response ID.
7. **Never resend:** `sent` is terminal. Unpublishing and republishing, rescheduling, or re-approving must not send again. A deliberate "send again" is out of scope; it can be done in Resend.
8. **Republish after unpublish before sending:** an `approved` broadcast record with a matching hash may still send on the next publish; a `lapsed` one may not.
9. **Delete and unpublish:** set non-terminal records `inactive` so they cannot fire; keep `sent` records for the audit trail.
10. **Segment or topic gone:** if Resend rejects the send because the segment or topic no longer exists, mark `failed` with a clear message; do not fall back to another audience.
11. **Locales:** treat each locale's entry as separate; one broadcast record per entry ID.

## 8. Overview page

An admin page in the plugin's nav listing, newest first:

- **Needs attention:** scheduled and not approved (with the publish time), lapsed approvals, failed sends.
- **Scheduled to send:** approved, waiting for publish (with the time and audience).
- **Sent:** title, audience, time sent, Resend broadcast ID with a link to the broadcast in Resend, approved-by.

Each row links to the entry. Failed rows have **Retry**. Paginate with cursors. Empty states for each section.

## 9. Rendering the email

Convert the entry's Portable Text to email-safe HTML and a plain-text alternative inside the plugin (the host does not provide an HTML renderer to sandboxed code; `portableTextToMarkdown()` from `emdash/client` is available but the output is Markdown, not email HTML, so write a small direct converter).

Supported elements, matching the content actually in use:

| Portable Text               | Email output                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `normal` block              | `<p>` with inline styles                                                                                                                   |
| `h1` to `h5`                | `<h2>`/`<h3>`-scale headings with inline styles (do not emit more than one visual H1; the subject and entry title are the primary heading) |
| `blockquote`                | Styled `<blockquote>` (left rule, muted text)                                                                                              |
| `bullet` and `number` lists | `<ul>`/`<ol>`/`<li>`, handling nesting by `level`                                                                                          |
| `strong`, `em`              | `<strong>`, `<em>`                                                                                                                         |
| `link` mark                 | `<a href>` with absolute URLs, resolved against the site base URL if relative                                                              |
| `image`                     | `<img>` with absolute `src`, `alt`, `max-width:100%`, plus width and height attributes if known                                            |
| `break`                     | `<hr>`                                                                                                                                     |
| Anything else               | Skipped, with a one-line note in the preview ("Some content isn't shown in the email. View on the website.") rather than throwing          |

Layout: table-based, inline-styled, single column, max width about 560 to 600 px, using the brand colours and structure already in `src/lib/newsletter/emails.ts` (`BRAND = "#7c3aed"`, the `layout` and `button` helpers) so the broadcast matches the confirmation and welcome emails. Structure: optional hidden preheader; featured image; title; subtitle; body (excerpt plus a "Read the full entry" button, or the full converted content); footer containing `{{{RESEND_UNSUBSCRIBE_URL}}}`.

Rules:

- The unsubscribe placeholder `{{{RESEND_UNSUBSCRIBE_URL}}}` must be in every broadcast footer; refuse to approve if the rendered HTML lacks it.
- Escape all text content and attribute values; only allow `http`, `https` and `mailto` link schemes.
- Provide the `text` alternative explicitly, not relying on Resend's auto-generation, so links and structure are predictable.
- Send `List-Unsubscribe` handling to Resend; do not add custom headers for it.
- Image URLs must be publicly reachable without authentication. Verify how EmDash media references resolve (via `media:read` and public URL helpers). If a stored image only has an authenticated or relative URL, resolve it to the public media URL under the site base URL, and fail the approval with a clear message if it cannot be made public.
- Keep total HTML comfortably under Gmail's clipping threshold (about 100 KB); warn in the preview if exceeded, especially for `full` mode.

## 10. Resend API usage

All calls go to `https://api.resend.com` with `Authorization: Bearer <key>` and JSON bodies, using `ctx.http.fetch()`.

| Purpose                   | Call                                 |
| ------------------------- | ------------------------------------ |
| List segments             | `GET /segments`                      |
| List topics               | `GET /topics`                        |
| Create and send broadcast | `POST /broadcasts` with `send: true` |
| Test email (optional)     | `POST /emails`                       |

Verify during the build, with a throwaway segment and test contacts, and correct this spec if reality differs:

1. The exact request field names (`segment_id`, topic field name, `reply_to`, `name`, `send`) and that a single topic ID is the supported way to label a broadcast.
2. Whether `GET /topics` exposes default subscription and visibility, to show in settings.
3. That a broadcast with `send: true` created and sent in one call returns an ID usable as the dedup record.
4. That `{{{RESEND_UNSUBSCRIBE_URL}}}` renders correctly in API-created broadcasts.
5. That the key requirement (Full access) is correct for listing segments and topics, and what error a restricted key gives.
6. How sending behaves to a contact who has opted out of the chosen topic, and to a globally unsubscribed contact (neither should receive it).

## 11. Security and privacy

- API key stored only as an encrypted plugin setting; never in the repo, logs or responses.
- All plugin routes private and permission-checked; the Send and Approve actions require an editor role (use the host's route permission, and require CSRF as the platform does for non-public routes).
- No public routes.
- The plugin never reads subscriber email addresses; Resend does the audience resolution. Do not request `users:read` or fetch the contact list.
- Log send outcomes (entry ID, broadcast ID, audience name, status) but not email content bodies or any recipient data.
- Escape and URL-validate all content placed into the email (section 9).

## 12. Packaging and installation (to decide at the start of the build)

Sandboxed plugins are normally distributed through the EmDash registry (`emdash-plugin publish`, which needs a publisher identity, a public GitHub `repo`, a licence and a security contact in the manifest). This repo registers sandboxed plugins through the `sandboxRunner` and installs them from the registry, and native plugins in the `plugins: []` array of `astro.config.mjs`.

Decide before coding which route to take, and note the consequence:

1. **Sandboxed and published to the registry** (the default recommendation): least privilege, matches the platform's direction, but requires registry publication and approval before the site can load it.
2. **Native plugin in this repo**: simplest to iterate on and deploy with the site, but runs with the site's full authority and loses the capability sandbox.

Whichever is chosen, keep the rendering, state machine and Resend client in plain TypeScript modules with no Node-only dependencies so they can move between formats. Put the plugin in its own directory (for example `plugins/resend-broadcasts/`) rather than mixing it into `src/`.

## 13. Build order

1. Scaffold the plugin, manifest, capabilities and a no-op `afterPublish` hook; get it loading in the dev site.
2. Settings page: encrypted API key, load and show segments and topics, save choices, error states.
3. Resend client module (list, create and send broadcast, rate-limit retry, paging) with unit tests against `host.http.respond()`.
4. Portable Text to email HTML and text converter, with fixtures drawn from real entries (including images, nested lists, links, quotes).
5. Storage model and state machine (approve, lapse, claim, send, fail, inactive), tested with `createPluginRuntimeTestHost()` including restart, stale hash and double-fire cases.
6. Editor panel and actions (states in section 6).
7. Hooks wired to the state machine, including scheduled publish.
8. Overview page.
9. End-to-end check on a preview Worker with a test segment and test contacts: published send, scheduled send, unapproved scheduled (nothing sent), edit after approval (lapses), republish (no second send), failure and retry.
10. Update `docs/newsletter.md` with the plugin's role, key requirements and operating notes.

## 14. Acceptance criteria

- A draft entry shows no send controls.
- A published entry can be previewed, approved and sent once; a second attempt is impossible from the UI and rejected by the server.
- A scheduled entry that was approved sends exactly once when it goes live, and one that was not approved sends nothing and shows under "Needs attention".
- Editing an approved entry before it sends lapses the approval and prevents sending the stale snapshot.
- The panel appears only on collections ticked in settings, and works on each (for example both `posts` and `newsletters`) with correct field mapping.
- A segment is required before approval or sending; the topic is optional.
- Choosing a topic excludes contacts who opted out of that topic; leaving it empty sends to the whole segment, with the caveat visible.
- Contacts marked unsubscribed (including via the website flow) receive nothing.
- Every sent email contains a working Resend unsubscribe link and renders correctly in Gmail, Apple Mail and Outlook for text, headings, lists, quotes, links and images.
- A bad, missing or restricted API key produces a clear message and never a silent failure or partial send.
- Two simultaneous send attempts result in one broadcast.
- Publishing, scheduling and unpublishing entries work exactly as before when the plugin is disabled or unconfigured.
- Typecheck and the plugin test suite pass.

## 15. Open questions

- Packaging route (section 12).
- Whether editor panel collection scoping can be driven by settings (section 4).
- The field layout of the `newsletters` collection (to confirm the auto-detected mapping and whether it has a public URL).
- Whether the optional "Send test email" is in the first version.
- Whether the full-entry body mode should be limited to a maximum size, or just warn (section 9).
