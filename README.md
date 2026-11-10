# resend-broadcasts

A sandboxed plugin for [EmDash CMS](https://emdashcms.com). It emails an entry to a
[Resend](https://resend.com) segment when the entry publishes, but only after an editor has
reviewed and approved the exact email. Unofficial; not affiliated with Resend.

## Setup

1. Create a Resend API key (Full access, or one that can read segments and topics and send
   broadcasts). A sending-only key will be rejected with a clear message.
2. Open **Broadcast settings** in the admin and enter the key, a verified From address, optional
   Reply-To, a default segment/topic, and tick the collections that may send. Links, images and the
   footer's site name use the site name and URL from EmDash's general settings.
   Each enabled collection gets a card mapping its fields to Subject, Preview text (the grey snippet shown after the subject in an inbox) and Body. They are auto-detected and can be overridden; save each card separately.
   The **Email appearance** section has its own save button: an optional logo (a PNG or JPG; without one the header shows the site name), a base colour for backgrounds, text and borders (Tailwind Neutral, Stone, Zinc, Mauve, Olive, Mist or Taupe; default Zinc), an accent colour for links and the button (Tailwind Red through Slate; default Blue), the sender's postal address (shown in every email footer; many countries require it), a footer message that replaces the default "you subscribed" line, and a toggle for the "Read this on the web" link. Emails include dark-mode styles and an Outlook-safe button.
   Save the appearance, then use **Send preview email** below it to receive a sample post rendered with your saved settings.
3. Open an entry of an enabled collection: the **Send as broadcast** panel appears in the editor sidebar.

## Workflow

- Choose segment, optional topic, subject and preview text (leave either empty to use the default shown
  in grey) and press **Save subject and preview text**. They appear in the inbox list only; switch on
  **Show subject and preview text at the top of the email** (saves immediately) to also put them at
  the top of the body (the subject as a heading, the preview text beneath it). The full entry is
  always sent; at the first block that cannot be rendered in email (embeds, custom components) the
  email stops and shows a **Continue reading on the web** button.
- Step 1: **Send test email** (uses your saved choices) to see the real email in your inbox.
- Step 2, scheduled entry: **Schedule broadcast**. The email sends when the scheduler publishes the entry.
- Step 2, published entry: **Send broadcast now** (with a confirmation) sends in one step.
- **Broadcasts** overview lists approved, sent, failed and lapsed broadcasts.

### Safety rules

| Situation                                           | Result                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Entry published without an approval                 | Nothing is sent.                                                                                                          |
| Entry edited after approval                         | Approval `lapsed`; nothing is sent until re-approved.                                                                     |
| Unschedule, unpublish, delete                       | Approval becomes `inactive` (deleted entries lose their approval). Re-scheduling an unchanged entry revives it.           |
| Publish fires twice, or the button is clicked twice | One broadcast: the approval is claimed with compare-and-set first.                                                        |
| Resend returns an error                             | The broadcast is `failed`; nothing retries automatically. A manual **Retry** is offered.                                  |
| Ambiguous failure (5xx or network)                  | The plugin looks the broadcast up by its unique name before declaring failure, and warns to check Resend if still unsure. |
| Sent                                                | The stored snapshot is what was sent, never the live fields. An entry is never sent twice.                                |

Every email contains Resend's `{{{RESEND_UNSUBSCRIBE_URL}}}` placeholder, so the unsubscribe link
is generated per recipient.

### Resetting plugin data

The plugin keeps its own storage (sent history, approvals, saved choices, cached lists), separate
from your entries. Deleting an entry does not remove its sent record. If something goes wrong, an
admin can use **Reset plugin data** at the bottom of the Broadcasts settings page to start fresh.
Settings are kept. Because sent history is forgotten, entries that were already emailed could be
sent again if re-published.

## Limits

- Body rendering supports paragraphs, headings, lists (nested), quotes, links, images, rules and
  basic marks. Other blocks are left out and flagged as a warning before approval.
- Resend's API is limited to 2 requests/second; segments and topics are cached for 10 minutes.
- The panel is a Block Kit form, so it cannot render the HTML email; send a test email to see it.
- Only users with publish rights can use the panel; only admins can change settings.

## Develop

```sh
pnpm install
pnpm run validate
pnpm run typecheck
pnpm run test
pnpm run build
```

To test against a running EmDash site, run `pnpm run dev` in this
directory (rebuilds on save) and `pnpm add file:../path/to/this`
in the site. Then `import resendBroadcasts from "resend-broadcasts"` and pass
it into `emdash({ sandboxed: [resendBroadcasts] })`.

`pnpm run test` builds the plugin and runs its tests through Worker Loader using
EmDash's production sandbox wrapper and host bridge.

## Publish

```sh
pnpm run login -- alice.example.com
pnpm run publish          # builds and uploads artifacts to your PDS
```

To publish from GitHub Actions, run `pnpm run release:setup`. The command
creates one shared workflow at the Git repository root.

## Version bumps

Bump `version` in `package.json` when you ship a release. The
scaffold's `emdash-plugin.jsonc` deliberately omits `version` —
the build pipeline reads it from `package.json` so there's a single
source of truth. **Bump major** for breaking changes, **bump minor**
for new routes or hooks, **bump patch** for fixes.

You MUST bump version whenever you change `capabilities`, `allowedHosts`,
or `storage` in the manifest. Installed users have consented to the
old trust contract; a change without a version bump would let new
behaviour slip past consent.
