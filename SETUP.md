# Setup — one time, about 20 minutes

Do these in order. Steps 1–4 are yours (they need your Google login); step 5 is a
two-line edit anyone can make.

## 1. Create the submissions inbox

Make a Gmail account for the newsletter, e.g. `toughtechweekly@gmail.com`.
Use a fresh account rather than your Anderson address — the script reads and
archives everything in the inbox, and you do not want that pointed at your own mail.

## 2. Create the sheet

New Google Sheet, name it *Tough Tech Weekly submissions*. Make **two tabs**:

**Tab `inbox`** — row 1 headers, exactly:

```
timestamp | name | url | title | note | tag | status | email
```

**Tab `queue`** — cell A1 only:

```
=QUERY(inbox!A:H, "select A,B,C,D,E,F,G", 1)
```

This mirrors `inbox` without column H, so student email addresses never reach the
public CSV.

Then **File ▸ Share ▸ Publish to web** → select the **`queue`** tab → **CSV** →
Publish. Copy the URL it gives you.

Grab the spreadsheet ID from the address bar too — it is the long string between
`/d/` and `/edit`.

## 3. Wire up the Gmail intake

Signed in as the *newsletter* Gmail account:

1. Go to <https://script.google.com> → **New project**, name it *Tough Tech Weekly intake*.
2. Delete the starter code, paste in all of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Set `SHEET_ID` at the top to the ID from step 2.
4. Run `processInbox` once from the editor. Google will ask you to authorize Gmail
   and Sheets access — approve it. (You will see an "unverified app" warning because
   the script is yours and unpublished; **Advanced ▸ Go to project** is the way through.)
5. Run `installTrigger` once. It now polls every five minutes.

Test it: forward something from your Anderson address, wait five minutes, confirm a
row appears in `inbox`. Then send one from a non-UCLA address and confirm nothing
appears.

## 4. Optional: the Google Form

New form, three questions — *Link* (short answer), *Why is this interesting?*
(paragraph, optional), *Is this SoCal / corridor news?* (checkbox).
Under Settings, **restrict to users in UCLA**, and set responses to go to the same
spreadsheet. Rename the response tab's columns to match the `inbox` headers, or add
a `=QUERY` in `inbox` pulling from it — either works, since the build only ever reads
`queue`.

If you skip the form, the site simply does not mention it.

## 5. Point the site at everything

Edit [`config.json`](config.json):

```json
{
  "site": "https://toughtechcapstone.github.io/",
  "email": "toughtechweekly@gmail.com",
  "form_url": "",
  "sheet_csv_url": "PASTE THE PUBLISHED CSV URL FROM STEP 2"
}
```

Commit and push. The GitHub Action rebuilds on that push, and then automatically
every Tuesday and Friday at 8 AM Pacific.

## Running it during the term

- **Publish early:** Actions ▸ *Build newsletter* ▸ Run workflow.
- **Take something down:** set that row's `status` to `held` in the `inbox` tab, or
  delete the row. It disappears on the next build.
- **Hold a term permanently:** add it to `data/blocklist.txt`.
- **Fix a title:** fill in the `title` column and the build stops fetching its own.

## What to tell students

> Forward anything interesting in deep tech to **toughtechweekly@gmail.com** from
> your UCLA address. Type a sentence or two above the forward if you want to say why
> it matters — that runs with your name on it. It publishes Friday. Nobody screens it.
