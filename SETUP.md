# Setup

The submissions inbox is **toughtechcapstone@gmail.com**. What follows wires it to
the site. About ten minutes, all of it in the browser.

Do every step while signed in as **toughtechcapstone@gmail.com**, not your Anderson
account. The script reads and archives everything in whichever inbox it is attached to.

## 1. Create the Apps Script project

1. Go to <https://script.google.com> and click **New project**.
2. Rename it *Tough Tech Weekly intake* (click "Untitled project" at the top).
3. Delete the few lines of starter code in the editor.
4. Open [`apps-script/Code.gs`](apps-script/Code.gs) in this repo, copy the whole
   file, and paste it in. Save (⌘S).

## 2. Run setup()

In the toolbar there is a function dropdown. Choose **setup** and click **Run**.

Google will ask for permission the first time. It shows an "unverified app" warning
because the script is yours and unpublished, which is expected: click **Advanced**,
then **Go to Tough Tech Weekly intake (unsafe)**, then **Allow**. It is asking for
Gmail and Sheets access because it reads the inbox and writes the spreadsheet.

When it finishes, the execution log at the bottom prints a link to a new spreadsheet
called *Tough Tech Weekly submissions*. It has two tabs, already set up:

- **inbox** — every submission, including the sender's email address
- **queue** — the same thing without the email column, which is what gets published

## 3. Run installTrigger()

Choose **installTrigger** from the same dropdown and click **Run**. The script now
checks the inbox every five minutes on its own.

## 4. Publish the queue tab

Open the spreadsheet from step 2, then:

**File ▸ Share ▸ Publish to web** → in the first dropdown pick the **queue** tab (not
"Entire document") → in the second pick **Comma-separated values (.csv)** → click
**Publish** → copy the URL it gives you.

That URL is unlisted but public, which is why the email column is not in it.

## 5. Paste the URL into config.json

Edit [`config.json`](config.json) and put the URL in `sheet_csv_url`:

```json
{
  "site": "https://toughtechcapstone.github.io/",
  "email": "toughtechcapstone@gmail.com",
  "form_url": "",
  "sheet_csv_url": "PASTE IT HERE",
  "fallback_email": "jane.wu@anderson.ucla.edu"
}
```

Commit and push. Pushing rebuilds the site, and after that it rebuilds on its own
every Tuesday and Friday at 8 AM Pacific.

## 6. Test it

Forward something to toughtechcapstone@gmail.com from your Anderson address, with a
sentence of your own above the forward. Within five minutes a row should appear in
the **inbox** tab. Then send one from a non-UCLA address and check that nothing
appears, which confirms the filter works.

To see it on the site without waiting for Friday: in the repo, **Actions ▸ Build
newsletter ▸ Run workflow**.

## Optional: the Google Form

Some people would rather tap a form than forward mail. Create one with three
questions: *Link* (short answer), *Why is this interesting?* (paragraph, optional),
and *Is this SoCal / corridor news?* (checkbox). In Settings, restrict it to users in
UCLA, and send responses to the same spreadsheet. Then put the form's URL in
`form_url` in config.json.

If you skip this, the site simply does not mention a form.

## Running it during the term

- **Publish early:** Actions ▸ Build newsletter ▸ Run workflow.
- **Take something down:** set that row's `status` to `held` in the **inbox** tab, or
  delete the row. It disappears on the next build.
- **Block a term for good:** add it to `data/blocklist.txt`.
- **Fix a bad title:** type one into the `title` column and the build stops fetching
  its own.
- **Check on the script:** script.google.com ▸ your project ▸ **Executions** shows
  every run and anything it logged.

## When a submission does not show up

Run **diagnose()** from the function dropdown and read the log. It lists recent mail
with a verdict for each message, and tells you whether the trigger is installed. The
three usual causes:

1. `installTrigger()` was never run, so nothing is polling.
2. The test was sent from a non-UCLA address. Mail from gmail.com, including from
   this account to itself, is dropped on purpose.
3. The message had no link in the body.

A message that was already looked at carries the `ttw-processed` label and gets
skipped. Run **reprocess()** to move recent mail back to the inbox and clear that
label, then **processInbox()** to try again.

## Keeping student addresses out of the published file

Sender addresses are stored in a separate spreadsheet, *Tough Tech Weekly senders
(PRIVATE, do not publish)*, which the script creates on its own. The submissions
file never receives them, so however that file gets shared, no student address
travels with it.

If you set this up before that change, run **runAllFixes()** once. It moves every
address already sitting in the submissions sheet into the private file, wipes that
column, strips signatures, phone numbers and salutations out of every existing note,
then re-reads the last 30 days of mail (spam included) to bring in anything that was
missed and repair any note that was cut off. Safe to run more than once.

Never publish the senders spreadsheet.

## Stopping Gmail filing submissions as spam

Forwarded newsletters from an unfamiliar sender are exactly what Gmail's spam filter
goes after, and a submission sitting in spam gets deleted after 30 days. The intake
now reads spam as well, and lifts anything real back out of it, but it is better to
stop it happening.

In Gmail, as the newsletter account: **Settings ▸ See all settings ▸ Filters and
Blocked Addresses ▸ Create a new filter**. In the *From* box put:

```
ucla.edu OR anderson.ucla.edu OR g.ucla.edu
```

Click **Create filter**, then tick **Never send it to Spam**, then **Create filter**
again.

## What to tell students

> Forward anything interesting in deep tech to **toughtechcapstone@gmail.com** from
> your UCLA address. Add a sentence above the forward if you want to say why it
> matters, and it runs with your first name on it. It publishes Friday. Nobody
> screens it.
